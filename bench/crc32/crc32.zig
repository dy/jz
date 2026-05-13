const std = @import("std");
const Io = std.Io;

const N = 16384;
const N_ITERS = 220;
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

fn buildTable(table: *[256]u32) void {
    var n: u32 = 0;
    while (n < 256) : (n += 1) {
        var c = n;
        var k: usize = 0;
        while (k < 8) : (k += 1) c = if ((c & 1) != 0) 0xedb88320 ^ (c >> 1) else c >> 1;
        table[n] = c;
    }
}

fn initBuf(buf: *[N]u8) void {
    var x: u32 = 0x12345678;
    var i: usize = 0;
    while (i < N) : (i += 1) {
        x = x *% 1103515245 +% 12345;
        buf[i] = @intCast((x >> 16) & 0xff);
    }
}

fn crc32Kernel(buf: *const [N]u8, table: *const [256]u32) u32 {
    var c: u32 = 0xffffffff;
    var i: usize = 0;
    while (i < N) : (i += 1) c = table[(c ^ buf[i]) & 0xff] ^ (c >> 8);
    return c ^ 0xffffffff;
}

fn runKernel(buf: *[N]u8, table: *const [256]u32) u32 {
    var h: u32 = 0;
    var it: usize = 0;
    while (it < N_ITERS) : (it += 1) {
        h = mix(h, crc32Kernel(buf, table));
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
    var table = [_]u32{0} ** 256;
    buildTable(&table);
    initBuf(&buf);
    var cs: u32 = 0;
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) cs = runKernel(&buf, &table);
    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = nowMs();
        cs = runKernel(&buf, &table);
        samples[i] = nowMs() - t0;
    }
    try stdout.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{ medianUs(&samples), cs, N * N_ITERS, 1, N_RUNS });
    try stdout.flush();
}
