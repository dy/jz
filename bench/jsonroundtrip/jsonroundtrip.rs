// jsonroundtrip.rs – JSON.parse then JSON.stringify of one ~1 MB document,
// ported from jsonroundtrip.js (Perry's bench_json_roundtrip.ts,
// https://github.com/PerryTS/perry, benchmarks/suite, MIT): 10,000 records of
// an integer id, a string name, a float value, an array of two tag strings and
// a nested {x, y} object, written once, then parsed into a generic Value and
// written back.
//
// Rust has no JSON in its standard library and the ports take no crates, so
// both directions are written here, jsontransform.rs's parser and writer
// unchanged: a recursive descent into serde_json's Value shape with insertion
// order kept (an object a Vec of key/value pairs, numbers read with
// str::parse::<f64>), and a writer of QuoteJSONString's escapes and
// Number::toString's shortest digits from `{:e}` (an exact tie between two
// taken to the even one, as ECMAScript recommends). The writer walks the tree
// as JSON.stringify walks the parsed value.
//
// The document is generated once exactly as the JS generates it, written by
// the same writer, outside the timed region. The timed region is one round
// trip: parse, write, drop the tree and the previous text. Perry's sum adds the
// parsed array's length and the text's length; the text is ASCII, so its byte
// length is its UTF-16 length.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over that sum, then the
// last run's text as the JS folds it: its UTF-16 length, then its UTF-16 code
// units (encode_utf16).
use std::fmt::Write;
use std::time::Instant;

const N: usize = 10000; // records in the document
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

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


impl Value {
    fn as_array(&self) -> &[Value] {
        match self {
            Value::Arr(a) => a,
            _ => &[],
        }
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
// the JS's items, written by JSON.stringify
fn make_blob() -> String {
    let mut w = Writer::new();
    w.begin('[');
    for i in 0..N as i64 {
        w.sep();
        w.begin('{');
        w.key("id");
        w.int(i);
        w.key("name");
        w.str(&format!("item_{}", i));
        w.key("value");
        w.num(i as f64 * 3.14159);
        w.key("tags");
        w.begin('[');
        w.sep();
        w.str(&format!("tag_{}", i % 10));
        w.sep();
        w.str(&format!("tag_{}", i % 5));
        w.end(']');
        w.key("nested");
        w.begin('{');
        w.key("x");
        w.int(i);
        w.key("y");
        w.int(i * 2);
        w.end('}');
        w.end('}');
    }
    w.end(']');
    w.out
}

// ── Round trip ──────────────────────────────────────────────────────────────
// JSON.stringify(JSON.parse(text)), with the parsed array's length
fn round_trip(text: &str) -> (usize, String) {
    let doc = parse(text).expect("jsonroundtrip");
    let mut w = Writer::new();
    w.value(&doc);
    (doc.as_array().len(), w.out)
}

fn checksum(count: u32, s: &str) -> u32 {
    let mut h = mix(mix(0x811c_9dc5, count), s.encode_utf16().count() as u32);
    for u in s.encode_utf16() {
        h = mix(h, u as u32);
    }
    h
}

fn main() {
    let blob = make_blob();
    let mut out = String::new();
    for _ in 0..N_WARMUP {
        out = round_trip(&blob).1;
    }

    let mut count: u32 = 0;
    let mut samples = [0.0f64; N_RUNS];
    for s in samples.iter_mut() {
        let t0 = Instant::now();
        let (len, text) = round_trip(&blob);
        count = count.wrapping_add(len as u32);
        out = text;
        count = count.wrapping_add(out.len() as u32);
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }
    println!("median_us={} checksum={} samples={} stages={} runs={}", median_us(&mut samples), checksum(count, &out), N, 2, N_RUNS);
}
