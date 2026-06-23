const std = @import("std");
const bench = @import("bench");

const N: usize = 131072;
const SR: u32 = 44100;
const HDR: usize = 44;
const BYTES: usize = HDR + N * 2;
const N_ITERS = 16;
const N_RUNS = 21;
const N_WARMUP = 5;

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

fn mkSamples(s: []f64) void {
    var x: i32 = 0x1234abcd;
    var i: usize = 0;
    while (i < N) : (i += 1) {
        x ^= x << 13;
        x ^= @as(i32, @bitCast(@as(u32, @bitCast(x)) >> 17));
        x ^= x << 5;
        s[i] = ((@as(f64, @floatFromInt(@as(u32, @bitCast(x)))) / 4294967296.0) * 2.0 - 1.0) * 1.2;
    }
}

fn writeU32(b: []u8, off: usize, v: u32) void {
    b[off]     = @truncate(v & 0xff);
    b[off + 1] = @truncate((v >> 8)  & 0xff);
    b[off + 2] = @truncate((v >> 16) & 0xff);
    b[off + 3] = @truncate((v >> 24) & 0xff);
}

fn writeU16(b: []u8, off: usize, v: u32) void {
    b[off]     = @truncate(v & 0xff);
    b[off + 1] = @truncate((v >> 8) & 0xff);
}

fn encode(s: []const f64, count: usize, out: []u8) void {
    const data_bytes: u32 = @intCast(count * 2);
    out[0] = 82; out[1] = 73; out[2] = 70; out[3] = 70;
    writeU32(out, 4, 36 + data_bytes);
    out[8] = 87; out[9] = 65; out[10] = 86; out[11] = 69;
    out[12] = 102; out[13] = 109; out[14] = 116; out[15] = 32;
    writeU32(out, 16, 16);
    writeU16(out, 20, 1);
    writeU16(out, 22, 1);
    writeU32(out, 24, SR);
    writeU32(out, 28, SR * 2);
    writeU16(out, 32, 2);
    writeU16(out, 34, 16);
    out[36] = 100; out[37] = 97; out[38] = 116; out[39] = 97;
    writeU32(out, 40, data_bytes);
    var op: usize = HDR;
    var i: usize = 0;
    while (i < count) : (i += 1) {
        var v = s[i] * 32767.0;
        if (v > 32767.0) v = 32767.0 else if (v < -32768.0) v = -32768.0;
        const iv: i32 = @intFromFloat(v);
        const u: u32 = @as(u32, @bitCast(iv)) & 0xffff;
        out[op]     = @truncate(u & 0xff);
        out[op + 1] = @truncate((u >> 8) & 0xff);
        op += 2;
    }
}

fn runKernel(s: []f64, out: []u8) u32 {
    var h: u32 = 0;
    var it: usize = 0;
    while (it < N_ITERS) : (it += 1) {
        encode(s, N, out);
        h = mix(h, checksumU8(out));
        const j = it % N;
        s[j] = -s[j];
    }
    return h;
}

pub fn main() !void {

    const allocator = std.heap.page_allocator;
    const s = try allocator.alloc(f64, N);
    defer allocator.free(s);
    const out = try allocator.alloc(u8, BYTES);
    defer allocator.free(out);

    mkSamples(s);
    var cs: u32 = 0;
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) cs = runKernel(s, out);
    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = bench.nowMs();
        cs = runKernel(s, out);
        samples[i] = bench.nowMs() - t0;
    }
    bench.printResult(medianUs(&samples), cs, N * N_ITERS, 1, N_RUNS);
}
