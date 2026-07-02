// dispatch.zig — data-driven dispatch through a table of first-class functions:
// an unpredictable opcode stream picks one of 8 tiny integer operators at a
// single call site. The canonical dynamic-dispatch kernel (virtual/interface
// calls, strategy tables, event pipelines, effect chains): every step is an
// indirect call through a data-selected function pointer. Pure 32-bit integer,
// so the fold result is bit-identical across every engine and native target.
//
// Reports: median ms across N_RUNS, throughput in calls/µs, FNV-1a checksum
// over the per-pass fold results.
const std = @import("std");
const bench = @import("bench");

const N: usize = 1 << 14;      // opcode stream length
const NOPS: i32 = 8;           // distinct operators in the table
const N_ITERS: usize = 48;     // stream passes per kernel run
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

fn mix(h: u32, x: u32) u32 {
    return (h ^ x) *% 0x01000193;
}

fn medianUs(samples: *[N_RUNS]f64) u64 {
    var i: usize = 1;
    while (i < samples.len) : (i += 1) {
        const v = samples[i];
        var j = i;
        while (j > 0 and samples[j - 1] > v) : (j -= 1) samples[j] = samples[j - 1];
        samples[j] = v;
    }
    return @as(u64, @intFromFloat(samples[(samples.len - 1) >> 1] * 1000.0));
}

// The operator table — 8 functions with one shared signature, selected per
// element by data. Semantics mirror dispatch.js exactly (JS i32 ops).
fn opAdd(x: i32, k: i32) i32 {
    return @bitCast(@as(u32, @bitCast(x)) +% @as(u32, @bitCast(k)));
}
fn opXor(x: i32, k: i32) i32 {
    return x ^ k;
}
fn opMul(x: i32, k: i32) i32 {
    return @bitCast(@as(u32, @bitCast(x)) *% @as(u32, @bitCast(k | 1)));
}
fn opRsub(x: i32, k: i32) i32 {
    return @bitCast(@as(u32, @bitCast(k)) -% @as(u32, @bitCast(x)));
}
fn opShr(x: i32, k: i32) i32 {
    return x ^ @as(i32, @bitCast(@as(u32, @bitCast(x)) >> 7)) ^ k;
}
fn opM31(x: i32, k: i32) i32 {
    const ux: u32 = @bitCast(x);
    return @bitCast((ux << 5) -% ux +% @as(u32, @bitCast(k)));
}
fn opRot(x: i32, k: i32) i32 {
    const ux: u32 = @bitCast(x);
    return @bitCast(((ux << 13) | (ux >> 19)) ^ @as(u32, @bitCast(k)));
}
fn opAnd(x: i32, k: i32) i32 {
    return (x & k) ^ @as(i32, @bitCast(@as(u32, @bitCast(x)) >> 11));
}

const OpFn = *const fn (i32, i32) i32;
const OPS = [_]OpFn{ opAdd, opXor, opMul, opRsub, opShr, opM31, opRot, opAnd };

// Deterministic unpredictable opcode/operand stream — XorShift32, identical
// per target; low 3 bits pick the operator, the rest is the operand.
fn fill(code: []i32, ks: []i32) void {
    var s: u32 = 0x1234abcd;
    var i: usize = 0;
    while (i < N) : (i += 1) {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        code[i] = @intCast(s & 7); // s & (NOPS - 1): low 3 bits, sign-free
        ks[i] = @as(i32, @bitCast(s)) >> 3;
    }
}

fn runKernel(code: []i32, ks: []i32) u32 {
    var h: u32 = 0x811c9dc5;
    var it: usize = 0;
    while (it < N_ITERS) : (it += 1) {
        var x: i32 = @bitCast(@as(u32, 0x2545f491) +% @as(u32, @truncate(it)));
        var i: usize = 0;
        while (i < N) : (i += 1) {
            x = OPS[@intCast(code[i])](x, ks[i]);
        }
        h = mix(h, @bitCast(x));
    }
    return h;
}

pub fn main() !void {
    const allocator = std.heap.page_allocator;
    const code = try allocator.alloc(i32, N);
    const ks = try allocator.alloc(i32, N);
    defer allocator.free(code);
    defer allocator.free(ks);

    fill(code, ks);

    var cs: u32 = 0;
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) cs = runKernel(code, ks);

    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = bench.nowMs();
        cs = runKernel(code, ks);
        samples[i] = bench.nowMs() - t0;
    }
    bench.printResult(medianUs(&samples), cs, N * N_ITERS, @as(usize, @intCast(NOPS)), N_RUNS);
}
