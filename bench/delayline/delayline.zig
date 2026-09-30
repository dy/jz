// delayline.zig — Zig port of the unchanged JavaScript workload.
const std = @import("std");
const bench = @import("bench");
const N_RUNS = 21;
const N_WARMUP = 5;
fn next(s: *u32) u32 {
    s.* ^= s.* << 13;
    s.* ^= s.* >> 17;
    s.* ^= s.* << 5;
    return s.*;
}
fn mix(acc: u32, value: u32) u32 {
    return (acc ^ value) *% 0x01000193;
}
fn checksum(out: []const f64) u32 {
    var hash: u32 = 0x811c9dc5;
    var i: usize = 0;
    while (i < out.len * 2) : (i += 256) {
        const bits: u64 = @bitCast(out[i / 2]);
        const word: u32 = if (i & 1 == 0) @truncate(bits) else @truncate(bits >> 32);
        hash = mix(hash, word);
    }
    return hash;
}
fn medianUs(samples: *[N_RUNS]f64) u64 {
    var i: usize = 1;
    while (i < samples.len) : (i += 1) {
        const value = samples[i];
        var j = i;
        while (j > 0 and samples[j - 1] > value) : (j -= 1) {
            samples[j] = samples[j - 1];
        }
        samples[j] = value;
    }
    return @intFromFloat(samples[(samples.len - 1) >> 1] * 1000.0);
}
const N = 1 << 17;
const RB = 1 << 14;
const MASK = RB - 1;
const N_ITERS = 4;
fn runPass(input: []const f64, out: []f64, ring: []f64, fb: f64, lfoStep: u32) void {
    @memset(ring, 0);
    var head: u32 = 0;
    var lfo: u32 = 0;
    for (0..N) |i| {
        lfo +%= lfoStep;
        const raw = lfo & 0x1ffff;
        const tri = if (raw < 0x10000) raw else 0x20000 - raw;
        const dq = 96 * 65536 + tri * 2000;
        const dInt = dq / 65536;
        const dFrac = @as(f64, @floatFromInt(dq - dInt * 65536)) / 65536.0;
        const tap0 = (head -% dInt) & MASK;
        const tap1 = (head -% dInt -% 1) & MASK;
        const tap = ring[tap0] + (ring[tap1] - ring[tap0]) * dFrac;
        const y = input[i] + tap * fb;
        ring[head & MASK] = y;
        head +%= 1;
        out[i] = y;
    }
}
fn runKernel(input: []const f64, out: []f64, ring: []f64) void {
    for (0..N_ITERS) |it| runPass(input, out, ring, 0.6 + @as(f64, @floatFromInt(it)) * 0.05, 977 + @as(u32, @intCast(it)) * 131);
}
pub fn main() !void {
    const a = std.heap.page_allocator;
    const input = try a.alloc(f64, N);
    defer a.free(input);
    const out = try a.alloc(f64, N);
    defer a.free(out);
    const ring = try a.alloc(f64, RB);
    defer a.free(ring);
    var s: u32 = 0x3c91e57;
    for (input) |*v| v.* = @as(f64, @floatFromInt(next(&s))) / 4294967296.0 * 2.0 - 1.0;
    for (0..N_WARMUP) |_| runKernel(input, out, ring);
    var samples: [N_RUNS]f64 = undefined;
    for (&samples) |*sample| {
        const t = bench.nowMs();
        runKernel(input, out, ring);
        sample.* = bench.nowMs() - t;
    }
    bench.printResult(medianUs(&samples), checksum(out), N * N_ITERS, N_ITERS, N_RUNS);
}
