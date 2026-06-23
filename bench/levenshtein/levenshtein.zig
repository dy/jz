// levenshtein.zig — Levenshtein edit distance via the rolling-row dynamic program.
// The canonical sequence-alignment / fuzzy-match kernel (spell-check, diff,
// bioinformatics, search): a 2-D DP whose every cell is min(delete, insert,
// substitute) over integers, with a diagonal data dependency that no target can
// vectorize — a branch- and min-reduction-heavy access pattern distinct from the
// suite's other loops. Pure 32-bit integer, so the distance is bit-identical
// across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Uint8Array/Int32Array, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in DP-cells/µs, FNV-1a checksum
// over the per-iteration distances.
const std = @import("std");
const bench = @import("bench");

const LA = 512;
const LB = 512;
const ALPHA = 8;
const N_ITERS = 8;
const N_RUNS = 21;
const N_WARMUP = 5;

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

fn fill(out: []u8, n: usize, seed: u32) void {
    var s: u32 = seed;
    var i: usize = 0;
    while (i < n) : (i += 1) {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        out[i] = @intCast(s % ALPHA);
    }
}

fn levenshtein(a: []const u8, b: []const u8, prev: []i32) i32 {
    var j: usize = 0;
    while (j <= LB) : (j += 1) prev[j] = @intCast(j);
    var i: usize = 1;
    while (i <= LA) : (i += 1) {
        var diag: i32 = prev[0];
        prev[0] = @intCast(i);
        const ai = a[i - 1];
        j = 1;
        while (j <= LB) : (j += 1) {
            const up: i32 = prev[j];
            const cost: i32 = if (ai == b[j - 1]) 0 else 1;
            const sub: i32 = diag + cost;
            var m: i32 = up + 1;
            const ins: i32 = prev[j - 1] + 1;
            if (ins < m) m = ins;
            if (sub < m) m = sub;
            diag = up;
            prev[j] = m;
        }
    }
    return prev[LB];
}

fn runKernel(a: []u8, b: []const u8, prev: []i32) u32 {
    var h: u32 = 0x811c9dc5;
    var it: usize = 0;
    while (it < N_ITERS) : (it += 1) {
        const j = it % LA;
        a[j] = @intCast((@as(u32, a[j]) + 1) % ALPHA);
        const dist: i32 = levenshtein(a, b, prev);
        h = mix(h, @bitCast(dist));
    }
    return h;
}

pub fn main() !void {

    const allocator = std.heap.page_allocator;
    const a = try allocator.alloc(u8, LA);
    const b = try allocator.alloc(u8, LB);
    const prev = try allocator.alloc(i32, LB + 1);
    defer allocator.free(a);
    defer allocator.free(b);
    defer allocator.free(prev);

    fill(a, LA, 0x1234abcd);
    fill(b, LB, 0x9e3779b9);

    var cs: u32 = 0;
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) cs = runKernel(a, b, prev);

    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = bench.nowMs();
        cs = runKernel(a, b, prev);
        samples[i] = bench.nowMs() - t0;
    }
    bench.printResult(medianUs(&samples), cs, LA * LB * N_ITERS, 2, N_RUNS);
}
