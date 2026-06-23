const std = @import("std");
const bench = @import("bench");

const N = 4096;
const N_ITERS = 64;
const N_RUNS = 21;
const N_WARMUP = 5;

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

fn runKernel(a: []const i32, b: []i32, scale: i32) u32 {
    var h: u32 = 0x811c9dc5;
    var i: usize = 0;
    while (i < N_ITERS) : (i += 1) {
        const ii = @as(i32, @intCast(i));
        var k: usize = 0;
        while (k < a.len) : (k += 1) b[k] = a[k] * scale + ii;
        var j: usize = 0;
        while (j < a.len) : (j += 1) {
            h = mix(h, @as(u32, @bitCast(b[j])));
        }
    }
    return h;
}

pub fn main() !void {

    const allocator = std.heap.page_allocator;
    const a = try allocator.alloc(i32, N);
    defer allocator.free(a);
    const b = try allocator.alloc(i32, N);
    defer allocator.free(b);
    var i: usize = 0;
    while (i < N) : (i += 1) a[i] = @as(i32, @intCast(i % 97)) - 48;

    var cs: u32 = 0;
    i = 0;
    while (i < N_WARMUP) : (i += 1) cs = runKernel(a, b, 2);
    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = bench.nowMs();
        cs = runKernel(a, b, 2);
        samples[i] = bench.nowMs() - t0;
    }
    bench.printResult(medianUs(&samples), cs, N * N_ITERS, 2, N_RUNS);
}
