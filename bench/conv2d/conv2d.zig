const std = @import("std");
const bench = @import("bench");

const CIN: i32 = 4;
const COUT: i32 = 16;
const H: i32 = 34;
const W: i32 = 34;
const K: i32 = 3;
const OH: i32 = H - K + 1; // 32
const OW: i32 = W - K + 1; // 32
const IN_LEN: usize = @intCast(CIN * H * W);
const WT_LEN: usize = @intCast(COUT * CIN * K * K);
const OUT_LEN: usize = @intCast(COUT * OH * OW);
const SHIFT: u5 = 11;
const N_ITERS: usize = 24;
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

fn fillI8(arr: []i8, seed: i32) void {
    var x: i32 = seed;
    for (arr) |*a| {
        x = @bitCast(@as(u32, @bitCast(x)) *% 1103515245 +% 12345);
        a.* = @truncate(x >> 24);
    }
}

fn fillBias(arr: []i32, seed: i32) void {
    var x: i32 = seed;
    for (arr) |*a| {
        x = @bitCast(@as(u32, @bitCast(x)) *% 1103515245 +% 12345);
        a.* = (x >> 20) & 1023;
    }
}

fn idx(i: i32) usize {
    return @intCast(i);
}

fn conv(inp: []const i8, wt: []const i8, bias: []const i32, out: []u8) void {
    var oc: i32 = 0;
    while (oc < COUT) : (oc += 1) {
        const b = bias[@intCast(oc)];
        const oc_base: i32 = oc * OH * OW;
        var oy: i32 = 0;
        while (oy < OH) : (oy += 1) {
            var ox: i32 = 0;
            while (ox < OW) : (ox += 1) {
                var acc: i32 = b;
                var ic: i32 = 0;
                while (ic < CIN) : (ic += 1) {
                    const in_ch: i32 = ic * H * W;
                    const w_ch: i32 = ((oc * CIN) + ic) * K * K;
                    var ky: i32 = 0;
                    while (ky < K) : (ky += 1) {
                        const irow: i32 = in_ch + (oy + ky) * W + ox;
                        const wrow: i32 = w_ch + ky * K;
                        var kx: i32 = 0;
                        while (kx < K) : (kx += 1) {
                            acc += @as(i32, inp[idx(irow + kx)]) * @as(i32, wt[idx(wrow + kx)]);
                        }
                    }
                }
                var q: i32 = acc >> SHIFT;
                if (q < 0) q = 0;
                if (q > 127) q = 127;
                out[idx(oc_base + oy * OW + ox)] = @intCast(q);
            }
        }
    }
}

fn runKernel(inp: []i8, wt: []const i8, bias: []const i32, out: []u8) u32 {
    var h: u32 = 0;
    var it: usize = 0;
    while (it < N_ITERS) : (it += 1) {
        conv(inp, wt, bias, out);
        h = mix(h, checksumU8(out));
        const j = it % IN_LEN;
        inp[j] +%= 1;
    }
    return h;
}

pub fn main() !void {

    const allocator = std.heap.page_allocator;
    const inp = try allocator.alloc(i8, IN_LEN);
    defer allocator.free(inp);
    const wt = try allocator.alloc(i8, WT_LEN);
    defer allocator.free(wt);
    const bias = try allocator.alloc(i32, @intCast(COUT));
    defer allocator.free(bias);
    const out = try allocator.alloc(u8, OUT_LEN);
    defer allocator.free(out);

    fillI8(inp, @bitCast(@as(u32, 0x12345678)));
    fillI8(wt,  @bitCast(@as(u32, 0x2bb3c1f7)));
    fillBias(bias, @bitCast(@as(u32, 0x51e3a9d1)));

    var cs: u32 = 0;
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) cs = runKernel(inp, wt, bias, out);
    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = bench.nowMs();
        cs = runKernel(inp, wt, bias, out);
        samples[i] = bench.nowMs() - t0;
    }
    const stages: i32 = COUT * OH * OW * CIN * K * K * @as(i32, @intCast(N_ITERS));
    bench.printResult(medianUs(&samples), cs, stages, 1, N_RUNS);
}
