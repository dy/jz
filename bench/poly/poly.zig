const std = @import("std");
const Io = std.Io;

const N = 8192;
const N_ITERS = 80;
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

fn init(f64s: []f64, i32s: []i32) void {
    var i: usize = 0;
    while (i < N) : (i += 1) {
        f64s[i] = @as(f64, @floatFromInt(i % 251)) * 0.25;
        i32s[i] = @as(i32, @intCast((i *% 17) & 1023));
    }
}

fn sumF64(xs: []const f64) f64 {
    var s: f64 = 0;
    for (xs) |x| s += x;
    return s;
}

fn sumI32(xs: []const i32) i32 {
    var s: i32 = 0;
    for (xs) |x| s +%= x;
    return s;
}

fn runKernel(f64s: []const f64, i32s: []const i32) u32 {
    var h: u32 = 0x811c9dc5;
    var i: usize = 0;
    while (i < N_ITERS) : (i += 1) {
        h = mix(h, @as(u32, @bitCast(@as(i32, @intFromFloat(sumF64(f64s))))));
        h = mix(h, @as(u32, @bitCast(sumI32(i32s))));
    }
    return h;
}

pub fn main(init_args: std.process.Init) !void {
    const io = init_args.io;
    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    const allocator = std.heap.page_allocator;
    const f64s = try allocator.alloc(f64, N);
    const i32s = try allocator.alloc(i32, N);
    defer allocator.free(f64s);
    defer allocator.free(i32s);
    init(f64s, i32s);

    var cs: u32 = 0;
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) cs = runKernel(f64s, i32s);

    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = nowMs();
        cs = runKernel(f64s, i32s);
        samples[i] = nowMs() - t0;
    }
    try stdout.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{ medianUs(&samples), cs, N * N_ITERS * 2, 2, N_RUNS });
    try stdout.flush();
}
