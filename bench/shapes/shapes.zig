// shapes.zig — a per-variant measure summed over records of 8 heterogeneous
// shapes, in data-shuffled order. The canonical shape-polymorphism kernel
// (JSON rows, AST nodes, ECS entities, event streams). Zig's idiomatic answer
// to heterogeneous records is a tagged union + switch — the static reference
// for what the dynamic-shape JS source costs. Pure 32-bit integer fields, so
// the sum is bit-identical across every engine and native target.
//
// Reports: median ms across N_RUNS, throughput in records/µs, FNV-1a checksum
// over the per-pass sums.
const std = @import("std");
const bench = @import("bench");

const N: usize = 1 << 14;      // records
const NSHAPES: i32 = 8;        // distinct record shapes
const N_ITERS: usize = 48;     // record-stream passes per kernel run
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

const Rec = union(enum) {
    point: struct { x: i32, y: i32 },
    circle: struct { r: i32 },
    rect: struct { w: i32, h: i32 },
    line: struct { x0: i32, y0: i32, x1: i32, y1: i32 },
    tri: struct { a: i32, b: i32, c: i32 },
    prism: struct { w: i32, h: i32, d: i32 },
    arc: struct { r: i32, s: i32 },
    poly: struct { n: i32, s: i32 },
};

var rows: [N]Rec = undefined;

// Deterministic heterogeneous record stream — XorShift32 picks each record's
// variant and integer fields (masked small, so every product stays exact i32).
fn initRows() void {
    var s: u32 = 0x1234abcd;
    var i: usize = 0;
    while (i < N) : (i += 1) {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        const k: u32 = s & 7; // s & (NSHAPES - 1): low 3 bits, sign-free
        const a: i32 = @intCast((s >> 3) & 1023);
        const b: i32 = @intCast((s >> 13) & 1023);
        const c: i32 = @intCast((s >> 23) & 511);
        rows[i] = switch (k) {
            0 => Rec{ .point = .{ .x = a, .y = b } },
            1 => Rec{ .circle = .{ .r = a } },
            2 => Rec{ .rect = .{ .w = a, .h = b } },
            3 => Rec{ .line = .{ .x0 = a, .y0 = b, .x1 = c, .y1 = (a ^ b) & 511 } },
            4 => Rec{ .tri = .{ .a = a, .b = b, .c = c } },
            5 => Rec{ .prism = .{ .w = a, .h = b, .d = c } },
            6 => Rec{ .arc = .{ .r = a, .s = b } },
            else => Rec{ .poly = .{ .n = c, .s = b } },
        };
    }
}

// One measure per variant — mirrors shapes.js measure() exactly.
fn measure(o: *const Rec) i32 {
    return switch (o.*) {
        .point => |p| p.x + p.y,
        .circle => |p| p.r * (p.r * 3),
        .rect => |p| p.w * p.h,
        .line => |p| blk: {
            const dx = p.x1 - p.x0;
            const dy = p.y1 - p.y0;
            break :blk (if (dx < 0) -dx else dx) + (if (dy < 0) -dy else dy);
        },
        .tri => |p| p.a + p.b + p.c,
        .prism => |p| p.w * p.h - p.d,
        .arc => |p| p.r * p.s + p.r,
        .poly => |p| p.n * (p.s * p.s),
    };
}

fn runKernel() u32 {
    var h: u32 = 0x811c9dc5;
    var it: usize = 0;
    while (it < N_ITERS) : (it += 1) {
        var sum: i32 = @intCast(it);
        var i: usize = 0;
        while (i < N) : (i += 1) {
            sum = @bitCast(@as(u32, @bitCast(sum)) +% @as(u32, @bitCast(measure(&rows[i]))));
        }
        h = mix(h, @bitCast(sum));
    }
    return h;
}

pub fn main() !void {
    initRows();

    var cs: u32 = 0;
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) cs = runKernel();

    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = bench.nowMs();
        cs = runKernel();
        samples[i] = bench.nowMs() - t0;
    }
    bench.printResult(medianUs(&samples), cs, N * N_ITERS, @as(usize, @intCast(NSHAPES)), N_RUNS);
}
