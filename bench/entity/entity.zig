const std = @import("std");
const bench = @import("bench");

const N: usize = 1 << 16;
const STEPS: usize = 256;
const DT: f64 = 0.015625;
const G: f64 = -9.8;
const N_RUNS = 21;
const N_WARMUP = 5;

const Entity = struct { x: f64, y: f64, vx: f64, vy: f64 };

fn mix(h: u32, x: u32) u32 {
    return (h ^ x) *% 0x01000193;
}

fn checksumF64(out: []const f64) u32 {
    var h: u32 = 0x811c9dc5;
    var i: usize = 0;
    while (i < out.len * 2) : (i += 256) {
        const bits: u64 = @as(u64, @bitCast(out[i / 2]));
        const w: u32 = if ((i & 1) == 0) @as(u32, @truncate(bits)) else @as(u32, @truncate(bits >> 32));
        h = mix(h, w);
    }
    return h;
}

fn seedState(ps: []Entity) void {
    var s: u32 = 0x1234abcd;
    for (ps) |*p| {
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        p.x = @as(f64, @floatFromInt(s)) / 4294967296.0 * 2.0 - 1.0;
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        p.y = @as(f64, @floatFromInt(s)) / 4294967296.0 * 2.0 - 1.0;
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        p.vx = @as(f64, @floatFromInt(s)) / 4294967296.0 * 2.0 - 1.0;
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        p.vy = @as(f64, @floatFromInt(s)) / 4294967296.0 * 2.0 - 1.0;
    }
}

fn step(ps: []Entity) void {
    for (ps) |*p| {
        const nvy = p.vy + G * DT;
        p.x = p.x + p.vx * DT;
        p.y = p.y + nvy * DT;
        p.vy = nvy;
    }
}

fn run(ps: []Entity) void {
    var f: usize = 0;
    while (f < STEPS) : (f += 1) step(ps);
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

pub fn main() !void {
    const allocator = std.heap.page_allocator;
    const ps = try allocator.alloc(Entity, N);
    const px = try allocator.alloc(f64, N);
    const py = try allocator.alloc(f64, N);
    defer allocator.free(ps);
    defer allocator.free(px);
    defer allocator.free(py);
    var samples = [_]f64{0} ** N_RUNS;

    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) {
        seedState(ps);
        run(ps);
    }
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        seedState(ps);
        const t0 = bench.nowMs();
        run(ps);
        samples[i] = bench.nowMs() - t0;
    }
    for (ps, 0..) |p, k| {
        px[k] = p.x;
        py[k] = p.y;
    }
    const cs = checksumF64(py) ^ checksumF64(px);
    bench.printResult(medianUs(&samples), cs, N * STEPS, STEPS, N_RUNS);
}
