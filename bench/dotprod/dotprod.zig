// dotprod.zig — multiply-accumulate (dot-product) reduction: the fundamental
// DSP/numeric kernel (correlation, energy, projection, FIR tap-sum). The
// accumulator `s += a[i]*b[i]` is a latency-bound dependency chain — exactly
// where multi-accumulator vectorization (independent partial sums combined at
// the end) earns its keep.
const std = @import("std");
const Io = std.Io;

const N = 8192;
const N_ITERS = 200;
const N_RUNS = 21;
const N_WARMUP = 5;

fn nowMs() f64 {
    var ts: std.c.timespec = undefined;
    _ = std.c.clock_gettime(std.c.CLOCK.MONOTONIC, &ts);
    return @as(f64, @floatFromInt(ts.sec)) * 1000.0 + @as(f64, @floatFromInt(ts.nsec)) / 1_000_000.0;
}

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

fn init(a: []f64, b: []f64) void {
    // Small integers => the sum of products is exact in f64 regardless of summation
    // order, so vectorized / reassociated / scalar all agree — the checksum is
    // cross-target stable (the whole point of integer-valued reduction data).
    var i: usize = 0;
    while (i < N) : (i += 1) {
        a[i] = @as(f64, @floatFromInt(@as(i32, @intCast(i % 13)) - 6));
        b[i] = @as(f64, @floatFromInt(@as(i32, @intCast((i * 7) % 11)) - 5));
    }
}

fn dot(a: []const f64, b: []const f64) f64 {
    var s: f64 = 0;
    var i: usize = 0;
    while (i < N) : (i += 1) s += a[i] * b[i];
    return s;
}

fn runKernel(a: []const f64, b: []const f64) u32 {
    var h: u32 = 0x811c9dc5;
    var i: usize = 0;
    while (i < N_ITERS) : (i += 1) {
        h = mix(h, @as(u32, @bitCast(@as(i32, @intFromFloat(dot(a, b))))));
    }
    return h;
}

pub fn main(init_args: std.process.Init) !void {
    const io = init_args.io;
    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    const allocator = std.heap.page_allocator;
    const a = try allocator.alloc(f64, N);
    const b = try allocator.alloc(f64, N);
    defer allocator.free(a);
    defer allocator.free(b);
    init(a, b);

    var cs: u32 = 0;
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) cs = runKernel(a, b);

    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = nowMs();
        cs = runKernel(a, b);
        samples[i] = nowMs() - t0;
    }
    try stdout.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{ medianUs(&samples), cs, N * N_ITERS, 2, N_RUNS });
    try stdout.flush();
}
