const std = @import("std");
const Io = std.Io;

const W = 256;
const H = 256;
const MAX_ITER: u32 = 256;
const N_RUNS = 21;
const N_WARMUP = 5;
const X0: f64 = -2.0;
const X1: f64 = 0.5;
const Y0: f64 = -1.25;
const Y1: f64 = 1.25;

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

fn checksumU32(xs: []const u32) u32 {
    var h: u32 = 0x811c9dc5;
    var i: usize = 0;
    while (i < xs.len) : (i += 128) h = mix(h, xs[i]);
    return h;
}

fn render(out: []u32) void {
    const dx = (X1 - X0) / @as(f64, @floatFromInt(W));
    const dy = (Y1 - Y0) / @as(f64, @floatFromInt(H));
    var py: usize = 0;
    while (py < H) : (py += 1) {
        const cy = Y0 + @as(f64, @floatFromInt(py)) * dy;
        var px: usize = 0;
        while (px < W) : (px += 1) {
            const cx = X0 + @as(f64, @floatFromInt(px)) * dx;
            var zx: f64 = 0;
            var zy: f64 = 0;
            var i: u32 = 0;
            while (i < MAX_ITER) : (i += 1) {
                const x2 = zx * zx;
                const y2 = zy * zy;
                if (x2 + y2 > 4.0) break;
                zy = 2.0 * zx * zy + cy;
                zx = x2 - y2 + cx;
            }
            out[py * W + px] = i;
        }
    }
}

pub fn main(init_args: std.process.Init) !void {
    const io = init_args.io;
    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    const allocator = std.heap.page_allocator;
    const out = try allocator.alloc(u32, W * H);
    defer allocator.free(out);
    @memset(out, 0);

    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) render(out);

    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = nowMs();
        render(out);
        samples[i] = nowMs() - t0;
    }
    try stdout.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{ medianUs(&samples), checksumU32(out), W * H, MAX_ITER, N_RUNS });
    try stdout.flush();
}
