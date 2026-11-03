// arraynumeric.goose: Goose port of arraynumeric.js (Perry's
// bench_numeric_array_numeric.ts, https://github.com/PerryTS/perry,
// benchmarks/suite, MIT; same array, passes and checksum): a quarter million
// integers pushed one by one, then 25 passes that add 1 to every slot. The JS
// array of numbers is a grow-only f64 array; each run builds one and drops it.

import bench from "../_lib";

let SIZE = 250000;
let ITERATIONS = 25;
let N_RUNS = 21;
let N_WARMUP = 3;

// x | 0 for the integers these sums hold
fn i32of(x: f64) -> u32 { (x as i64) as! u32 }

fn build_numeric_array() -> f64[>..] {
    var arr: f64[>..] = [];
    for i in SIZE {
        arr.push(i);
    }
    return arr;
}

fn mutate_numeric_array(arr: f64[>..]&) -> f64 {
    var checksum = 0.0;

    for iter in ITERATIONS {
        var i = 0;
        while i < arr.len {
            arr[i] = arr[i] + 1.0;
            i++;
        }
        checksum = checksum + arr[0] + arr[arr.len - 1];
    }

    return checksum + arr.len;
}

fn run_numeric_array() -> f64 {
    var arr = build_numeric_array();
    return mutate_numeric_array(arr);
}

fn main() {
    for i in N_WARMUP { run_numeric_array(); }

    var h: u32 = 0x811c9dc5;
    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        let cs = run_numeric_array();
        t = now_ms() - t0;
        h = mix(h, i32of(cs));
    }

    var arr = build_numeric_array();
    h = mix(h, i32of(mutate_numeric_array(arr)));
    for v in arr { h = mix(h, i32of(v)); }
    print_result(median_us(samples), h, SIZE, 2, N_RUNS);
}
