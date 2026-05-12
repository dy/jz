// json.rs — general JSON parser for benchmark. No external crates.
use std::time::Instant;

const SRC: &str = r#"{"items":[{"id":1,"kind":2,"value":10},{"id":2,"kind":3,"value":20},{"id":3,"kind":5,"value":30}],"meta":{"scale":7,"bias":11}}"#;
const N_ITERS: usize = 512;
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

// ── Value ─────────────────────────────────────────────────────────────────────
#[allow(dead_code)]
enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(pairs) => {
                for (k, v) in pairs {
                    if k == key { return Some(v); }
                }
                None
            }
            _ => None,
        }
    }

    fn as_i32(&self) -> i32 {
        match self {
            Json::Num(n) => *n as i64 as i32,
            _ => 0,
        }
    }

    fn as_arr(&self) -> &[Json] {
        match self {
            Json::Arr(v) => v,
            _ => &[],
        }
    }
}

// ── Parser ────────────────────────────────────────────────────────────────────
struct Parser<'a> {
    src: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn new(s: &'a str) -> Self {
        Parser { src: s.as_bytes(), pos: 0 }
    }

    fn skip_ws(&mut self) {
        while self.pos < self.src.len() {
            match self.src[self.pos] {
                b' ' | b'\t' | b'\n' | b'\r' => self.pos += 1,
                _ => break,
            }
        }
    }

    fn peek(&self) -> u8 {
        if self.pos < self.src.len() { self.src[self.pos] } else { 0 }
    }

    fn parse_string(&mut self) -> String {
        self.pos += 1; // skip "
        let start = self.pos;
        while self.pos < self.src.len() && self.src[self.pos] != b'"' {
            if self.src[self.pos] == b'\\' { self.pos += 1; }
            self.pos += 1;
        }
        let s = String::from_utf8_lossy(&self.src[start..self.pos]).into_owned();
        self.pos += 1; // skip closing "
        s
    }

    fn parse_number(&mut self) -> f64 {
        let start = self.pos;
        if self.peek() == b'-' { self.pos += 1; }
        while self.pos < self.src.len() && self.src[self.pos].is_ascii_digit() { self.pos += 1; }
        if self.pos < self.src.len() && self.src[self.pos] == b'.' {
            self.pos += 1;
            while self.pos < self.src.len() && self.src[self.pos].is_ascii_digit() { self.pos += 1; }
        }
        if self.pos < self.src.len() && (self.src[self.pos] == b'e' || self.src[self.pos] == b'E') {
            self.pos += 1;
            if self.pos < self.src.len() && (self.src[self.pos] == b'+' || self.src[self.pos] == b'-') { self.pos += 1; }
            while self.pos < self.src.len() && self.src[self.pos].is_ascii_digit() { self.pos += 1; }
        }
        std::str::from_utf8(&self.src[start..self.pos]).unwrap().parse().unwrap_or(0.0)
    }

    fn parse_array(&mut self) -> Json {
        self.pos += 1; // skip [
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == b']' { self.pos += 1; return Json::Arr(items); }
        loop {
            items.push(self.parse_value());
            self.skip_ws();
            if self.peek() == b']' { self.pos += 1; break; }
            self.pos += 1; // skip ','
            self.skip_ws();
        }
        Json::Arr(items)
    }

    fn parse_object(&mut self) -> Json {
        self.pos += 1; // skip {
        let mut pairs = Vec::new();
        self.skip_ws();
        if self.peek() == b'}' { self.pos += 1; return Json::Obj(pairs); }
        loop {
            self.skip_ws();
            let key = self.parse_string();
            self.skip_ws();
            self.pos += 1; // skip ':'
            self.skip_ws();
            let val = self.parse_value();
            pairs.push((key, val));
            self.skip_ws();
            if self.peek() == b'}' { self.pos += 1; break; }
            self.pos += 1; // skip ','
            self.skip_ws();
        }
        Json::Obj(pairs)
    }

    fn parse_value(&mut self) -> Json {
        self.skip_ws();
        match self.peek() {
            b'"' => Json::Str(self.parse_string()),
            b'{' => self.parse_object(),
            b'[' => self.parse_array(),
            b'n' => { self.pos += 4; Json::Null }
            b't' => { self.pos += 4; Json::Bool(true) }
            b'f' => { self.pos += 5; Json::Bool(false) }
            _ => Json::Num(self.parse_number()),
        }
    }
}

fn parse_and_walk() -> u32 {
    let mut h = 0x811c_9dc5u32;
    for _ in 0..N_ITERS {
        let root = Parser::new(SRC).parse_value();

        let items = root.get("items").map(|v| v.as_arr()).unwrap_or(&[]);
        let meta  = root.get("meta");
        let scale = meta.and_then(|m| m.get("scale")).map(|v| v.as_i32()).unwrap_or(0);
        let mut s = meta.and_then(|m| m.get("bias")).map(|v| v.as_i32()).unwrap_or(0);

        for it in items {
            let id    = it.get("id").map(|v| v.as_i32()).unwrap_or(0);
            let kind  = it.get("kind").map(|v| v.as_i32()).unwrap_or(0);
            let value = it.get("value").map(|v| v.as_i32()).unwrap_or(0);
            s = s.wrapping_add(id.wrapping_mul(scale).wrapping_add(kind).wrapping_add(value));
        }
        h = mix(h, s as u32);
    }
    h
}

fn main() {
    let mut cs = 0u32;
    for _ in 0..N_WARMUP { cs = parse_and_walk(); }

    let mut samples = [0.0f64; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        cs = parse_and_walk();
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples), cs, N_ITERS, 4, N_RUNS
    );
}
