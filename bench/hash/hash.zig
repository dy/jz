const std = @import("std");
const Io = std.Io;

const N = 16384;
const N_ITERS = 700;
const N_RUNS = 21;
const N_WARMUP = 5;

const C1: u32 = 0xcc9e2d51;
const C2: u32 = 0x1b873593;

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

fn initBuf(buf: *[N]u8) void {
    var x: i32 = 0x12345678;
    var i: usize = 0;
    while (i < N) : (i += 1) {
        x = @as(i32, @bitCast(@as(u32, @bitCast(x)) *% 1103515245 +% 12345));
        buf[i] = @intCast((@as(u32, @bitCast(x)) >> 16) & 0xff);
    }
}

fn murmur3(buf: *const [N]u8, seed: u32) u32 {
    var h: i32 = @bitCast(seed);
    var i: usize = 0;
    while (i + 4 <= N) : (i += 4) {
        var k: i32 = @bitCast(@as(u32, buf[i]) | (@as(u32, buf[i+1]) << 8) | (@as(u32, buf[i+2]) << 16) | (@as(u32, buf[i+3]) << 24));
        k = @bitCast(@as(u32, @bitCast(k)) *% C1);
        k = @bitCast(@as(u32, @bitCast(k)) << 15 | @as(u32, @bitCast(k)) >> 17);
        k = @bitCast(@as(u32, @bitCast(k)) *% C2);
        h ^= k;
        h = @bitCast(@as(u32, @bitCast(h)) << 13 | @as(u32, @bitCast(h)) >> 19);
        h = @bitCast(@as(u32, @bitCast(h)) *% 5 +% 0xe6546b64);
    }
    h ^= @as(i32, N);
    var uh: u32 = @bitCast(h);
    uh ^= uh >> 16;
    uh = uh *% 0x85ebca6b;
    uh ^= uh >> 13;
    uh = uh *% 0xc2b2ae35;
    uh ^= uh >> 16;
    return uh;
}

fn runKernel(buf: *[N]u8) u32 {
    var h: u32 = 0;
    var it: usize = 0;
    while (it < N_ITERS) : (it += 1) {
        const mr = murmur3(buf, 0x9747b28c);
        h = mix(h, mr);
        const j = it % N;
        buf[j] +%= 1;
    }
    return h;
}

pub fn main(init_args: std.process.Init) !void {
    const io = init_args.io;
    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    var buf = [_]u8{0} ** N;
    initBuf(&buf);
    var cs: u32 = 0;
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) cs = runKernel(&buf);
    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = nowMs();
        cs = runKernel(&buf);
        samples[i] = nowMs() - t0;
    }
    try stdout.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{ medianUs(&samples), cs, N * N_ITERS, 1, N_RUNS });
    try stdout.flush();
}
