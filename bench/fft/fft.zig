const std = @import("std");
const bench = @import("bench");

const N = 1 << 16;
const LOG2N = 16;
const N_RUNS = 21;
const N_WARMUP = 5;

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

fn sinPoly(x: f64) f64 {
    const x2 = x * x;
    return x * (1.0 + x2 * (-0.16666666666666666 + x2 * (0.008333333333333333 + x2 * (-0.0001984126984126984 + x2 * (2.7557319223985893e-06 + x2 * -2.505210838544172e-08)))));
}
fn cosPoly(x: f64) f64 {
    const x2 = x * x;
    return 1.0 + x2 * (-0.5 + x2 * (0.041666666666666664 + x2 * (-0.001388888888888889 + x2 * (2.48015873015873e-05 + x2 * -2.7557319223985894e-07))));
}

fn buildTwiddles(wre: []f64, wim: []f64, n: usize) void {
    const dt = -6.283185307179586 / @as(f64, @floatFromInt(n));
    const c1 = cosPoly(dt);
    const s1 = sinPoly(dt);
    var cr: f64 = 1.0;
    var ci: f64 = 0.0;
    var k: usize = 0;
    while (k < (n >> 1)) : (k += 1) {
        wre[k] = cr;
        wim[k] = ci;
        const nr = cr * c1 - ci * s1;
        const ni = cr * s1 + ci * c1;
        cr = nr;
        ci = ni;
    }
}

fn fft(re: []f64, im: []f64, wre: []const f64, wim: []const f64, n: usize) void {
    var j: usize = 0;
    var i: usize = 1;
    while (i < n) : (i += 1) {
        var bit = n >> 1;
        while (j & bit != 0) : (bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            std.mem.swap(f64, &re[i], &re[j]);
            std.mem.swap(f64, &im[i], &im[j]);
        }
    }
    var len: usize = 2;
    while (len <= n) : (len <<= 1) {
        const half = len >> 1;
        const step = n / len;
        var base: usize = 0;
        while (base < n) : (base += len) {
            var k: usize = 0;
            var jj: usize = 0;
            while (jj < half) : (jj += 1) {
                const wr = wre[k];
                const wi = wim[k];
                const a = base + jj;
                const b = a + half;
                const xr = re[b];
                const xi = im[b];
                const tr = wr * xr - wi * xi;
                const ti = wr * xi + wi * xr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] = re[a] + tr;
                im[a] = im[a] + ti;
                k += step;
            }
        }
    }
}

fn mkSignal(out: []f64) void {
    var s: u32 = 0x1234abcd;
    for (out) |*x| {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        x.* = (@as(f64, @floatFromInt(s)) / 4294967296.0) * 2.0 - 1.0;
    }
}

pub fn main() !void {

    const allocator = std.heap.page_allocator;
    const sig = try allocator.alloc(f64, N);
    defer allocator.free(sig);
    const re = try allocator.alloc(f64, N);
    defer allocator.free(re);
    const im = try allocator.alloc(f64, N);
    defer allocator.free(im);
    const wre = try allocator.alloc(f64, N >> 1);
    defer allocator.free(wre);
    const wim = try allocator.alloc(f64, N >> 1);
    defer allocator.free(wim);
    var samples = [_]f64{0} ** N_RUNS;

    mkSignal(sig);
    buildTwiddles(wre, wim, N);

    var w: usize = 0;
    while (w < N_WARMUP) : (w += 1) {
        var i: usize = 0;
        while (i < N) : (i += 1) {
            re[i] = sig[i];
            im[i] = 0.0;
        }
        fft(re, im, wre, wim, N);
    }
    var r: usize = 0;
    while (r < N_RUNS) : (r += 1) {
        var i: usize = 0;
        while (i < N) : (i += 1) {
            re[i] = sig[i];
            im[i] = 0.0;
        }
        const t0 = bench.nowMs();
        fft(re, im, wre, wim, N);
        samples[r] = bench.nowMs() - t0;
    }
    bench.printResult(medianUs(&samples), checksumF64(re), (N * LOG2N) >> 1, LOG2N, N_RUNS);
}
