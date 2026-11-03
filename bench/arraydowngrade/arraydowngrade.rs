// arraydowngrade.rs – a plain array that starts numeric and stops being so: a
// quarter million integers pushed one by one, an object and a string stored in
// the middle, then 25 passes that add 1 to every numeric slot on both sides of
// them, ported from arraydowngrade.js (Perry's
// bench_numeric_array_downgrade.ts, https://github.com/PerryTS/perry,
// benchmarks/suite, MIT).
//
// A JS array of mixed values is a Vec of an enum (a number, an object, a
// string) grown by push; the object `{ value: 7 }` is a struct behind a Box,
// as a JS object is a reference, the string a String. `arr[i] = arr[i] + 1` is
// JS's `+` on a slot of any kind: a number adds, a string concatenates, an
// object concatenates its string form, so add_one matches every slot it
// updates and adds to a number in place; the passes never reach the string or
// the object, so the concatenations never run. Each run drops what it built,
// as the JS drops its array.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every run's result
// and every slot of one more run's array, as the JS folds them (a number as
// itself, the object by its field, the string by its UTF-16 length).
use std::time::Instant;

const SIZE: usize = 250000;
const ITERATIONS: usize = 25;
const OBJECT_INDEX: usize = 125000;
const STRING_INDEX: usize = 125001;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 3;

struct Obj {
    value: f64,
}

enum Value {
    Num(f64),
    Obj(Box<Obj>),
    Str(String),
}

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

// x | 0 for the integers these sums hold
fn i32(x: f64) -> u32 {
    x as i32 as u32
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

// arr[i] = arr[i] + 1, JS's `+`
fn add_one(v: &mut Value) {
    match v {
        Value::Num(x) => *x += 1.0,
        Value::Str(s) => s.push('1'),
        Value::Obj(_) => *v = Value::Str(String::from("[object Object]1")),
    }
}

// a slot in a numeric sum: a number, or NaN (an undefined field, a string's concatenation never taken here)
fn num(v: &Value) -> f64 {
    match v {
        Value::Num(x) => *x,
        _ => f64::NAN,
    }
}

fn field_value(v: &Value) -> f64 {
    match v {
        Value::Obj(o) => o.value,
        _ => f64::NAN,
    }
}

fn build_downgraded_array() -> Vec<Value> {
    let mut arr = Vec::new();
    for i in 0..SIZE {
        arr.push(Value::Num(i as f64));
    }

    arr[OBJECT_INDEX] = Value::Obj(Box::new(Obj { value: 7.0 }));
    arr[STRING_INDEX] = Value::Str(String::from("numeric-array-downgrade-payload"));
    arr
}

fn mutate_downgraded_array(arr: &mut Vec<Value>) -> f64 {
    let mut checksum = 0.0;

    for _ in 0..ITERATIONS {
        for i in 0..OBJECT_INDEX {
            add_one(&mut arr[i]);
        }
        for i in STRING_INDEX + 1..arr.len() {
            add_one(&mut arr[i]);
        }

        checksum = checksum + num(&arr[0]) + num(&arr[arr.len() - 1]) + field_value(&arr[OBJECT_INDEX]);
        if !matches!(&arr[STRING_INDEX], Value::Str(s) if s.is_empty()) {
            checksum = checksum + 3.0;
        }
    }

    checksum + arr.len() as f64
}

fn run_downgraded_array() -> f64 {
    mutate_downgraded_array(&mut build_downgraded_array())
}

fn main() {
    for _ in 0..N_WARMUP {
        run_downgraded_array();
    }

    let mut h: u32 = 0x811c_9dc5;
    let mut samples = [0.0f64; N_RUNS];
    for s in samples.iter_mut() {
        let t0 = Instant::now();
        let cs = run_downgraded_array();
        *s = t0.elapsed().as_secs_f64() * 1000.0;
        h = mix(h, i32(cs));
    }

    let mut arr = build_downgraded_array();
    h = mix(h, i32(mutate_downgraded_array(&mut arr)));
    for v in &arr {
        h = mix(h, match v {
            Value::Num(x) => i32(*x),
            Value::Str(s) => s.encode_utf16().count() as u32,
            Value::Obj(o) => i32(o.value),
        });
    }
    println!("median_us={} checksum={} samples={} stages={} runs={}", median_us(&mut samples), h, SIZE, 2, N_RUNS);
}
