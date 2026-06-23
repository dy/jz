// nqueens.zig — bitmask N-Queens solver, counting all solutions for a range of
// board sizes. The canonical backtracking / constraint-search kernel (the shape
// behind SAT solvers, puzzle search, combinatorial enumeration): deep recursion
// with a per-node branch over the available-columns bitmask, no array state. It
// stresses call/recursion codegen and branch prediction — a profile the suite's
// flat loops do not. Pure 32-bit integer, so the solution counts are
// bit-identical across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, recursion, bitwise ops, no
// class/async/regex.
//
// The board sizes are drawn from a runtime XorShift32 array rather than a literal
// loop bound: with literal sizes the whole recursion is a compile-time constant
// that clang/zig fold away (0 µs), making the native lane meaningless. Sourcing
// the size from runtime data is bit-identical across targets but forces every
// engine to actually run the search.
//
// Reports: median ms across N_RUNS, throughput in solutions/µs, FNV-1a checksum
// over the per-query solution counts.
const std = @import("std");
const bench = @import("bench");

const NMIN: i32 = 8;
const NSPAN: u32 = 4;
const NQ: usize = 20;
const N_RUNS = 21;
const N_WARMUP = 5;

fn mix(h: i32, x: i32) i32 {
    return @bitCast(@as(u32, @bitCast(h ^ x)) *% 0x01000193);
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

// Deterministic per-query board sizes — XorShift32, identical per target.
fn fillSizes(out: []i32) void {
    var s: i32 = @bitCast(@as(u32, 0x1234abcd));
    var q: usize = 0;
    while (q < NQ) : (q += 1) {
        s ^= s << 13;
        s ^= @bitCast(@as(u32, @bitCast(s)) >> 17);
        s ^= s << 5;
        out[q] = NMIN + @as(i32, @intCast(@as(u32, @bitCast(s)) % NSPAN));
    }
}

// Count placements that complete the board. `cols/d1/d2` are occupied-column and
// the two diagonal masks; `avail` isolates the legal squares of the current row,
// `b = avail & -avail` walks them lowest-bit first.
fn solve(all: i32, cols: i32, d1: i32, d2: i32) i32 {
    if (cols == all) return 1;
    var cnt: i32 = 0;
    var avail: i32 = all & ~(cols | d1 | d2);
    while (avail != 0) {
        const b: i32 = avail & (-%avail);
        avail = avail - b;
        cnt = cnt + solve(all, cols | b, (d1 | b) << 1, @bitCast(@as(u32, @bitCast(d2 | b)) >> 1));
    }
    return cnt;
}

fn countN(n: i32) i32 {
    return solve((@as(i32, 1) << @intCast(n)) - 1, 0, 0, 0);
}

fn runKernel(sizes: []const i32) u32 {
    var h: i32 = @bitCast(@as(u32, 0x811c9dc5));
    var q: usize = 0;
    while (q < NQ) : (q += 1) {
        h = mix(h, countN(sizes[q]));
    }
    return @bitCast(h);
}

pub fn main() !void {

    var sizes_arr = [_]i32{0} ** NQ;
    const sizes: []i32 = &sizes_arr;
    fillSizes(sizes);

    var total: i32 = 0;
    var q: usize = 0;
    while (q < NQ) : (q += 1) {
        total = total + countN(sizes[q]);
    }

    var cs: u32 = 0;
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) cs = runKernel(sizes);

    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = bench.nowMs();
        cs = runKernel(sizes);
        samples[i] = bench.nowMs() - t0;
    }
    bench.printResult(medianUs(&samples), cs, total, NMIN + NSPAN - 1, N_RUNS);
}
