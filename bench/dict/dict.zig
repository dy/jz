// dict.zig — open-addressing hash table (build + probe) with linear probing. The
// canonical associative-container kernel (symbol tables, dedup, joins, counting):
// a multiply-shift hash scatters keys across a power-of-two slot array, and every
// insert/lookup walks a probe chain of branchy comparisons. It stresses
// scatter writes, dependent-load gather, and unpredictable branches — the
// hash-table shape no other case in the suite covers. Pure 32-bit integer, so the
// looked-up values are bit-identical across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Int32Array, Math.imul, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in ops/µs, FNV-1a checksum over
// the probe results.
const std = @import("std");
const bench = @import("bench");

const CAP: usize = 1 << 14;    // slot count (power of two) → mask = CAP-1
const MASK: u32 = CAP - 1;
const NKEYS: usize = CAP >> 1; // 8192 keys → load factor 0.5
const EMPTY: i32 = -1;         // sentinel; keys are forced non-negative so never collide
const N_ITERS: usize = 60;     // build+probe passes per kernel run
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

// FNV-1a mix — wrapping i32 multiply matching Math.imul semantics, result reinterpreted as i32
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
// JS: s ^= s << 13; s ^= s >>> 17; s ^= s << 5; out[i] = (s >>> 0) & 0x7fffffff
fn fillSrc(out: []i32) void {
    var s: u32 = 0x1234abcd;
    var i: usize = 0;
    while (i < NKEYS) : (i += 1) {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        out[i] = @bitCast(s & 0x7fffffff);
    }
}

// hash(k) = (Math.imul(k, 0x9e3779b1) >>> 0) & MASK
// Math.imul treats both as signed i32 but result is wrapping u32 via >>> 0
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

fn tableLookup(keys: []i32, vals: []i32, k: i32) i32 {
    var h = hashKey(k);
    while (keys[h] != EMPTY) {
        if (keys[h] == k) return vals[h];
        h = (h + 1) & @as(usize, MASK);
    }
    return -1;
}

fn runKernel(keys: []i32, vals: []i32, src: []i32) u32 {
    // h starts as 0x811c9dc5 | 0 in JS → signed i32 = -2128831035
    var h: i32 = @bitCast(@as(u32, 0x811c9dc5));
    var it: usize = 0;
    while (it < N_ITERS) : (it += 1) {
        // clear table: keys[i] = EMPTY for all slots
        var ci: usize = 0;
        while (ci < CAP) : (ci += 1) keys[ci] = EMPTY;

        // insert: insert(keys, vals, src[i], (src[i] + it) | 0)
        // (src[i] + it) | 0  is i32 wrapping add (it fits in i32 safely for it < 60)
        var i: usize = 0;
        while (i < NKEYS) : (i += 1) {
            const v: i32 = src[i] +% @as(i32, @intCast(it));
            tableInsert(keys, vals, src[i], v);
        }

        // probe: lookup(keys, vals, src[(i * 7) & (NKEYS - 1)])
        // mix(h, v | 0) — v is i32 from Int32Array, | 0 is no-op
        i = 0;
        while (i < NKEYS) : (i += 1) {
            const idx = (i * 7) & (NKEYS - 1);
            const v = tableLookup(keys, vals, src[idx]);
            h = mix(h, v);
        }
    }
    // return h >>> 0  (convert signed i32 to unsigned u32)
    return @bitCast(h);
}

pub fn main() !void {

    const allocator = std.heap.page_allocator;
    const keys = try allocator.alloc(i32, CAP);
    const vals = try allocator.alloc(i32, CAP);
    const src = try allocator.alloc(i32, NKEYS);
    defer allocator.free(keys);
    defer allocator.free(vals);
    defer allocator.free(src);

    fillSrc(src);

    var cs: u32 = 0;
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) cs = runKernel(keys, vals, src);

    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = bench.nowMs();
        cs = runKernel(keys, vals, src);
        samples[i] = bench.nowMs() - t0;
    }
    // printResult(medianUs, cs, NKEYS * N_ITERS, 2, N_RUNS)
    bench.printResult(medianUs(&samples), cs, NKEYS * N_ITERS, 2, N_RUNS);
}
