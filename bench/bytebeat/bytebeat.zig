const std = @import("std");
const Io = std.Io;

const N = 1 << 21;
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

fn checksumU8(out: []const u8) u32 {
    var h: u32 = 0x811c9dc5;
    for (out) |b| h = mix(h, b);
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

fn sample(t: u32) u32 {
    const v1 = ((t *% 5) & (t >> 7)) | ((t *% 3) & (t >> 10));
    const v2 = t *% (((t >> 12) | (t >> 8)) & (63 & (t >> 4)));
    return (v1 +% v2) & 255;
}

fn render(buf: []u8) void {
    for (buf, 0..) |*slot, t| slot.* = @truncate(sample(@truncate(t)));
}

pub fn main(proc: std.process.Init) !void {
    const io = proc.io;
    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    const allocator = std.heap.page_allocator;
    const buf = try allocator.alloc(u8, N);
    defer allocator.free(buf);
    var samples = [_]f64{0} ** N_RUNS;
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) render(buf);
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = nowMs();
        render(buf);
        samples[i] = nowMs() - t0;
    }
    try stdout.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{ medianUs(&samples), checksumU8(buf), N, 1, N_RUNS });
    try stdout.flush();
}
