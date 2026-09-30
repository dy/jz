// trace.zig — Zig port of the unchanged JavaScript workload.
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
const W = 512;
const H = 512;
const N_ITERS = 4;
const MAXCODES = 1 << 18;
fn buildBitmap(b: []u8) void {
    var s: u32 = 0x51ce7a3;
    @memset(b, 0);
    for (0..42) |c| {
        const cx: i32 = 44 + @as(i32, @intCast(next(&s) % (W - 88)));
        const cy: i32 = 44 + @as(i32, @intCast(next(&s) % (H - 88)));
        const r: i32 = 8 + @as(i32, @intCast(next(&s) % 33));
        const fill: u8 = if (c % 5 == 4) 0 else 1;
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
fn traceLoop(bmp: []const u8, visited: []u8, codes: []u8, start: usize, sx: i32, sy: i32) usize {
    var nc = start;
    var x = sx;
    var y = sy;
    var dir: u8 = 3;
    var steps: usize = 0;
    while (steps < MAXCODES) : (steps += 1) {
        const inside = x >= 0 and x < W and y >= 0 and y < H and bmp[@intCast(y * W + x)] == 1;
        if (inside) {
            visited[@intCast(y * W + x)] = 1;
            dir = (dir + 3) & 3;
        } else {
            dir = (dir + 1) & 3;
        }
        if (nc < MAXCODES) {
            codes[nc] = dir;
            nc += 1;
        }
        if (dir == 0) {
            x += 1;
        } else if (dir == 1) {
            y += 1;
        } else if (dir == 2) {
            x -= 1;
        } else {
            y -= 1;
        }
        if (x == sx and y == sy and dir == 3) break;
    }
    return nc;
}
fn traceAll(bmp: []const u8, visited: []u8, codes: []u8) u32 {
    var nc: usize = 0;
    var hash: u32 = 0;
    @memset(visited, 0);
    for (1..H - 1) |y| {
        for (1..W - 1) |x| {
            if (bmp[y * W + x] == 1 and bmp[y * W + x - 1] == 0 and visited[y * W + x] == 0) {
                const start = nc;
                nc = traceLoop(bmp, visited, codes, nc, @intCast(x), @intCast(y));
                hash = mix(hash, @intCast(nc - start));
            }
        }
    }
    return mix(hash, @intCast(nc));
}
fn runKernel(bmp: []const u8, visited: []u8, codes: []u8) u32 {
    var hash: u32 = 0;
    for (0..N_ITERS) |_| hash = mix(hash, traceAll(bmp, visited, codes));
    return hash;
}
pub fn main() !void {
    const a = std.heap.page_allocator;
    const bmp = try a.alloc(u8, W * H);
    defer a.free(bmp);
    const visited = try a.alloc(u8, W * H);
    defer a.free(visited);
    const codes = try a.alloc(u8, MAXCODES);
    defer a.free(codes);
    @memset(codes, 0);
    buildBitmap(bmp);
    var acc: u32 = 0;
    for (0..N_WARMUP) |_| acc = mix(acc, runKernel(bmp, visited, codes));
    var samples: [N_RUNS]f64 = undefined;
    for (&samples) |*sample| {
        const t = bench.nowMs();
        acc = mix(acc, runKernel(bmp, visited, codes));
        sample.* = bench.nowMs() - t;
    }
    var hash = mix(0x811c9dc5, acc);
    var i: usize = 0;
    while (i < MAXCODES) : (i += 64) {
        hash = mix(hash, codes[i]);
    }
    bench.printResult(medianUs(&samples), hash, W * H * N_ITERS, 1, N_RUNS);
}
