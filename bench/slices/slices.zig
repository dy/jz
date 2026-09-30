// slices.zig — Zig port of the unchanged JavaScript workload.
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
const N = 1 << 18;
const NB = 4096;
const N_ITERS = 3;
fn buildWorld(input: []f64, bus: []f64, inOff: []i32, busOff: []i32, length: []i32) void {
    var s: u32 = 0x2f6e2b1;
    for (input) |*v| v.* = @as(f64, @floatFromInt(next(&s))) / 4294967296.0 * 2.0 - 1.0;
    @memset(bus, 0);
    for (0..NB) |b| {
        const len = 64 + next(&s) % 257;
        length[b] = @intCast(len);
        inOff[b] = @intCast(next(&s) % (N - len));
        busOff[b] = @intCast(next(&s) % (N - len));
    }
}
fn runPass(input: []const f64, bus: []f64, inOff: []const i32, busOff: []const i32, length: []const i32, gain: f64) void {
    for (0..NB) |b| {
        const io: usize = @intCast(inOff[b]);
        const bo: usize = @intCast(busOff[b]);
        const len: usize = @intCast(length[b]);
        var sm: f64 = 0;
        for (0..len) |i| {
            sm = sm * 0.995 + input[io + i] * 0.005;
            bus[bo + i] = bus[bo + i] + sm * gain;
        }
    }
}
fn runKernel(input: []const f64, bus: []f64, inOff: []const i32, busOff: []const i32, length: []const i32) void {
    for (0..N_ITERS) |it| runPass(input, bus, inOff, busOff, length, 0.25 + @as(f64, @floatFromInt(it)) * 0.125);
}
pub fn main() !void {
    const a = std.heap.page_allocator;
    const input = try a.alloc(f64, N);
    defer a.free(input);
    const bus = try a.alloc(f64, N);
    defer a.free(bus);
    const inOff = try a.alloc(i32, NB);
    defer a.free(inOff);
    const busOff = try a.alloc(i32, NB);
    defer a.free(busOff);
    const length = try a.alloc(i32, NB);
    defer a.free(length);
    buildWorld(input, bus, inOff, busOff, length);
    for (0..N_WARMUP) |_| runKernel(input, bus, inOff, busOff, length);
    var samples: [N_RUNS]f64 = undefined;
    for (&samples) |*sample| {
        const t = bench.nowMs();
        runKernel(input, bus, inOff, busOff, length);
        sample.* = bench.nowMs() - t;
    }
    bench.printResult(medianUs(&samples), checksum(bus), NB * N_ITERS, N_ITERS, N_RUNS);
}
