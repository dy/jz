const std = @import("std");
const bench = @import("bench");

const W: i32 = 512;
const H: i32 = 512;
const R: i32 = 4;
const WIN: i32 = 2 * R + 1;
const N: usize = @as(usize, W * H * 4);
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

fn mkImage(out: []u8) void {
    var s: u32 = 0x1234abcd;
    for (out) |*x| {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        x.* = @truncate(s & 255);
    }
}

fn idx(i: i32) usize {
    return @intCast(i);
}

fn hblur(src: []const u8, dst: []u8, w: i32, h: i32, r: i32) void {
    const win = 2 * r + 1;
    var y: i32 = 0;
    while (y < h) : (y += 1) {
        const row = y * w;
        var x: i32 = 0;
        while (x < w) : (x += 1) {
            var sr: i32 = 0;
            var sg: i32 = 0;
            var sb: i32 = 0;
            var sa: i32 = 0;
            var k: i32 = -r;
            while (k <= r) : (k += 1) {
                var xi = x + k;
                if (xi < 0) xi = 0 else if (xi >= w) xi = w - 1;
                const p = idx((row + xi) << 2);
                sr += src[p];
                sg += src[p + 1];
                sb += src[p + 2];
                sa += src[p + 3];
            }
            const o = idx((row + x) << 2);
            dst[o] = @truncate(@as(u32, @intCast(@divTrunc(sr, win))));
            dst[o + 1] = @truncate(@as(u32, @intCast(@divTrunc(sg, win))));
            dst[o + 2] = @truncate(@as(u32, @intCast(@divTrunc(sb, win))));
            dst[o + 3] = @truncate(@as(u32, @intCast(@divTrunc(sa, win))));
        }
    }
}

fn vblur(src: []const u8, dst: []u8, w: i32, h: i32, r: i32) void {
    const win = 2 * r + 1;
    var y: i32 = 0;
    while (y < h) : (y += 1) {
        var x: i32 = 0;
        while (x < w) : (x += 1) {
            var sr: i32 = 0;
            var sg: i32 = 0;
            var sb: i32 = 0;
            var sa: i32 = 0;
            var k: i32 = -r;
            while (k <= r) : (k += 1) {
                var yi = y + k;
                if (yi < 0) yi = 0 else if (yi >= h) yi = h - 1;
                const p = idx((yi * w + x) << 2);
                sr += src[p];
                sg += src[p + 1];
                sb += src[p + 2];
                sa += src[p + 3];
            }
            const o = idx((y * w + x) << 2);
            dst[o] = @truncate(@as(u32, @intCast(@divTrunc(sr, win))));
            dst[o + 1] = @truncate(@as(u32, @intCast(@divTrunc(sg, win))));
            dst[o + 2] = @truncate(@as(u32, @intCast(@divTrunc(sb, win))));
            dst[o + 3] = @truncate(@as(u32, @intCast(@divTrunc(sa, win))));
        }
    }
}

pub fn main() !void {

    const allocator = std.heap.page_allocator;
    const img = try allocator.alloc(u8, N);
    defer allocator.free(img);
    const tmp = try allocator.alloc(u8, N);
    defer allocator.free(tmp);
    const out = try allocator.alloc(u8, N);
    defer allocator.free(out);
    var samples = [_]f64{0} ** N_RUNS;

    mkImage(img);
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) {
        hblur(img, tmp, W, H, R);
        vblur(tmp, out, W, H, R);
    }
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = bench.nowMs();
        hblur(img, tmp, W, H, R);
        vblur(tmp, out, W, H, R);
        samples[i] = bench.nowMs() - t0;
    }
    bench.printResult(medianUs(&samples), checksumU8(out), W * H, WIN, N_RUNS);
}
