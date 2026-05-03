const std = @import("std");
const Io = std.Io;

const N_SAMPLES = 480000;
const N_STAGES = 8;
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

fn mkInput(out: []f64) void {
    var s: u32 = 0x1234abcd;
    for (out) |*x| {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        x.* = (@as(f64, @floatFromInt(s)) / 4294967296.0) * 2.0 - 1.0;
    }
}

fn mkCoeffs(out: []f64) void {
    var i: usize = 0;
    while (i < N_STAGES) : (i += 1) {
        const fi = @as(f64, @floatFromInt(i));
        out[i * 5 + 0] = 0.10 + fi * 0.001;
        out[i * 5 + 1] = 0.20 - fi * 0.0005;
        out[i * 5 + 2] = 0.10;
        out[i * 5 + 3] = -1.50 + fi * 0.01;
        out[i * 5 + 4] = 0.60 - fi * 0.005;
    }
}

fn processCascade(x: []const f64, coeffs: []const f64, state: []f64, nStages: usize, out: []f64) void {
    const n = x.len;
    var i: usize = 0;
    while (i < n) : (i += 1) {
        var v = x[i];
        var s: usize = 0;
        while (s < nStages) : (s += 1) {
            const c = s * 5;
            const sb = s * 4;
            const b0 = coeffs[c + 0];
            const b1 = coeffs[c + 1];
            const b2 = coeffs[c + 2];
            const a1 = coeffs[c + 3];
            const a2 = coeffs[c + 4];
            const x1 = state[sb + 0];
            const x2 = state[sb + 1];
            const y1 = state[sb + 2];
            const y2 = state[sb + 3];
            const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            state[sb + 0] = v;
            state[sb + 1] = x1;
            state[sb + 2] = y;
            state[sb + 3] = y1;
            v = y;
        }
        out[i] = v;
    }
}

pub fn main(init: std.process.Init) !void {
    const io = init.io;
    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    const allocator = std.heap.page_allocator;
    const x = try allocator.alloc(f64, N_SAMPLES);
    const coeffs = try allocator.alloc(f64, N_STAGES * 5);
    const state = try allocator.alloc(f64, N_STAGES * 4);
    const out = try allocator.alloc(f64, N_SAMPLES);
    defer allocator.free(x);
    defer allocator.free(coeffs);
    defer allocator.free(state);
    defer allocator.free(out);

    mkInput(x);
    mkCoeffs(coeffs);
    var samples = [_]f64{0} ** N_RUNS;

    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) {
        @memset(state, 0);
        processCascade(x, coeffs, state, N_STAGES, out);
    }
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        @memset(state, 0);
        const t0 = nowMs();
        processCascade(x, coeffs, state, N_STAGES, out);
        samples[i] = nowMs() - t0;
    }
    try stdout.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{ medianUs(&samples), checksumF64(out), N_SAMPLES, N_STAGES, N_RUNS });
    try stdout.flush();
}
