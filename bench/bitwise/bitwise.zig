const std = @import("std");
const Io = std.Io;

const N = 65536;
const N_ROUNDS = 128;
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

fn checksumU32(out: []const u32) u32 {
    var h: u32 = 0x811c9dc5;
    var i: usize = 0;
    while (i < out.len) : (i += 128) h = mix(h, out[i]);
    return h;
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

fn init(state: []u32) void {
    var s: u32 = 0x1234abcd;
    for (state) |*x| {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        x.* = s;
    }
}

fn runKernel(state: []u32) void {
    var r: usize = 0;
    while (r < N_ROUNDS) : (r += 1) {
        for (state) |*slot| {
            var x = slot.*;
            x ^= x << 7;
            x ^= x >> 9;
            x = x *% 1103515245 +% 12345;
            slot.* = x ^ (x >> 16);
        }
    }
}

pub fn main(proc: std.process.Init) !void {
    const io = proc.io;
    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    const allocator = std.heap.page_allocator;
    const state = try allocator.alloc(u32, N);
    defer allocator.free(state);
    var samples = [_]f64{0} ** N_RUNS;
    init(state);
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) {
        init(state);
        runKernel(state);
    }
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        init(state);
        const t0 = nowMs();
        runKernel(state);
        samples[i] = nowMs() - t0;
    }
    try stdout.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{ medianUs(&samples), checksumU32(state), N * N_ROUNDS, 3, N_RUNS });
    try stdout.flush();
}
