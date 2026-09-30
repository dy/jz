// glyfparse.zig — Zig port of the unchanged JavaScript workload.
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
const NG = 600;
const MAXPTS = 120;
const STREAM_CAP = 1 << 19;
const N_ITERS = 12;
fn buildStream(stream: []u8, offset: []i32, points: []i32) void {
    var s: u32 = 0x8e1d3a5;
    var pos: usize = 0;
    var flags: [MAXPTS]u8 = undefined;
    for (0..NG) |g| {
        offset[g] = @intCast(pos);
        const np: usize = 20 + next(&s) % (MAXPTS - 20 + 1);
        points[g] = @intCast(np);
        for (0..np) |p| {
            const dx = next(&s) % 3;
            const dy = next(&s) % 3;
            var f: u8 = @intCast(next(&s) & 1);
            if (dx == 0) {
                f |= 0x02 | @as(u8, @intCast((next(&s) & 1) << 4));
            } else if (dx == 2) {
                f |= 0x10;
            }
            if (dy == 0) {
                f |= 0x04 | @as(u8, @intCast((next(&s) & 1) << 5));
            } else if (dy == 2) {
                f |= 0x20;
            }
            flags[p] = f;
        }
        var p: usize = 0;
        while (p < np) {
            var run: usize = 1;
            while (p + run < np and flags[p + run] == flags[p] and run < 255) {
                run += 1;
            }
            if (run > 1) {
                stream[pos] = flags[p] | 0x08;
                pos += 1;
                stream[pos] = @intCast(run - 1);
                pos += 1;
            } else {
                stream[pos] = flags[p];
                pos += 1;
            }
            p += run;
        }
        for (0..np) |point| {
            const f = flags[point];
            if (f & 0x02 != 0) {
                stream[pos] = @intCast(next(&s) % 256);
                pos += 1;
            } else if (f & 0x10 == 0) {
                const d = next(&s) & 0xffff;
                stream[pos] = @intCast(d >> 8);
                stream[pos + 1] = @truncate(d);
                pos += 2;
            }
        }
        for (0..np) |point| {
            const f = flags[point];
            if (f & 0x04 != 0) {
                stream[pos] = @intCast(next(&s) % 256);
                pos += 1;
            } else if (f & 0x20 == 0) {
                const d = next(&s) & 0xffff;
                stream[pos] = @intCast(d >> 8);
                stream[pos + 1] = @truncate(d);
                pos += 2;
            }
        }
    }
}
fn parseAll(stream: []const u8, offset: []const i32, points: []const i32, flags: []u8) u32 {
    var hash: u32 = 0x811c9dc5;
    for (0..NG) |g| {
        var pos: usize = @intCast(offset[g]);
        const np: usize = @intCast(points[g]);
        var p: usize = 0;
        while (p < np) {
            const f = stream[pos];
            pos += 1;
            flags[p] = f;
            p += 1;
            if (f & 0x08 != 0) {
                var rep = stream[pos];
                pos += 1;
                while (rep > 0) {
                    flags[p] = f;
                    p += 1;
                    rep -= 1;
                }
            }
        }
        var x: i32 = 0;
        var onCount: u32 = 0;
        for (0..np) |i| {
            const f = flags[i];
            if (f & 0x02 != 0) {
                const d: i32 = stream[pos];
                pos += 1;
                if (f & 0x10 != 0) {
                    x += d;
                } else {
                    x -= d;
                }
            } else if (f & 0x10 == 0) {
                const raw = (@as(u16, stream[pos]) << 8) | stream[pos + 1];
                x += @as(i16, @bitCast(raw));
                pos += 2;
            }
            hash = mix(hash, @bitCast(x));
            onCount += f & 1;
        }
        var y: i32 = 0;
        for (0..np) |i| {
            const f = flags[i];
            if (f & 0x04 != 0) {
                const d: i32 = stream[pos];
                pos += 1;
                if (f & 0x20 != 0) {
                    y += d;
                } else {
                    y -= d;
                }
            } else if (f & 0x20 == 0) {
                const raw = (@as(u16, stream[pos]) << 8) | stream[pos + 1];
                y += @as(i16, @bitCast(raw));
                pos += 2;
            }
            hash = mix(hash, @bitCast(y));
        }
        hash = mix(hash, onCount);
    }
    return hash;
}
fn runKernel(stream: []const u8, offset: []const i32, points: []const i32, flags: []u8) u32 {
    var hash: u32 = 0;
    for (0..N_ITERS) |_| hash = mix(hash, parseAll(stream, offset, points, flags));
    return hash;
}
pub fn main() !void {
    const a = std.heap.page_allocator;
    const stream = try a.alloc(u8, STREAM_CAP);
    defer a.free(stream);
    const flags = try a.alloc(u8, MAXPTS);
    defer a.free(flags);
    const offset = try a.alloc(i32, NG);
    defer a.free(offset);
    const points = try a.alloc(i32, NG);
    defer a.free(points);
    buildStream(stream, offset, points);
    var acc: u32 = 0;
    for (0..N_WARMUP) |_| acc = mix(acc, runKernel(stream, offset, points, flags));
    var samples: [N_RUNS]f64 = undefined;
    for (&samples) |*sample| {
        const t = bench.nowMs();
        acc = mix(acc, runKernel(stream, offset, points, flags));
        sample.* = bench.nowMs() - t;
    }
    bench.printResult(medianUs(&samples), acc, NG * N_ITERS, 1, N_RUNS);
}
