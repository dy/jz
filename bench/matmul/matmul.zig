// matmul.zig — dense matrix multiply C = A·Bᵀ. Bit-identical to matmul.js.
// Small-integer data keeps every product-sum exact in f64, so the checksum matches
// every target with no parity class.
const std = @import("std");
const bench = @import("bench");

const N: usize = 256;
const N_RUNS = 21;
const N_WARMUP = 5;

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

fn init(a: []f64, bt: []f64) void {
    var i: usize = 0;
    while (i < N * N) : (i += 1) {
        a[i] = @as(f64, @floatFromInt(@as(i32, @intCast(i % 13)) - 6));
        bt[i] = @as(f64, @floatFromInt(@as(i32, @intCast((i * 7) % 11)) - 5));
    }
}

// C = A·Bᵀ. Inner loop is a contiguous dot over row i of A and row j of Bᵀ.
fn matmul(a: []const f64, bt: []const f64, c: []f64) void {
    var i: usize = 0;
    while (i < N) : (i += 1) {
        const ai = i * N;
        var j: usize = 0;
        while (j < N) : (j += 1) {
            const bj = j * N;
            var s: f64 = 0;
            var k: usize = 0;
            while (k < N) : (k += 1) s += a[ai + k] * bt[bj + k];
            c[ai + j] = s;
        }
    }
}

pub fn main() !void {

    const allocator = std.heap.page_allocator;
    const a = try allocator.alloc(f64, N * N);
    const bt = try allocator.alloc(f64, N * N);
    const c = try allocator.alloc(f64, N * N);
    defer allocator.free(a);
    defer allocator.free(bt);
    defer allocator.free(c);
    init(a, bt);

    var samples = [_]f64{0} ** N_RUNS;
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) matmul(a, bt, c);
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = bench.nowMs();
        matmul(a, bt, c);
        samples[i] = bench.nowMs() - t0;
    }
    bench.printResult(medianUs(&samples), checksumF64(c), N * N * N, 2, N_RUNS);
}
