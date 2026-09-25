// The same four-point Hermite interpolation as resample.js.
const std = @import("std");
const bench = @import("bench");

const N = 1 << 16;
const STEP_UP = 0.7317314443021356;
const STEP_DN = 1.3186248722190522;
const M_UP = 89000;
const M_DN = 49000;
const N_ITERS = 5;
const N_RUNS = 21;
const N_WARMUP = 5;

fn buildInput(input: []f64) void {
    var s: u32 = 0x6d2f4b1;
    for (input) |*x| {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        x.* = (@as(f64, @floatFromInt(s)) / 4294967296.0) * 2.0 - 1.0;
    }
}

fn resamplePass(input: []const f64, out: []f64, m: usize, step: f64) void {
    var phase: f64 = 1.0;
    for (0..m) |k| {
        const idx: usize = @intFromFloat(phase);
        const f = phase - @as(f64, @floatFromInt(idx));
        const x0 = input[idx - 1];
        const x1 = input[idx];
        const x2 = input[idx + 1];
        const x3 = input[idx + 2];
        const c0 = x1;
        const c1 = 0.5 * (x2 - x0);
        const c2 = x0 - 2.5 * x1 + 2.0 * x2 - 0.5 * x3;
        const c3 = 0.5 * (x3 - x0) + 1.5 * (x1 - x2);
        out[k] = ((c3 * f + c2) * f + c1) * f + c0;
        phase += step;
    }
}

fn runKernel(input: []const f64, up: []f64, dn: []f64) void {
    for (0..N_ITERS) |_| {
        resamplePass(input, up, M_UP, STEP_UP);
        resamplePass(up, dn, M_DN, STEP_DN);
    }
}

fn checksumF64(out: []const f64) u32 {
    var h: u32 = 0x811c9dc5;
    var i: usize = 0;
    while (i < out.len * 2) : (i += 256) {
        const bits: u64 = @bitCast(out[i / 2]);
        const word: u32 = @truncate(bits >> @as(u6, @intCast((i & 1) * 32)));
        h = (h ^ word) *% 0x01000193;
    }
    return h;
}

fn medianUs(samples: *[N_RUNS]f64) u64 {
    var i: usize = 1;
    while (i < samples.len) : (i += 1) {
        const v = samples[i];
        var j = i;
        while (j > 0 and samples[j - 1] > v) : (j -= 1) samples[j] = samples[j - 1];
        samples[j] = v;
    }
    return @intFromFloat(samples[(samples.len - 1) >> 1] * 1000.0);
}

pub fn main() !void {
    const allocator = std.heap.page_allocator;
    const input = try allocator.alloc(f64, N);
    defer allocator.free(input);
    const up = try allocator.alloc(f64, M_UP);
    defer allocator.free(up);
    const dn = try allocator.alloc(f64, M_DN);
    defer allocator.free(dn);
    buildInput(input);

    for (0..N_WARMUP) |_| runKernel(input, up, dn);
    var samples: [N_RUNS]f64 = undefined;
    for (&samples) |*sample| {
        const t0 = bench.nowMs();
        runKernel(input, up, dn);
        sample.* = bench.nowMs() - t0;
    }
    bench.printResult(medianUs(&samples), checksumF64(up) ^ checksumF64(dn), (M_UP + M_DN) * N_ITERS, 2, N_RUNS);
}
