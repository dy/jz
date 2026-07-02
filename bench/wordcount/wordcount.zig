// wordcount.zig — token-frequency counting into a string-keyed hash map, over
// a skewed synthetic word stream. The canonical associative text kernel (word
// counts, tag/label histograms, group-by aggregation). Zig's idiomatic answer
// is std.StringHashMap(i32) — the static reference for what the dynamic-keyed
// JS object costs. Counts are exact integers, so the probed totals are
// bit-identical across every engine and native target.
//
// Reports: median ms across N_RUNS, throughput in tokens/µs, FNV-1a checksum
// over the probed counts.
const std = @import("std");
const bench = @import("bench");

const NWORDS: usize = 512;     // distinct words in the vocabulary
const N: usize = 1 << 14;      // tokens per pass
const NPROBES: usize = 64;     // fixed lookups folded into the checksum
const N_ITERS: usize = 16;     // passes per kernel run
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

var words: [NWORDS][9]u8 = undefined;
var word_len: [NWORDS]usize = undefined;
var toks: [N]i32 = undefined;
var probe_buf: [NPROBES][9]u8 = undefined;
var probe_len: [NPROBES]usize = undefined;

// Deterministic vocabulary — 512 words of 3–8 lowercase chars from XorShift32,
// identical per target.
fn buildWords() void {
    var s: i32 = @bitCast(@as(u32, 0x1234abcd));
    var i: usize = 0;
    while (i < NWORDS) : (i += 1) {
        s ^= s << 13;
        s ^= @as(i32, @bitCast(@as(u32, @bitCast(s)) >> 17));
        s ^= s << 5;
        const len: usize = 3 + @as(usize, @intCast((@as(u32, @bitCast(s)) >> 8) % 6));
        var x: i32 = s;
        var j: usize = 0;
        while (j < len) : (j += 1) {
            x = @bitCast(@as(u32, @bitCast(x)) *% 0x9e3779b1 +% @as(u32, @truncate(j)));
            words[i][j] = @intCast(97 + (@as(u32, @bitCast(x)) >> 16) % 26);
        }
        word_len[i] = len;
    }
}

// Skewed token stream — half the traffic hits 16 hot words (Zipf-ish),
// the rest spreads over the whole vocabulary.
fn fillTokens() void {
    var s: i32 = @bitCast(@as(u32, 0x2545f491));
    var i: usize = 0;
    while (i < N) : (i += 1) {
        s ^= s << 13;
        s ^= @as(i32, @bitCast(@as(u32, @bitCast(s)) >> 17));
        s ^= s << 5;
        toks[i] = if ((s & 8) == 0)
            @intCast((@as(u32, @bitCast(s)) >> 4) & 15)
        else
            @intCast((@as(u32, @bitCast(s)) >> 4) & (NWORDS - 1));
    }
}

fn runKernel(allocator: std.mem.Allocator) !u32 {
    var h: u32 = 0x811c9dc5;
    var it: usize = 0;
    while (it < N_ITERS) : (it += 1) {
        var counts = std.StringHashMap(i32).init(allocator); // fresh map per pass
        defer counts.deinit();
        var i: usize = 0;
        while (i < N) : (i += 1) {
            const w = words[@intCast(toks[i])][0..word_len[@intCast(toks[i])]];
            const gop = try counts.getOrPut(w);
            if (!gop.found_existing) gop.value_ptr.* = 0;
            gop.value_ptr.* += 1;
        }
        var j: usize = 0;
        while (j < NPROBES) : (j += 1) {
            const p = probe_buf[j][0..probe_len[j]];
            h = mix(h, @bitCast(counts.get(p) orelse 0));
        }
    }
    return h;
}

pub fn main() !void {
    const allocator = std.heap.page_allocator;
    buildWords();
    fillTokens();
    // Probe every 8th word plus 8 absent keys — a missing count reads 0.
    var j: usize = 0;
    while (j < NPROBES - 8) : (j += 1) {
        const wi = (j * 8) & (NWORDS - 1);
        @memcpy(probe_buf[j][0..word_len[wi]], words[wi][0..word_len[wi]]);
        probe_len[j] = word_len[wi];
    }
    j = 0;
    while (j < 8) : (j += 1) {
        probe_buf[NPROBES - 8 + j][0] = 'z';
        probe_buf[NPROBES - 8 + j][1] = 'z';
        probe_buf[NPROBES - 8 + j][2] = @intCast('0' + j);
        probe_len[NPROBES - 8 + j] = 3;
    }

    var cs: u32 = 0;
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) cs = try runKernel(allocator);

    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = bench.nowMs();
        cs = try runKernel(allocator);
        samples[i] = bench.nowMs() - t0;
    }
    bench.printResult(medianUs(&samples), cs, N * N_ITERS, NWORDS, N_RUNS);
}
