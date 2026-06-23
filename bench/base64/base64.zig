const std = @import("std");
const bench = @import("bench");

const N: usize = 24576;
const ENC_LEN: usize = (N / 3) * 4;
const N_ITERS: usize = 64;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

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

fn buildEnc(enc: *[64]u8) void {
    var i: usize = 0;
    var c: u8 = 65;
    while (c <= 90) : (c += 1) { enc[i] = c; i += 1; }
    c = 97;
    while (c <= 122) : (c += 1) { enc[i] = c; i += 1; }
    c = 48;
    while (c <= 57) : (c += 1) { enc[i] = c; i += 1; }
    enc[i] = 43; i += 1;
    enc[i] = 47;
}

fn buildDec(enc: *const [64]u8, dec: *[256]u8) void {
    var i: usize = 0;
    while (i < 256) : (i += 1) dec[i] = 0;
    i = 0;
    while (i < 64) : (i += 1) dec[enc[i]] = @intCast(i);
}

fn initBuf(buf: *[N]u8) void {
    var x: i32 = @bitCast(@as(u32, 0x12345678));
    var i: usize = 0;
    while (i < N) : (i += 1) {
        x = @bitCast(@as(u32, @bitCast(x)) *% 1103515245 +% 12345);
        buf[i] = @intCast((@as(u32, @bitCast(x)) >> 16) & 0xff);
    }
}

fn checksumU8(xs: []const u8) u32 {
    var h: u32 = 0x811c9dc5;
    for (xs) |b| h = (h ^ @as(u32, b)) *% 0x01000193;
    return h;
}

fn encode(src: *const [N]u8, enc: *const [64]u8, out: *[ENC_LEN]u8) void {
    var op: usize = 0;
    var i: usize = 0;
    while (i + 3 <= N) : (i += 3) {
        const a = src[i]; const b = src[i + 1]; const c = src[i + 2];
        out[op]     = enc[a >> 2];
        out[op + 1] = enc[((a & 3) << 4) | (b >> 4)];
        out[op + 2] = enc[((b & 15) << 2) | (c >> 6)];
        out[op + 3] = enc[c & 63];
        op += 4;
    }
}

fn decode(src: *const [ENC_LEN]u8, dec: *const [256]u8, out: *[N]u8) void {
    var op: usize = 0;
    var i: usize = 0;
    while (i + 4 <= ENC_LEN) : (i += 4) {
        const a = dec[src[i]];
        const b = dec[src[i + 1]];
        const c = dec[src[i + 2]];
        const d = dec[src[i + 3]];
        out[op]     = @intCast((((@as(u32, a) << 2) | (@as(u32, b) >> 4)) & 0xff));
        out[op + 1] = @intCast((((@as(u32, b) & 15) << 4) | (@as(u32, c) >> 2)) & 0xff);
        out[op + 2] = @intCast((((@as(u32, c) & 3) << 6) | @as(u32, d)) & 0xff);
        op += 3;
    }
}

fn runKernel(src: *[N]u8, enc: *const [64]u8, dec: *const [256]u8, b64: *[ENC_LEN]u8, back: *[N]u8) u32 {
    var h: u32 = 0;
    var it: usize = 0;
    while (it < N_ITERS) : (it += 1) {
        encode(src, enc, b64);
        decode(b64, dec, back);
        var ok: u32 = 1;
        var i: usize = 0;
        while (i < N) : (i += 1) if (back[i] != src[i]) { ok = 0; };
        const cs_b64 = checksumU8(b64);
        h = mix(mix(h, cs_b64), ok);
        const j = it % N;
        src[j] +%= 1;
    }
    return h;
}

pub fn main() !void {

    var src = [_]u8{0} ** N;
    var enc_tab = [_]u8{0} ** 64;
    var dec_tab = [_]u8{0} ** 256;
    var b64 = [_]u8{0} ** ENC_LEN;
    var back = [_]u8{0} ** N;

    buildEnc(&enc_tab);
    buildDec(&enc_tab, &dec_tab);
    initBuf(&src);

    var cs: u32 = 0;
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) cs = runKernel(&src, &enc_tab, &dec_tab, &b64, &back);

    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = bench.nowMs();
        cs = runKernel(&src, &enc_tab, &dec_tab, &b64, &back);
        samples[i] = bench.nowMs() - t0;
    }
    bench.printResult(medianUs(&samples), cs, N * N_ITERS, 1, N_RUNS);
}
