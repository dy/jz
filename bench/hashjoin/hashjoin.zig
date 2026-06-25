// hashjoin.zig — probe-dominated relational hash join (build a hash table on a small
// "build" relation, then stream a large "probe" relation through it and sum matched
// payloads). The kernel at the heart of every database and dataframe engine. Pure
// 32-bit integer — the matched-payload sum is bit-identical across every engine and
// native target.
//
// Reports: median ms across N_RUNS, throughput in probes/µs, FNV-1a checksum over
// the per-pass match sums.
const std = @import("std");
const bench = @import("bench");

const CAP: usize = 1 << 14;    // slot count (power of two) → mask = CAP-1
const MASK: u32 = CAP - 1;
const BUILD: usize = CAP >> 1; // 8192 build rows → load factor 0.5
const PROBE: usize = 1 << 16;  // 65536 probe rows — probe-dominated
const EMPTY: i32 = -1;         // sentinel; keys forced non-negative so never collide
const N_ITERS: usize = 24;     // build+probe passes per kernel run
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

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

// Deterministic positive keys — XorShift32 masked to 31 bits, identical per target.
fn fill(out: []i32, seed: u32) void {
    var s: u32 = seed;
    var i: usize = 0;
    while (i < out.len) : (i += 1) {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        out[i] = @bitCast(s & 0x7fffffff);
    }
}

fn hashKey(k: i32) usize {
    const uk: u32 = @bitCast(k);
    return @intCast((uk *% 0x9e3779b1) & MASK);
}

fn tableInsert(keys: []i32, vals: []i32, k: i32, v: i32) void {
    var h = hashKey(k);
    while (keys[h] != EMPTY) {
        if (keys[h] == k) { vals[h] = v; return; }
        h = (h + 1) & @as(usize, MASK);
    }
    keys[h] = k;
    vals[h] = v;
}

fn tableProbe(keys: []i32, vals: []i32, k: i32) i32 {
    var h = hashKey(k);
    while (keys[h] != EMPTY) {
        if (keys[h] == k) return vals[h];
        h = (h + 1) & @as(usize, MASK);
    }
    return 0;
}

fn runKernel(keys: []i32, vals: []i32, build: []i32, probes: []i32) u32 {
    var h: i32 = @bitCast(@as(u32, 0x811c9dc5));
    var it: usize = 0;
    while (it < N_ITERS) : (it += 1) {
        var ci: usize = 0;
        while (ci < CAP) : (ci += 1) keys[ci] = EMPTY;

        var i: usize = 0;
        while (i < BUILD) : (i += 1) {
            const v: i32 = build[i] +% @as(i32, @intCast(it));
            tableInsert(keys, vals, build[i], v);
        }

        var sum: i32 = 0;
        i = 0;
        while (i < PROBE) : (i += 1) {
            sum = sum +% tableProbe(keys, vals, probes[i]);
        }
        h = mix(h, sum);
    }
    return @bitCast(h);
}

pub fn main() !void {
    const allocator = std.heap.page_allocator;
    const keys = try allocator.alloc(i32, CAP);
    const vals = try allocator.alloc(i32, CAP);
    const build = try allocator.alloc(i32, BUILD);
    const probes = try allocator.alloc(i32, PROBE);
    defer allocator.free(keys);
    defer allocator.free(vals);
    defer allocator.free(build);
    defer allocator.free(probes);

    fill(build, 0x1234abcd);
    fill(probes, 0x9e3779b9);
    var i: usize = 0;
    while (i < PROBE) : (i += 2) probes[i] = build[(i >> 1) & (BUILD - 1)];

    var cs: u32 = 0;
    i = 0;
    while (i < N_WARMUP) : (i += 1) cs = runKernel(keys, vals, build, probes);

    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = bench.nowMs();
        cs = runKernel(keys, vals, build, probes);
        samples[i] = bench.nowMs() - t0;
    }
    bench.printResult(medianUs(&samples), cs, PROBE * N_ITERS, 2, N_RUNS);
}
