const std = @import("std");
const bench = @import("bench");

const SR: f64 = 44100.0;
const N_NOTES = 64;
const NOTE_LEN = 8192;
const N = N_NOTES * NOTE_LEN;
const N_RUNS = 21;
const N_WARMUP = 5;

const ATTACK: f64 = 400.0;
const DECAY: f64 = 1600.0;
const RELEASE: f64 = 2400.0;
const NOTE_LEN_F: f64 = 8192.0;
const SUSTAIN: f64 = 0.6;

const B0: f64 = 0.0675;
const B1: f64 = 0.135;
const B2: f64 = 0.0675;
const A1: f64 = -1.143;
const A2: f64 = 0.412;

const FREQS = [_]f64{ 261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88, 523.25 };

fn mix(h: u32, x: u32) u32 {
    return (h ^ x) *% 0x01000193;
}

fn checksumF64(out: []const f64) u32 {
    var h: u32 = 0x811c9dc5;
    var i: usize = 0;
    while (i < out.len) : (i += 128) {
        const bits: u64 = @bitCast(out[i]);
        h = mix(h, @truncate(bits));
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

fn sinTau(ph: f64) f64 {
    const q = ph * 4.0;
    const m = @floor(q + 0.5);
    const phi = (q - m) * 1.5707963267948966;
    const p2 = phi * phi;
    const sp = phi * (1.0 + p2 * (-0.16666666666666666 + p2 * (0.008333333333333333 + p2 * (-0.0001984126984126984 + p2 * (2.7557319223985893e-06 + p2 * -2.505210838544172e-08)))));
    const cp = 1.0 + p2 * (-0.5 + p2 * (0.041666666666666664 + p2 * (-0.001388888888888889 + p2 * (2.48015873015873e-05 + p2 * -2.7557319223985894e-07))));
    const r = @as(i32, @intFromFloat(m)) & 3;
    return if (r == 0) sp else if (r == 1) cp else if (r == 2) -sp else -cp;
}

fn render(out: []f64) void {
    var x1: f64 = 0;
    var x2: f64 = 0;
    var y1: f64 = 0;
    var y2: f64 = 0;
    var note: usize = 0;
    while (note < N_NOTES) : (note += 1) {
        const oct: f64 = if ((note >> 2) & 1 != 0) 2.0 else 1.0;
        const freq = FREQS[(note * 3 + 1) & 7] * oct;
        const dph = freq / SR;
        var ph: f64 = 0;
        const off = note * NOTE_LEN;
        var t: usize = 0;
        while (t < NOTE_LEN) : (t += 1) {
            const tf: f64 = @floatFromInt(t);
            const env: f64 = if (tf < ATTACK) tf / ATTACK else if (tf < ATTACK + DECAY) 1.0 - (1.0 - SUSTAIN) * (tf - ATTACK) / DECAY else if (tf < NOTE_LEN_F - RELEASE) SUSTAIN else (NOTE_LEN_F - tf) / RELEASE * SUSTAIN;
            const s = sinTau(ph) * env;
            ph += dph;
            if (ph >= 1.0) ph -= 1.0;
            const y = B0 * s + B1 * x1 + B2 * x2 - A1 * y1 - A2 * y2;
            x2 = x1;
            x1 = s;
            y2 = y1;
            y1 = y;
            out[off + t] = y;
        }
    }
}

pub fn main() !void {

    const allocator = std.heap.page_allocator;
    const out = try allocator.alloc(f64, N);
    defer allocator.free(out);
    var samples = [_]f64{0} ** N_RUNS;

    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) render(out);
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = bench.nowMs();
        render(out);
        samples[i] = bench.nowMs() - t0;
    }
    bench.printResult(medianUs(&samples), checksumF64(out), N, N_NOTES, N_RUNS);
}
