// pcmconvert.goose: Goose port of pcmconvert.js (same input, formats and
// checksum): interleaved float32 mapped to int16 (scaled, rounded half up,
// clipped), then deinterleaved to planar float64. The library's dtype table
// keeps its ranges, an enum in place of the names; each conversion is generic
// over the element type it builds.

import bench from "../_lib";
import math;

let N_FRAMES = 240000;      // 5 s @ 48 kHz stereo
let N_CH = 2;
let N_RUNS = 21;
let N_WARMUP = 5;

enum Dtype { F32, F64, U8, I16, I32 }
struct Range { min: f64, max: f64 }

fn range(d: Dtype) -> Range {
    match d {
        U8 => Range { min: 0.0, max: 255.0 },
        I16 => Range { min: -32768.0, max: 32767.0 },
        I32 => Range { min: -2147483648.0, max: 2147483647.0 },
        _ => Range { min: -1.0, max: 1.0 },
    }
}

fn span(r: Range, other: Range) -> f64 {
    if r.max > 1 && other.max == 1 && other.min == -1 { r.max - r.min + 1 } else { r.max - r.min }
}

// JS Math.round: half toward +infinity.
fn js_round(v: f64) -> f64 { floor(v + 0.5) }

fn mk_input(n: i64) -> f32[>..] {
    var out: f32[>..] = [];
    var s: u32 = 0x1234abcd;
    for i in n {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        out.push((s / 4294967296.0 * 2 - 1) as f32);
    }
    return out;
}

fn map_range<T>(samples, from: Dtype, to: Dtype) -> T[>..] {
    let from_r = range(from);
    let to_r = range(to);
    let from_span = span(from_r, to_r);
    let to_span = span(to_r, from_r);
    let round_int = from_r.min == -1 && from_r.max == 1 && to_r.max > 1;
    var out: T[>..] = [];
    for x in samples {
        var v = (x - from_r.min) / from_span * to_span + to_r.min;
        if round_int { v = js_round(v); }
        out.push((if v < to_r.min { to_r.min } else if v > to_r.max { to_r.max } else { v }) as! T);
    }
    return out;
}

fn deinterleave<T>(samples, from: Dtype, to: Dtype, ch: i64) -> T[>..] {
    let from_r = range(from);
    let to_r = range(to);
    let len = samples.len;
    let seg = len / ch;
    let from_span = span(from_r, to_r);
    let to_span = span(to_r, from_r);
    let round_int = from_r.min == -1 && from_r.max == 1 && to_r.max > 1;
    var out: T[>..] = [];
    for i in len {
        let si = (i % seg) * ch + i / seg;
        var v: f64 = samples[si];
        v = (v - from_r.min) / from_span * to_span + to_r.min;
        if round_int { v = js_round(v); }
        if v < to_r.min { v = to_r.min; }
        else if v > to_r.max { v = to_r.max; }
        out.push(v as! T);
    }
    return out;
}

fn main() {
    let x = mk_input(N_FRAMES * N_CH);
    var out: f64[>..] = [];
    for i in N_WARMUP { out = deinterleave<f64>(map_range<i16>(x, Dtype.F32, Dtype.I16), Dtype.I16, Dtype.F64, N_CH); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        out = deinterleave<f64>(map_range<i16>(x, Dtype.F32, Dtype.I16), Dtype.I16, Dtype.F64, N_CH);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(out), N_FRAMES, N_CH, N_RUNS);
}
