const std = @import("std");
const bench = @import("bench");

const W: usize = 512;
const H: usize = 512;
const N: usize = W * H * 4;
const A: i32 = 160;
const IA: i32 = 255 - A;
const N_RUNS = 21;
const N_WARMUP = 5;

fn mix(h: u32, x: u32) u32 {
    return (h ^ x) *% 0x01000193;
}

fn checksumU8(out: []const u8) u32 {
    var h: u32 = 0x811c9dc5;
    for (out) |b| h = mix(h, b);
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
    return @as(u64, @intFromFloat(samples[(samples.len - 1) >> 1] * 1000.0));
}

fn mkImage(out: []u8, seed: u32) void {
    var s: u32 = seed;
    for (out) |*x| {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        x.* = @truncate(s & 255);
    }
}

fn blend(src: []const u8, dst: []const u8, out: []u8) void {
    var i: usize = 0;
    while (i < N) : (i += 1) {
        const v = (@as(i32, src[i]) * A + @as(i32, dst[i]) * IA + 127) >> 8;
        out[i] = @truncate(@as(u32, @intCast(v)));
    }
}

pub fn main() !void {

    const allocator = std.heap.page_allocator;
    const src = try allocator.alloc(u8, N);
    const dst = try allocator.alloc(u8, N);
    const out = try allocator.alloc(u8, N);
    defer allocator.free(src);
    defer allocator.free(dst);
    defer allocator.free(out);
    var samples = [_]f64{0} ** N_RUNS;

    mkImage(src, 0x1234abcd);
    mkImage(dst, 0x7e1f93b5);
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) blend(src, dst, out);
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = bench.nowMs();
        blend(src, dst, out);
        samples[i] = bench.nowMs() - t0;
    }
    bench.printResult(medianUs(&samples), checksumU8(out), N, 1, N_RUNS);
}
