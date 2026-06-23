// sieve.zig — Sieve of Eratosthenes over a byte array up to LIMIT. The canonical
// number-theory / enumeration kernel: for each prime, a strided inner loop writes
// a composite flag at i², i²+i, i²+2i, … The access pattern is pure strided
// scatter guarded by an outer branch (skip already-composite i), a memory profile
// distinct from the suite's dense contiguous loops. Pure integer, so the sieved
// bitmap is bit-identical across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Uint8Array, no class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in numbers/µs, FNV-1a checksum over
// the composite bitmap.
const std = @import("std");
const Io = std.Io;

const LIMIT: usize = 1 << 20;
const N_ITERS: usize = 6;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

fn nowMs() f64 {
    var ts: std.c.timespec = undefined;
    _ = std.c.clock_gettime(std.c.CLOCK.MONOTONIC, &ts);
    return @as(f64, @floatFromInt(ts.sec)) * 1000.0 + @as(f64, @floatFromInt(ts.nsec)) / 1_000_000.0;
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

// FNV-1a checksum over every byte (matches checksumU8 in benchlib.js).
// h = imul(h ^ byte, 0x01000193) as i32, return h >>> 0
fn checksumU8(comp: []const u8) u32 {
    var h: i32 = @bitCast(@as(u32, 0x811c9dc5));
    for (comp) |b| {
        h = @bitCast(@as(u32, @bitCast(h ^ @as(i32, b))) *% 0x01000193);
    }
    return @bitCast(h);
}

fn sieve(comp: []u8) void {
    var i: usize = 0;
    while (i < LIMIT) : (i += 1) comp[i] = 0;
    comp[0] = 1;
    comp[1] = 1;
    i = 2;
    while (i * i < LIMIT) : (i += 1) {
        if (comp[i] == 0) {
            var j: usize = i * i;
            while (j < LIMIT) : (j += i) comp[j] = 1;
        }
    }
}

fn runKernel(comp: []u8) void {
    var it: usize = 0;
    while (it < N_ITERS) : (it += 1) sieve(comp);
}

pub fn main(init_args: std.process.Init) !void {
    const io = init_args.io;
    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    const allocator = std.heap.page_allocator;
    const comp = try allocator.alloc(u8, LIMIT);
    defer allocator.free(comp);

    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) runKernel(comp);

    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = nowMs();
        runKernel(comp);
        samples[i] = nowMs() - t0;
    }

    const cs = checksumU8(comp);
    try stdout.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{ medianUs(&samples), cs, LIMIT * N_ITERS, 1, N_RUNS });
    try stdout.flush();
}
