// strbuild.zig — per-record string formatting: render each integer record as a
// CSV-ish line (`id,name,value\n`), fold its chars, discard. The canonical
// serialization inner loop (loggers, exporters, code generators, row writers).
// Zig formats into a stack buffer with std.fmt.bufPrint — the value-semantics
// mirror of the JS per-row string temporaries. Pure ASCII and integer data, so
// the folded chars are bit-identical across every engine and native target.
//
// Reports: median ms across N_RUNS, throughput in rows/µs, FNV-1a checksum
// over every formatted line's characters.
const std = @import("std");
const bench = @import("bench");

const N: usize = 4096;         // rows per pass
const N_ITERS: usize = 4;      // passes per kernel run
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

const NAMES = [16][]const u8{ "alpha", "bravo", "carol", "delta", "echo", "fox", "golf", "hotel", "india", "jazz", "kilo", "lima", "mike", "nova", "oscar", "papa" };

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

// Deterministic row stream — XorShift32, identical per target; low bits pick
// the name, the rest is the (signed) value column.
fn fill(code: []i32, vals: []i32) void {
    var s: i32 = @bitCast(@as(u32, 0x1234abcd));
    var i: usize = 0;
    while (i < N) : (i += 1) {
        s ^= s << 13;
        s ^= @as(i32, @bitCast(@as(u32, @bitCast(s)) >> 17));
        s ^= s << 5;
        code[i] = s & 15;
        vals[i] = s >> 4;
    }
}

fn runKernel(code: []i32, vals: []i32) u32 {
    var h: u32 = 0x811c9dc5;
    var buf: [64]u8 = undefined;
    var it: usize = 0;
    while (it < N_ITERS) : (it += 1) {
        var i: usize = 0;
        while (i < N) : (i += 1) {
            const v = vals[i] +% @as(i32, @intCast(it));
            const line = std.fmt.bufPrint(&buf, "{d},{s},{d}\n", .{ i, NAMES[@intCast(code[i])], v }) catch unreachable;
            for (line) |ch| h = mix(h, ch);
        }
    }
    return h;
}

pub fn main() !void {
    const allocator = std.heap.page_allocator;
    const code = try allocator.alloc(i32, N);
    const vals = try allocator.alloc(i32, N);
    defer allocator.free(code);
    defer allocator.free(vals);

    fill(code, vals);

    var cs: u32 = 0;
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) cs = runKernel(code, vals);

    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = bench.nowMs();
        cs = runKernel(code, vals);
        samples[i] = bench.nowMs() - t0;
    }
    bench.printResult(medianUs(&samples), cs, N * N_ITERS, 3, N_RUNS);
}
