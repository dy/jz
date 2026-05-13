const std = @import("std");
const Io = std.Io;

const N = 8192;
const N_ITERS = 24;
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

fn checksumF64(xs: *const [N]f64) u32 {
    const words: [*]const u32 = @ptrCast(@alignCast(xs.ptr));
    var h: u32 = 0x811c9dc5;
    var i: usize = 0;
    while (i < N * 2) : (i += 256) h = mix(h, words[i]);
    return h;
}

fn fill(xs: *[N]f64) void {
    var s: u32 = 0x9e3779b9;
    var i: usize = 0;
    while (i < N) : (i += 1) {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        xs[i] = @as(f64, @floatFromInt(s)) / 4294967296.0;
    }
}

fn heapsort(a: *[N]f64) void {
    var root: isize = @as(isize, @intCast((N >> 1) - 1));
    while (root >= 0) : (root -= 1) {
        var i: usize = @intCast(root);
        var child = 2 * i + 1;
        while (child < N) {
            if (child + 1 < N and a[child] < a[child + 1]) child += 1;
            if (a[i] >= a[child]) break;
            const t = a[i]; a[i] = a[child]; a[child] = t;
            i = child;
            child = 2 * i + 1;
        }
    }
    var end: usize = N - 1;
    while (end > 0) : (end -= 1) {
        const t = a[0]; a[0] = a[end]; a[end] = t;
        var i: usize = 0;
        var child: usize = 1;
        while (child < end) {
            if (child + 1 < end and a[child] < a[child + 1]) child += 1;
            if (a[i] >= a[child]) break;
            const u = a[i]; a[i] = a[child]; a[child] = u;
            i = child;
            child = 2 * i + 1;
        }
    }
}

fn runKernel(a: *[N]f64, src: *const [N]f64) void {
    var it: usize = 0;
    while (it < N_ITERS) : (it += 1) {
        const f = @as(f64, @floatFromInt(it));
        var i: usize = 0;
        while (i < N) : (i += 1) a[i] = src[i] + f;
        heapsort(a);
    }
}

pub fn main(init_args: std.process.Init) !void {
    const io = init_args.io;
    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    var src = [_]f64{0} ** N;
    var a = [_]f64{0} ** N;
    fill(&src);
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) runKernel(&a, &src);
    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = nowMs();
        runKernel(&a, &src);
        samples[i] = nowMs() - t0;
    }
    try stdout.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{ medianUs(&samples), checksumF64(&a), N * N_ITERS, 2, N_RUNS });
    try stdout.flush();
}
