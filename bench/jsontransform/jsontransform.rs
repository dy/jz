// jsontransform.rs – an API gateway's JSON round trip: parse a page of order
// records from text, reshape it (sum each order's line items, apply its
// discount, round to cents, keep orders worth at least 20, flatten the
// customer, count tags), and stringify the response, ported from
// jsontransform.js.
//
// Rust has no JSON in its standard library and the ports take no crates, so
// both directions are written here. The parser is a recursive descent into a
// generic Value, as JSON.parse builds generic objects from text of unknown
// shape: serde_json's Value with insertion order kept (an object a Vec of
// key/value pairs), strings decoded (\uXXXX escapes and surrogate pairs
// included; a lone surrogate, which a String cannot hold, is rejected), numbers
// checked against JSON's grammar and read with str::parse::<f64>. The transform walks it by key through Index, as
// serde_json's Value does (a linear scan of an object's members, a missing
// member reading as Null); kept orders borrow from the tree, as the JS's kept
// objects share its strings and tag arrays. The run drops the tree at its end.
// The writer is stringify.rs's in compact form: a String, QuoteJSONString's
// escapes, Number::toString's shortest digits from `{:e}` (an exact tie
// between two taken to the even one, as ECMAScript recommends).
//
// The document is generated once from XorShift32 exactly as the JS generates
// it and written by the same writer, outside the timed region. The timed region
// is the transform: parse, reshape and write, dropping the previous response.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over the last run's
// response as the JS folds it, outside the timed region: its UTF-16 length,
// then its UTF-16 code units (encode_utf16).
use std::fmt::Write;
use std::ops::Index;
use std::time::Instant;

const N: usize = 1024; // orders in the document
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

const NAMES: [&str; 10] = ["Ada Lovelace", "José Martí", "Zoë Kravitz", "Søren Kierkegaard", "李小龙",
    "Björk Guðmundsdóttir", "Chloé \"Coco\" Dupont", "Mikhail Bulgakov", "Grace Hopper", "Alan Turing"];
const PRODUCTS: [&str; 12] = ["Desk lamp", "Cable 2m\\5m", "Mug \"Hello\"", "Notebook, A5", "Tea – Darjeeling",
    "Café crème", "Gift card 🎁", "Line1\nLine2", "Tab\tSeparated", "Ångström ruler", "Pens (12)", "Ruler 30cm"];
const TAGS: [&str; 6] = ["bulk", "express", "fragile", "gift", "priority", "return"];
const DISCOUNTS: [f64; 8] = [0.0, 0.05, 0.1, 0.125, 0.15, 0.2, 0.25, 0.3];

struct XorShift32(u32);

impl XorShift32 {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0
    }
}

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

fn median_us(samples: &mut [f64]) -> u64 {
    for i in 1..samples.len() {
        let v = samples[i];
        let mut j = i;
        while j > 0 && samples[j - 1] > v {
            samples[j] = samples[j - 1];
            j -= 1;
        }
        samples[j] = v;
    }
    (samples[(samples.len() - 1) >> 1] * 1000.0) as u64
}

// ── Value ───────────────────────────────────────────────────────────────────
enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    Obj(Vec<(String, Value)>), // members in insertion order
}

static NULL: Value = Value::Null;

impl Value {
    fn as_array(&self) -> &[Value] {
        match self {
            Value::Arr(a) => a,
            _ => &[],
        }
    }

    fn as_f64(&self) -> f64 {
        match self {
            Value::Num(x) => *x,
            _ => f64::NAN,
        }
    }

    fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }
}

impl Index<&str> for Value {
    type Output = Value;
    fn index(&self, key: &str) -> &Value {
        match self {
            Value::Obj(m) => m.iter().find(|(k, _)| k == key).map_or(&NULL, |(_, v)| v),
            _ => &NULL,
        }
    }
}

impl Index<usize> for Value {
    type Output = Value;
    fn index(&self, i: usize) -> &Value {
        self.as_array().get(i).unwrap_or(&NULL)
    }
}

// ── Parser ──────────────────────────────────────────────────────────────────
struct Parser<'a> {
    src: &'a str,
    i: usize, // the next unread byte
}

type Parsed<T> = Result<T, String>;

impl Parser<'_> {
    fn err<T>(&self) -> Parsed<T> {
        Err(format!("invalid JSON at byte {}", self.i))
    }

    fn peek(&self) -> u8 {
        self.src.as_bytes().get(self.i).copied().unwrap_or(0) // 0 at the end
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn value(&mut self) -> Parsed<Value> {
        self.skip_ws();
        match self.peek() {
            b'{' => self.object(),
            b'[' => self.array(),
            b'"' => self.string().map(Value::Str),
            b't' => self.literal("true", Value::Bool(true)),
            b'f' => self.literal("false", Value::Bool(false)),
            b'n' => self.literal("null", Value::Null),
            _ => self.number(),
        }
    }

    fn literal(&mut self, word: &str, v: Value) -> Parsed<Value> {
        if !self.src.as_bytes()[self.i..].starts_with(word.as_bytes()) {
            return self.err();
        }
        self.i += word.len();
        Ok(v)
    }

    fn digits(&mut self) {
        while self.peek().is_ascii_digit() {
            self.i += 1;
        }
    }

    // -?(0|[1-9][0-9]*)(.[0-9]+)?([eE][+-]?[0-9]+)?, then str::parse reads that token
    fn number(&mut self) -> Parsed<Value> {
        let start = self.i;
        if self.peek() == b'-' {
            self.i += 1;
        }
        match self.peek() {
            b'0' => self.i += 1,
            b'1'..=b'9' => self.digits(),
            _ => return self.err(),
        }
        if self.peek() == b'.' {
            self.i += 1;
            if !self.peek().is_ascii_digit() {
                return self.err();
            }
            self.digits();
        }
        if matches!(self.peek(), b'e' | b'E') {
            self.i += 1;
            if matches!(self.peek(), b'+' | b'-') {
                self.i += 1;
            }
            if !self.peek().is_ascii_digit() {
                return self.err();
            }
            self.digits();
        }
        match self.src[start..self.i].parse() {
            Ok(x) => Ok(Value::Num(x)),
            Err(_) => self.err(),
        }
    }

    fn hex4(&mut self) -> Parsed<u32> {
        let mut x = 0;
        for _ in 0..4 {
            match (self.peek() as char).to_digit(16) {
                Some(d) => x = x << 4 | d,
                None => return self.err(),
            }
            self.i += 1;
        }
        Ok(x)
    }

    // \uXXXX, or a surrogate pair of them; a String holds no lone surrogate
    fn escape_u(&mut self) -> Parsed<char> {
        let hi = self.hex4()?;
        let mut cp = hi;
        if (0xd800..0xdc00).contains(&hi) {
            if !self.src.as_bytes()[self.i..].starts_with(b"\\u") {
                return self.err();
            }
            self.i += 2;
            let lo = self.hex4()?;
            if !(0xdc00..0xe000).contains(&lo) {
                return self.err();
            }
            cp = 0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00);
        }
        match char::from_u32(cp) {
            Some(c) => Ok(c),
            None => self.err(),
        }
    }

    // runs between escapes are copied as slices of the source, which split it only at ASCII bytes
    fn string(&mut self) -> Parsed<String> {
        self.i += 1; // "
        let mut s = String::new();
        let mut start = self.i;
        loop {
            match self.peek() {
                b'"' => {
                    s.push_str(&self.src[start..self.i]);
                    self.i += 1;
                    return Ok(s);
                }
                b'\\' => {
                    s.push_str(&self.src[start..self.i]);
                    self.i += 1;
                    let c = self.peek();
                    self.i += 1;
                    match c {
                        b'"' => s.push('"'),
                        b'\\' => s.push('\\'),
                        b'/' => s.push('/'),
                        b'b' => s.push('\u{8}'),
                        b'f' => s.push('\u{c}'),
                        b'n' => s.push('\n'),
                        b'r' => s.push('\r'),
                        b't' => s.push('\t'),
                        b'u' => s.push(self.escape_u()?),
                        _ => return self.err(),
                    }
                    start = self.i;
                }
                0..=0x1f => return self.err(), // a control character, or the end of the text
                _ => self.i += 1,
            }
        }
    }

    fn array(&mut self) -> Parsed<Value> {
        self.i += 1; // [
        let mut a = Vec::new();
        self.skip_ws();
        if self.peek() == b']' {
            self.i += 1;
            return Ok(Value::Arr(a));
        }
        loop {
            a.push(self.value()?);
            self.skip_ws();
            match self.peek() {
                b',' => self.i += 1,
                b']' => {
                    self.i += 1;
                    return Ok(Value::Arr(a));
                }
                _ => return self.err(),
            }
        }
    }

    fn object(&mut self) -> Parsed<Value> {
        self.i += 1; // {
        let mut m = Vec::new();
        self.skip_ws();
        if self.peek() == b'}' {
            self.i += 1;
            return Ok(Value::Obj(m));
        }
        loop {
            self.skip_ws();
            if self.peek() != b'"' {
                return self.err();
            }
            let k = self.string()?;
            self.skip_ws();
            if self.peek() != b':' {
                return self.err();
            }
            self.i += 1;
            m.push((k, self.value()?));
            self.skip_ws();
            match self.peek() {
                b',' => self.i += 1,
                b'}' => {
                    self.i += 1;
                    return Ok(Value::Obj(m));
                }
                _ => return self.err(),
            }
        }
    }
}

fn parse(text: &str) -> Parsed<Value> {
    let mut p = Parser { src: text, i: 0 };
    let v = p.value()?;
    p.skip_ws();
    if p.i != text.len() {
        return p.err();
    }
    Ok(v)
}

// ── Writer ──────────────────────────────────────────────────────────────────
// QuoteJSONString (ECMA-262)
fn quote(out: &mut String, s: &str) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push('"');
    let mut start = 0;
    for (i, c) in s.bytes().enumerate() {
        if c >= 0x20 && c != b'"' && c != b'\\' {
            continue;
        }
        out.push_str(&s[start..i]);
        start = i + 1;
        match c {
            b'"' => out.push_str("\\\""),
            b'\\' => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x0c => out.push_str("\\f"),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            b'\t' => out.push_str("\\t"),
            _ => {
                out.push_str("\\u00");
                out.push(HEX[(c >> 4) as usize] as char);
                out.push(HEX[(c & 15) as usize] as char);
            }
        }
    }
    out.push_str(&s[start..]);
    out.push('"');
}

// The digits of `{:e}` text ([-]d[.ddd]e[-]x): d1..dk without trailing zeros,
// k, and n with |x| = 0.d1..dk × 10^n.
fn sci_digits(s: &str) -> ([u8; 17], usize, i32) {
    let (m, e) = s.split_once('e').unwrap();
    let mut d = [0u8; 17];
    let mut k = 0;
    for c in m.bytes().filter(u8::is_ascii_digit) {
        d[k] = c;
        k += 1;
    }
    while k > 1 && d[k - 1] == b'0' {
        k -= 1;
    }
    (d, k, e.parse::<i32>().unwrap() + 1)
}

// Number::toString (ECMA-262): the shortest decimal digits d1..dk that read
// back as x, the closest to x among them, with x = 0.d1..dk × 10^n, written as
// an integer while k <= n <= 21, as a decimal while -6 < n <= 21, else in
// exponent form (1.5e-7, 1e+21). `{:e}` gives the shortest digits and the
// closest, but on an exact tie between two it takes the upper where ECMAScript
// takes the even one; ties need 16 or more digits, and there the correctly
// rounded k digits (`{:.*e}`, ties to even) are the even one when they read back.
fn number(out: &mut String, x: f64) {
    if !x.is_finite() {
        out.push_str("null"); // as JSON.stringify writes NaN and Infinity
        return;
    }
    if x == 0.0 {
        out.push('0'); // -0 too
        return;
    }
    let start = out.len();
    write!(out, "{:e}", x.abs()).unwrap();
    let (mut d, mut k, mut n) = sci_digits(&out[start..]);
    if k >= 16 && (d[k - 1] - b'0') % 2 == 1 {
        out.truncate(start);
        write!(out, "{:.*e}", k - 1, x.abs()).unwrap();
        if out[start..].parse::<f64>() == Ok(x.abs()) {
            let even = sci_digits(&out[start..]);
            d = even.0;
            k = even.1;
            n = even.2;
        }
    }
    out.truncate(start);

    let d = &d[..k];
    let k = k as i32;
    let digits = |out: &mut String, ds: &[u8]| ds.iter().for_each(|&c| out.push(c as char));
    let zeros = |out: &mut String, m: i32| (0..m).for_each(|_| out.push('0'));
    if x < 0.0 {
        out.push('-');
    }
    if k <= n && n <= 21 {
        digits(out, d);
        zeros(out, n - k);
    } else if 0 < n && n <= 21 {
        digits(out, &d[..n as usize]);
        out.push('.');
        digits(out, &d[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        zeros(out, -n);
        digits(out, d);
    } else {
        digits(out, &d[..1]);
        if k > 1 {
            out.push('.');
            digits(out, &d[1..]);
        }
        write!(out, "e{}{}", if n >= 1 { '+' } else { '-' }, (n - 1).abs()).unwrap();
    }
}

struct Writer {
    out: String,
    first: bool, // nothing written yet in the innermost open container
}

impl Writer {
    fn new() -> Writer {
        Writer { out: String::with_capacity(128), first: true }
    }

    // before a member or an element
    fn sep(&mut self) {
        if !self.first {
            self.out.push(',');
        }
        self.first = false;
    }

    fn begin(&mut self, c: char) {
        self.out.push(c);
        self.first = true;
    }

    fn end(&mut self, c: char) {
        self.out.push(c);
        self.first = false;
    }

    fn key(&mut self, k: &str) {
        self.sep();
        quote(&mut self.out, k);
        self.out.push(':');
    }

    fn str(&mut self, s: &str) {
        quote(&mut self.out, s);
    }

    fn int(&mut self, n: i64) {
        write!(self.out, "{}", n).unwrap();
    }

    fn num(&mut self, x: f64) {
        number(&mut self.out, x);
    }

    fn lit(&mut self, s: &str) {
        self.out.push_str(s);
    }

    // any value, as JSON.stringify walks one
    fn value(&mut self, v: &Value) {
        match v {
            Value::Null => self.lit("null"),
            Value::Bool(b) => self.lit(if *b { "true" } else { "false" }),
            Value::Num(x) => self.num(*x),
            Value::Str(s) => self.str(s),
            Value::Arr(a) => {
                self.begin('[');
                for x in a {
                    self.sep();
                    self.value(x);
                }
                self.end(']');
            }
            Value::Obj(m) => {
                self.begin('{');
                for (k, x) in m {
                    self.key(k);
                    self.value(x);
                }
                self.end('}');
            }
        }
    }
}

// ── Document ────────────────────────────────────────────────────────────────
// the JS's makeDocument: an order's items and tags are drawn before r, which
// decides its first members, so they are held until the order is written
fn make_document(rng: &mut XorShift32) -> String {
    let mut w = Writer::new();
    w.begin('{');
    w.key("page");
    w.int(1);
    w.key("per");
    w.int(N as i64);
    w.key("orders");
    w.begin('[');
    for i in 0..N {
        let n_items = 1 + rng.next() % 6;
        let mut items = Vec::new();
        for _ in 0..n_items {
            let sku = format!("SKU-{}", 10000 + rng.next() % 90000);
            let name = PRODUCTS[rng.next() as usize % PRODUCTS.len()];
            let qty = 1 + rng.next() % 9;
            let price = (99 + rng.next() % 19901) as f64 / 100.0;
            items.push((sku, name, qty, price));
        }
        let n_tags = rng.next() % 4;
        let tags: Vec<&str> = (0..n_tags).map(|_| TAGS[rng.next() as usize % TAGS.len()]).collect();
        let r = rng.next();

        w.sep();
        w.begin('{');
        w.key("id");
        w.int(1000000 + i as i64);
        w.key("status");
        w.str(if r & 7 == 0 { "cancelled" } else { "paid" });
        w.key("customer");
        w.begin('{');
        w.key("id");
        w.int((5000 + r % 3000).into());
        w.key("name");
        w.str(NAMES[(r >> 4) as usize % NAMES.len()]);
        w.key("vip");
        w.lit(if r & 64 != 0 { "true" } else { "false" });
        w.end('}');
        w.key("items");
        w.begin('[');
        for (sku, name, qty, price) in &items {
            w.sep();
            w.begin('{');
            w.key("sku");
            w.str(sku);
            w.key("name");
            w.str(name);
            w.key("qty");
            w.int((*qty).into());
            w.key("price");
            w.num(*price);
            w.end('}');
        }
        w.end(']');
        w.key("discount");
        w.num(DISCOUNTS[(r >> 8) as usize % DISCOUNTS.len()]);
        w.key("tags");
        w.begin('[');
        for t in &tags {
            w.sep();
            w.str(t);
        }
        w.end(']');
        w.end('}');
    }
    w.end(']');
    w.end('}');
    w.out
}

// ── Transform ───────────────────────────────────────────────────────────────
// a kept order: its values borrow from the parsed tree
struct Kept<'a> {
    id: &'a Value,
    customer: &'a Value,
    vip: &'a Value,
    lines: usize,
    first: &'a Value,
    total: f64,
    tags: &'a Value,
}

fn transform(text: &str) -> String {
    let doc = parse(text).expect("jsontransform");
    let mut kept = Vec::new();
    let mut tag_counts = [("bulk", 0), ("express", 0), ("fragile", 0), ("gift", 0), ("priority", 0), ("return", 0)];
    let mut revenue = 0.0;
    for o in doc["orders"].as_array() {
        if o["status"].as_str() != Some("paid") {
            continue;
        }
        let items = o["items"].as_array();
        let mut sub = 0.0;
        for it in items {
            sub += it["qty"].as_f64() * it["price"].as_f64();
        }
        // round: half away from zero, Math.round's half up on these positive totals
        let total = (sub * (1.0 - o["discount"].as_f64()) * 100.0).round() / 100.0;
        if total < 20.0 {
            continue;
        }
        revenue += total;
        // the six tags the document holds; the JS would add any other as a member
        for t in o["tags"].as_array() {
            if let Some(c) = tag_counts.iter_mut().find(|c| t.as_str() == Some(c.0)) {
                c.1 += 1;
            }
        }
        kept.push(Kept {
            id: &o["id"],
            customer: &o["customer"]["name"],
            vip: &o["customer"]["vip"],
            lines: items.len(),
            first: &o["items"][0]["name"],
            total,
            tags: &o["tags"],
        });
    }

    let mut w = Writer::new();
    w.begin('{');
    w.key("page");
    w.value(&doc["page"]);
    w.key("count");
    w.int(kept.len() as i64);
    w.key("revenue");
    w.num((revenue * 100.0).round() / 100.0);
    w.key("tagCounts");
    w.begin('{');
    for (tag, count) in tag_counts {
        w.key(tag);
        w.int(count);
    }
    w.end('}');
    w.key("orders");
    w.begin('[');
    for k in &kept {
        w.sep();
        w.begin('{');
        w.key("id");
        w.value(k.id);
        w.key("customer");
        w.value(k.customer);
        w.key("vip");
        w.value(k.vip);
        w.key("lines");
        w.int(k.lines as i64);
        w.key("first");
        w.value(k.first);
        w.key("total");
        w.num(k.total);
        w.key("tags");
        w.value(k.tags);
        w.end('}');
    }
    w.end(']');
    w.end('}');
    w.out
}

fn checksum(s: &str) -> u32 {
    let mut h = mix(0x811c_9dc5, s.encode_utf16().count() as u32);
    for u in s.encode_utf16() {
        h = mix(h, u as u32);
    }
    h
}

fn main() {
    let text = make_document(&mut XorShift32(0x2545f491));
    let mut out = String::new();
    for _ in 0..N_WARMUP {
        out = transform(&text);
    }

    let mut samples = [0.0f64; N_RUNS];
    for s in samples.iter_mut() {
        let t0 = Instant::now();
        out = transform(&text);
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }
    println!("median_us={} checksum={} samples={} stages={} runs={}", median_us(&mut samples), checksum(&out), N, 3, N_RUNS);
}
