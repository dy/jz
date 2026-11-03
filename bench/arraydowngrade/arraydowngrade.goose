// arraydowngrade.goose: Goose port of arraydowngrade.js (Perry's
// bench_numeric_array_downgrade.ts, https://github.com/PerryTS/perry,
// benchmarks/suite, MIT; same array, passes and checksum): a quarter million
// integers pushed one by one, an object and a string stored in the middle,
// then 25 passes that add 1 to every numeric slot on both sides of them.
//
// Goose's answer to a value of several kinds is an enum; the array is indexed
// and its slots replaced, so it holds the enum in fixed mode (each slot the
// size of the largest variant), the object `{ value: 7 }` inline as a struct
// is, the string a view. `arr[i] = arr[i] + 1` is JS's `+` on a slot of any
// kind: a number adds, a string concatenates, an object concatenates its
// string form, so add_one matches every slot it updates and stores the sum
// back in it, a fixed-mode payload binding by value only. A concatenation
// would go onto a buffer the run owns, as json::parse decodes strings beside
// its tree; the passes never reach the string or the object, so none runs.

import bench from "../_lib";

let SIZE = 250000;
let ITERATIONS = 25;
let OBJECT_INDEX = 125000;
let STRING_INDEX = 125001;
let N_RUNS = 21;
let N_WARMUP = 3;

struct Obj { value: f64 }

enum Value {
    Num { v: f64 },
    Obj { o: Obj },
    Str { s: const u8[:] },
}

// x | 0 for the integers these sums hold
fn i32of(x: f64) -> u32 { (x as i64) as! u32 }

// arr[i] = arr[i] + 1, JS's `+`; a string made here goes onto `strings`
fn add_one(arr: Value[>..]&, i: i64, strings: u8[>..]&) {
    match arr[i] {
        Num n => { arr[i] = Value.Num { v: n.v + 1.0 }; },
        Str t => {
            let start = strings.len;
            strings.append(t.s);
            strings.push('1');
            arr[i] = Value.Str { s: strings[start..] };
        },
        Obj => {
            let start = strings.len;
            strings.append("[object Object]1");
            arr[i] = Value.Str { s: strings[start..] };
        },
    }
}

// a slot in a numeric sum: a number, or NaN (an undefined field, a string's concatenation never taken here)
fn num(v: Value) -> f64 {
    match v {
        Num n => n.v,
        _ => 0.0 / 0.0,
    }
}

fn field_value(v: Value) -> f64 {
    match v {
        Obj x => x.o.value,
        _ => 0.0 / 0.0,
    }
}

fn build_downgraded_array() -> Value[>..] {
    var arr: Value[>..] = [];
    for i in SIZE {
        arr.push(Value.Num { v: i });
    }

    arr[OBJECT_INDEX] = Value.Obj { o: Obj { value: 7.0 } };
    arr[STRING_INDEX] = Value.Str { s: "numeric-array-downgrade-payload" };
    return arr;
}

fn mutate_downgraded_array(arr: Value[>..]&, strings: u8[>..]&) -> f64 {
    var checksum = 0.0;

    for iter in ITERATIONS {
        for i in OBJECT_INDEX {
            add_one(arr, i, strings);
        }
        var i = STRING_INDEX + 1;
        while i < arr.len {
            add_one(arr, i, strings);
            i++;
        }

        checksum = checksum + num(arr[0]) + num(arr[arr.len - 1]) + field_value(arr[OBJECT_INDEX]);
        let empty = match arr[STRING_INDEX] {
            Str t => t.s.len == 0,
            _ => false,
        };
        if !empty {
            checksum = checksum + 3.0;
        }
    }

    return checksum + arr.len;
}

fn run_downgraded_array() -> f64 {
    var strings: u8[>..] = [];
    var arr = build_downgraded_array();
    return mutate_downgraded_array(arr, strings);
}

// a string's length in UTF-16 code units, as the JS's s.length
fn utf16_length(s: u8[:]) -> u32 {
    var units: u32 = 0;
    each_utf8(s) { cp => units += if cp >= 0x10000 { 2 } else { 1 }; };
    return units;
}

fn main() {
    for i in N_WARMUP { run_downgraded_array(); }

    var h: u32 = 0x811c9dc5;
    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        let cs = run_downgraded_array();
        t = now_ms() - t0;
        h = mix(h, i32of(cs));
    }

    var strings: u8[>..] = [];
    var arr = build_downgraded_array();
    h = mix(h, i32of(mutate_downgraded_array(arr, strings)));
    for v in arr {
        h = mix(h, match v {
            Num n => i32of(n.v),
            Str t => utf16_length(t.s),
            Obj x => i32of(x.o.value),
        });
    }
    print_result(median_us(samples), h, SIZE, 2, N_RUNS);
}
