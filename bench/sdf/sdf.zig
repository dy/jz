// sdf.zig — Zig port of the unchanged JavaScript workload.
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
const W = 384;
const H = 384;
const N_ITERS = 4;
const INF: f64 = 1e20;
fn buildBitmap(b: []u8) void {
    var s: u32 = 0x77aa123;
    @memset(b, 0);
    for (0..30) |c| {
        const cx: i32 = 20 + @as(i32, @intCast(next(&s) % (W - 40)));
        const cy: i32 = 20 + @as(i32, @intCast(next(&s) % (H - 40)));
        const r: i32 = 6 + @as(i32, @intCast(next(&s) % 25));
        const fill: u8 = if (c % 4 == 3) 0 else 1;
        var y = cy - r;
        while (y <= cy + r) : (y += 1) {
            const dy = y - cy;
            var x = cx - r;
            while (x <= cx + r) : (x += 1) {
                const dx = x - cx;
                if (dx * dx + dy * dy <= r * r) b[@intCast(y * W + x)] = fill;
            }
        }
    }
}
fn edt1d(f: []const f64, d: []f64, v: []i32, z: []f64, n: usize) void {
    var k: usize = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (1..n) |q| {
        const fq: f64 = @floatFromInt(q);
        var vi: usize = @intCast(v[k]);
        var middle = ((f[q] + @as(f64, @floatFromInt(q * q))) - (f[vi] + @as(f64, @floatFromInt(vi * vi)))) / (2.0 * fq - 2.0 * @as(f64, @floatFromInt(vi)));
        while (middle <= z[k]) {
            k -= 1;
            vi = @intCast(v[k]);
            middle = ((f[q] + @as(f64, @floatFromInt(q * q))) - (f[vi] + @as(f64, @floatFromInt(vi * vi)))) / (2.0 * fq - 2.0 * @as(f64, @floatFromInt(vi)));
        }
        k += 1;
        v[k] = @intCast(q);
        z[k] = middle;
        z[k + 1] = INF;
    }
    k = 0;
    for (0..n) |q| {
        while (z[k + 1] < @as(f64, @floatFromInt(q))) {
            k += 1;
        }
        const dq = @as(i32, @intCast(q)) - v[k];
        d[q] = @as(f64, @floatFromInt(dq * dq)) + f[@intCast(v[k])];
    }
}
fn transform(bmp: []const u8, dist: []f64, rowf: []f64, rowd: []f64, v: []i32, z: []f64) void {
    for (dist, 0..) |*d, i| d.* = if (bmp[i] == 1) 0 else INF;
    for (0..W) |x| {
        for (0..H) |y| rowf[y] = dist[y * W + x];
        edt1d(rowf, rowd, v, z, H);
        for (0..H) |y| dist[y * W + x] = rowd[y];
    }
    for (0..H) |y| {
        const off = y * W;
        for (0..W) |x| rowf[x] = dist[off + x];
        edt1d(rowf, rowd, v, z, W);
        for (0..W) |x| dist[off + x] = rowd[x];
    }
}
fn runKernel(bmp: []const u8, dist: []f64, rowf: []f64, rowd: []f64, v: []i32, z: []f64) void {
    for (0..N_ITERS) |_| transform(bmp, dist, rowf, rowd, v, z);
}
pub fn main() !void {
    const a = std.heap.page_allocator;
    const bmp = try a.alloc(u8, W * H);
    defer a.free(bmp);
    const dist = try a.alloc(f64, W * H);
    defer a.free(dist);
    const rowf = try a.alloc(f64, W);
    defer a.free(rowf);
    const rowd = try a.alloc(f64, W);
    defer a.free(rowd);
    const v = try a.alloc(i32, W);
    defer a.free(v);
    const z = try a.alloc(f64, W + 1);
    defer a.free(z);
    buildBitmap(bmp);
    for (0..N_WARMUP) |_| runKernel(bmp, dist, rowf, rowd, v, z);
    var samples: [N_RUNS]f64 = undefined;
    for (&samples) |*sample| {
        const t = bench.nowMs();
        runKernel(bmp, dist, rowf, rowd, v, z);
        sample.* = bench.nowMs() - t;
    }
    bench.printResult(medianUs(&samples), checksum(dist), W * H * N_ITERS, 2, N_RUNS);
}
