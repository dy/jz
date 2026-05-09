const std = @import("std");
const Io = std.Io;

const N_ITERS = 200000;
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

fn checksumF64(out: []const f64) u32 {
    var h: u32 = 0x811c9dc5;
    var i: usize = 0;
    while (i < out.len * 2) : (i += 256) {
        const bits: u64 = @as(u64, @bitCast(out[i / 2]));
        const w: u32 = if ((i & 1) == 0) @as(u32, @truncate(bits)) else @as(u32, @truncate(bits >> 32));
        h = mix(h, w);
    }
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

fn init(a: *[16]f64, b: *[16]f64) void {
    var i: usize = 0;
    while (i < 16) : (i += 1) {
        a[i] = (@as(f64, @floatFromInt(i)) + 1.0) * 0.125;
        b[i] = @as(f64, @floatFromInt(16 - i)) * 0.0625;
    }
}

fn multiplyMany(a: *[16]f64, b: *[16]f64, out: *[16]f64, iters: usize) void {
    var n: usize = 0;
    while (n < iters) : (n += 1) {
        var r: usize = 0;
        while (r < 4) : (r += 1) {
            var c: usize = 0;
            while (c < 4) : (c += 1) {
                var s: f64 = 0;
                var k: usize = 0;
                while (k < 4) : (k += 1) s += a[r * 4 + k] * b[k * 4 + c];
                out[r * 4 + c] = s + @as(f64, @floatFromInt(n)) * 0.0000001;
            }
        }
        const t = a[0];
        a[0] = out[15];
        a[5] = t + out[10] * 0.000001;
        b[0] += out[0] * 0.00000000001;
        b[5] -= out[5] * 0.00000000001;
    }
}

pub fn main(proc: std.process.Init) !void {
    const io = proc.io;
    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    var a = [_]f64{0} ** 16;
    var b = [_]f64{0} ** 16;
    var out = [_]f64{0} ** 16;
    var samples = [_]f64{0} ** N_RUNS;
    init(&a, &b);
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) multiplyMany(&a, &b, &out, N_ITERS);
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        init(&a, &b);
        const t0 = nowMs();
        multiplyMany(&a, &b, &out, N_ITERS);
        samples[i] = nowMs() - t0;
    }
    try stdout.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{ medianUs(&samples), checksumF64(&out), N_ITERS * 16, 4, N_RUNS });
    try stdout.flush();
}
