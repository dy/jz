const std = @import("std");
const Io = std.Io;

const N = 4096;
const N_ITERS = 128;
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

fn runKernel(a: []const i32, scale: i32) u32 {
    var h: u32 = 0x811c9dc5;
    var i: usize = 0;
    while (i < N_ITERS) : (i += 1) {
        const ii = @as(i32, @intCast(i));
        var j: usize = 0;
        while (j < a.len) : (j += 64) {
            const b = a[j] * scale + ii;
            h = mix(h, @as(u32, @bitCast(b)));
        }
    }
    return h;
}

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    const allocator = std.heap.page_allocator;
    const a = try allocator.alloc(i32, N);
    defer allocator.free(a);
    var i: usize = 0;
    while (i < N) : (i += 1) a[i] = @as(i32, @intCast(i % 97)) - 48;

    var cs: u32 = 0;
    i = 0;
    while (i < N_WARMUP) : (i += 1) cs = runKernel(a, 2);
    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = nowMs();
        cs = runKernel(a, 2);
        samples[i] = nowMs() - t0;
    }
    try stdout.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{ medianUs(&samples), cs, N * N_ITERS, 1, N_RUNS });
    try stdout.flush();
}
