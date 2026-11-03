// stringify.rs – JSON.stringify of realistic order records: an NDJSON log
// writer that serializes every record on one line and pretty-prints every 16th
// for a debug dump, ported from stringify.js.
//
// Rust has no JSON in its standard library and the ports take no crates, so
// the writer is written here, shaped like a serde Serialize impl: each struct
// writes itself through a streaming Writer that places commas, line breaks and
// two-space indentation as JSON.stringify(x) and JSON.stringify(x, null, 2) do,
// keys in the JS's insertion order, into a String (128 bytes to start, as
// serde_json's to_string). Strings are escaped as ECMAScript's QuoteJSONString
// escapes them (`"` and `\`, \b \f \n \r \t, other bytes below 0x20 as \u00xx
// in lowercase hex); everything else, non-ASCII included, is copied as UTF-8.
// Numbers are written as Number::toString writes them: `{:e}` gives the
// shortest digits that read back as the same f64, the closest among them (an
// exact tie between two taken to the even one, as ECMAScript recommends), and
// their exponent, laid out in integer, decimal or exponent form by ECMAScript's
// rules.
//
// Records are structs built once from XorShift32 exactly as the JS builds them,
// integer fields as integers, the rest as f64, items and tags as Vecs. Each line
// is a fresh String, as each JSON.stringify returns a new string; the next run
// drops the last run's lines when it clears the Vec. The timed region is the
// serialization alone.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every line of the last
// run as the JS folds it, outside the timed region: the line's UTF-16 length,
// then its UTF-16 code units (encode_utf16).
use std::fmt::Write;
use std::time::Instant;

const N: usize = 1024; // records per pass
const DUMP: usize = 16; // every DUMP-th record is also pretty-printed
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

const NAMES: [&str; 12] = ["Ada Lovelace", "José Martí", "Zoë Kravitz", "Søren Kierkegaard", "李小龙",
    "Ngũgĩ wa Thiong'o", "Björk Guðmundsdóttir", "Chloé \"Coco\" Dupont", "Mikhail Bulgakov",
    "Ἀριστοτέλης", "Grace Hopper", "Alan Turing"];
const CITIES: [&str; 8] = ["Montréal", "Zürich", "København", "São Paulo", "東京", "Reykjavík", "Kraków", "Toronto"];
const PRODUCTS: [&str; 16] = ["Desk lamp", "Cable 2m\\5m", "Mug \"Hello\"", "Notebook, A5", "Tea – Darjeeling",
    "Café crème", "Gift card 🎁", "Line1\nLine2", "Tab\tSeparated", "Bell\u{7}", "Ångström ruler",
    "naïve façade", "Résumé paper", "Pens (12)", "Stand/Arm", "Ruler 30cm"];
const TAGS: [&str; 6] = ["gift", "express", "fragile", "bulk", "return", "priority"];
const NOTES: [&str; 8] = ["Leave at door", "Call \"front desk\"", "Ring twice\r\nthen wait", "Back\\slash",
    "form\u{c}feed", "checked ✓", "ctrl\u{1f}char", "Merci beaucoup!"];
const DISCOUNTS: [f64; 8] = [0.0, 0.05, 0.1, 0.125, 0.15, 0.2, 1.0 / 3.0, 0.07];

struct Address { city: &'static str, zip: String }
struct Customer { id: u32, name: &'static str, email: String, vip: bool, address: Address }
struct Item { sku: String, name: &'static str, qty: u32, price: f64 }
struct Geo { lat: f64, lon: f64 }
struct Record {
    id: u32,
    created: i64,
    customer: Customer,
    items: Vec<Item>,
    total: f64,
    discount: f64,
    tags: Vec<&'static str>,
    note: Option<&'static str>,
    geo: Geo,
    rate: f64,
}

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

fn make_record(i: usize, rng: &mut XorShift32) -> Record {
    let n_items = 1 + rng.next() % 5;
    let mut items = Vec::with_capacity(n_items as usize);
    let mut total = 0.0;
    for _ in 0..n_items {
        let qty = 1 + rng.next() % 9;
        let price = (99 + rng.next() % 99901) as f64 / 100.0;
        total += qty as f64 * price;
        let sku = format!("SKU-{}", 10000 + rng.next() % 90000);
        items.push(Item { sku, name: PRODUCTS[rng.next() as usize % PRODUCTS.len()], qty, price });
    }
    let mut tags = Vec::new();
    let n_tags = rng.next() % 4;
    for _ in 0..n_tags {
        tags.push(TAGS[rng.next() as usize % TAGS.len()]);
    }
    let r = rng.next();
    let customer = Customer {
        id: 5000 + r % 3000,
        name: NAMES[r as usize % NAMES.len()],
        email: format!("user{}@example.com", r % 3000),
        vip: r & 16 != 0,
        address: Address {
            city: CITIES[(r >> 8) as usize % CITIES.len()],
            zip: format!("H{}X {}Y{}", (r >> 12) % 10, (r >> 16) % 10, (r >> 20) % 10),
        },
    };
    let lat = (rng.next() % 180000000) as f64 / 1e6 - 90.0;
    let lon = (rng.next() % 360000000) as f64 / 1e6 - 180.0;
    let rate = (1 + rng.next() % 999) as f64 * 1.5e-7;
    Record {
        id: 1000000 + i as u32,
        created: 1767225600000 + i as i64 * 61003,
        customer,
        items,
        total,
        discount: DISCOUNTS[(r >> 4) as usize % DISCOUNTS.len()],
        tags,
        note: if r & 3 == 0 { Some(NOTES[(r >> 6) as usize % NOTES.len()]) } else { None },
        geo: Geo { lat, lon },
        rate,
    }
}

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
    indent: usize, // spaces per level; 0 writes the compact form
    depth: usize,  // open containers
    first: bool,   // nothing written yet in the innermost open container
}

impl Writer {
    fn new(indent: usize) -> Writer {
        Writer { out: String::with_capacity(128), indent, depth: 0, first: true }
    }

    fn newline(&mut self) {
        self.out.push('\n');
        for _ in 0..self.depth * self.indent {
            self.out.push(' ');
        }
    }

    // before a member or an element: the comma, and in the pretty form a line break
    fn sep(&mut self) {
        if !self.first {
            self.out.push(',');
        }
        self.first = false;
        if self.indent > 0 {
            self.newline();
        }
    }

    fn begin(&mut self, c: char) {
        self.out.push(c);
        self.depth += 1;
        self.first = true;
    }

    // an empty container stays `{}` or `[]` in the pretty form too
    fn end(&mut self, c: char) {
        self.depth -= 1;
        if self.indent > 0 && !self.first {
            self.newline();
        }
        self.out.push(c);
        self.first = false;
    }

    fn key(&mut self, k: &str) {
        self.sep();
        quote(&mut self.out, k);
        self.out.push_str(if self.indent > 0 { ": " } else { ":" });
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
}

// Records to JSON, keys in the JS's order.
impl Customer {
    fn write(&self, w: &mut Writer) {
        w.begin('{');
        w.key("id");
        w.int(self.id.into());
        w.key("name");
        w.str(self.name);
        w.key("email");
        w.str(&self.email);
        w.key("vip");
        w.lit(if self.vip { "true" } else { "false" });
        w.key("address");
        w.begin('{');
        w.key("city");
        w.str(self.address.city);
        w.key("zip");
        w.str(&self.address.zip);
        w.end('}');
        w.end('}');
    }
}

impl Item {
    fn write(&self, w: &mut Writer) {
        w.begin('{');
        w.key("sku");
        w.str(&self.sku);
        w.key("name");
        w.str(self.name);
        w.key("qty");
        w.int(self.qty.into());
        w.key("price");
        w.num(self.price);
        w.end('}');
    }
}

impl Record {
    fn write(&self, w: &mut Writer) {
        w.begin('{');
        w.key("id");
        w.int(self.id.into());
        w.key("created");
        w.int(self.created);
        w.key("customer");
        self.customer.write(w);
        w.key("items");
        w.begin('[');
        for it in &self.items {
            w.sep();
            it.write(w);
        }
        w.end(']');
        w.key("total");
        w.num(self.total);
        w.key("discount");
        w.num(self.discount);
        w.key("tags");
        w.begin('[');
        for t in &self.tags {
            w.sep();
            w.str(t);
        }
        w.end(']');
        w.key("note");
        match self.note {
            Some(s) => w.str(s),
            None => w.lit("null"),
        }
        w.key("geo");
        w.begin('{');
        w.key("lat");
        w.num(self.geo.lat);
        w.key("lon");
        w.num(self.geo.lon);
        w.end('}');
        w.key("rate");
        w.num(self.rate);
        w.end('}');
    }
}

fn stringify(r: &Record, indent: usize) -> String {
    let mut w = Writer::new(indent);
    r.write(&mut w);
    w.out
}

fn serialize(records: &[Record], out: &mut Vec<String>) {
    out.clear();
    for (i, r) in records.iter().enumerate() {
        out.push(stringify(r, 0));
        if i % DUMP == 0 {
            out.push(stringify(r, 2));
        }
    }
}

fn checksum(out: &[String]) -> u32 {
    let mut h = 0x811c_9dc5u32;
    for s in out {
        h = mix(h, s.encode_utf16().count() as u32);
        for u in s.encode_utf16() {
            h = mix(h, u as u32);
        }
    }
    h
}

fn main() {
    let mut rng = XorShift32(0x1234abcd);
    let records: Vec<Record> = (0..N).map(|i| make_record(i, &mut rng)).collect();
    let mut out = Vec::new();
    for _ in 0..N_WARMUP {
        serialize(&records, &mut out);
    }

    let mut samples = [0.0f64; N_RUNS];
    for s in samples.iter_mut() {
        let t0 = Instant::now();
        serialize(&records, &mut out);
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }
    println!("median_us={} checksum={} samples={} stages={} runs={}", median_us(&mut samples), checksum(&out), N, 2, N_RUNS);
}
