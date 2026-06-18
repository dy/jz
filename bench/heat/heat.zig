// heat.zig — 2-D heat diffusion (explicit-Euler 5-point Laplacian). Bit-identical to
// heat.js. On arm64 Zig may fuse `c + K*lap` to an FMA; the field then rounds in the
// last ulp → reported as `fma` parity, not DIFF.
const std = @import("std");
const Io = std.Io;

const W: usize = 258;
const H: usize = 258;
const STEPS: usize = 100;
const K: f64 = 0.125;
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

// Deterministic integer field 0..255 (XorShift32), identical per target.
fn seed(a: []f64) void {
    var s: u32 = 0x1234abcd;
    var i: usize = 0;
    while (i < a.len) : (i += 1) {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        a[i] = @as(f64, @floatFromInt(s & 255));
    }
}

// One diffusion sweep over the interior: dst = src + K·(∇²src). Border stays fixed.
fn step(src: []const f64, dst: []f64) void {
    var y: usize = 1;
    while (y < H - 1) : (y += 1) {
        const row = y * W;
        var x: usize = 1;
        while (x < W - 1) : (x += 1) {
            const c = row + x;
            dst[c] = src[c] + K * (src[c - 1] + src[c + 1] + src[c - W] + src[c + W] - 4.0 * src[c]);
        }
    }
}

fn run(a: []f64, b: []f64) void {
    var s: usize = 0;
    while (s < STEPS) : (s += 2) {
        step(a, b);
        step(b, a);
    }
}

pub fn main(proc: std.process.Init) !void {
    const io = proc.io;
    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    const allocator = std.heap.page_allocator;
    const a = try allocator.alloc(f64, W * H);
    const b = try allocator.alloc(f64, W * H);
    defer allocator.free(a);
    defer allocator.free(b);

    var samples = [_]f64{0} ** N_RUNS;
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) {
        seed(a);
        seed(b);
        run(a, b);
    }
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        seed(a);
        seed(b);
        const t0 = nowMs();
        run(a, b);
        samples[i] = nowMs() - t0;
    }
    try stdout.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{ medianUs(&samples), checksumF64(a), (W - 2) * (H - 2) * STEPS, 6, N_RUNS });
    try stdout.flush();
}
