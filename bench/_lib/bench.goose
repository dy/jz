// Shared timing, checksum and output for the .goose bench kernels: the Goose
// sibling of bench.h, bench.zig, bench.mbt and bench.tov. A case takes it as a
// package from this directory (`import bench from "../_lib";`) and prints the
// one `median_us=… checksum=… samples=… stages=… runs=…` line bench.mjs parses.
//
// Unsigned arithmetic wraps in every Goose build, so the FNV step is the plain
// u32 multiply of benchlib.js's Math.imul.

import os;

// Milliseconds on the monotonic clock: performance.now() of the JS cases.
fn now_ms() -> f64 { clock() * 1000.0 }

fn mix(h: u32, x: u32) -> u32 { (h ^ x) * 0x01000193 }

// FNV-style hash over every 128th element (benchlib.js checksumU32).
fn checksum_u32(xs: u32[:]) -> u32 {
    var h: u32 = 0x811c9dc5;
    var i = 0;
    while i < xs.len {
        h = mix(h, xs[i]);
        i += 128;
    }
    return h;
}

// The same over an Int32Array's elements, their bits read as u32.
fn checksum_u32(xs: i32[:]) -> u32 {
    var h: u32 = 0x811c9dc5;
    var i = 0;
    while i < xs.len {
        h = mix(h, xs[i] as! u32);
        i += 128;
    }
    return h;
}

// FNV-style hash over every byte (benchlib.js checksumU8).
fn checksum_u8(xs: u8[:]) -> u32 {
    var h: u32 = 0x811c9dc5;
    for b in xs { h = mix(h, b); }
    return h;
}

// Every 256th 32-bit word of the f64 buffer's bytes, little-endian
// (benchlib.js checksumF64 hashes a Uint32Array view of the same memory).
fn checksum_f64(xs: f64[:]) -> u32 {
    let b = bytes_of(xs);
    var h: u32 = 0x811c9dc5;
    var i = 0;
    while i < xs.len * 2 {
        let k = i * 4;
        h = mix(h, b[k] | b[k + 1] as u32 << 8 | b[k + 2] as u32 << 16 | b[k + 3] as u32 << 24);
        i += 256;
    }
    return h;
}

// Middle sample in microseconds, truncated (benchlib.js medianUs).
fn median_us(samples: f64[:]) -> i64 {
    for i in 1..samples.len {
        let v = samples[i];
        var j = i - 1;
        while j >= 0 && samples[j] > v {
            samples[j + 1] = samples[j];
            j--;
        }
        samples[j + 1] = v;
    }
    return (samples[(samples.len - 1) >> 1] * 1000.0) as i64;
}

fn print_result(median: i64, checksum: u32, samples: i64, stages: i64, runs: i64) {
    print("median_us=", median, " checksum=", checksum, " samples=", samples,
          " stages=", stages, " runs=", runs);
}
