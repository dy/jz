// radixsort.zig — least-significant-digit radix sort (4 × 8-bit counting passes)
// over a u32 key array. The canonical non-comparison integer sort (databases,
// GPU/CPU key sorting, particle binning): histogram → prefix-sum → scatter,
// ping-ponging between two buffers. Its gather/scatter memory pattern is distinct
// from the suite's compare-swap heapsort, and it is pure 32-bit integer
// throughout, so the sorted output is bit-identical across every engine and
// native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Uint32Array/Int32Array, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in keys/µs, FNV-1a checksum over
// the sorted key array.
const std = @import("std");
const Io = std.Io;

const N = 1 << 14;   // 16384 keys
const RADIX = 256;   // 8-bit digit
const PASSES = 4;    // 32-bit keys / 8-bit digits
const N_ITERS = 40;  // sorts per kernel run
const N_RUNS = 21;
const N_WARMUP = 5;

fn nowMs() f64 {
    var ts: std.c.timespec = undefined;
    _ = std.c.clock_gettime(std.c.CLOCK.MONOTONIC, &ts);
    return @as(f64, @floatFromInt(ts.sec)) * 1000.0 + @as(f64, @floatFromInt(ts.nsec)) / 1_000_000.0;
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

fn checksumU32(out: []const u32) u32 {
    var h: u32 = 0x811c9dc5;
    const stride: usize = 128;
    var i: usize = 0;
    while (i < out.len) : (i += stride) {
        h = (h ^ out[i]) *% 0x01000193;
    }
    return h;
}

// Deterministic u32 keys — XorShift32, identical per target.
fn fill(out: []u32) void {
    var s: u32 = 0x1234abcd;
    var i: usize = 0;
    while (i < N) : (i += 1) {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        out[i] = s;
    }
}

// LSD radix sort: 4 stable counting-sort passes over 8-bit digits, ping-ponging
// a → b. PASSES is even, so the sorted result lands back in `a`.
fn radixSort(src: []u32, tmp: []u32, count: []u32) void {
    var a = src;
    var b = tmp;
    var shift: u5 = 0;
    var pass: usize = 0;
    while (pass < PASSES) : (pass += 1) {
        // zero histogram
        var i: usize = 0;
        while (i < RADIX) : (i += 1) count[i] = 0;
        // histogram
        i = 0;
        while (i < N) : (i += 1) count[(a[i] >> shift) & 0xff] += 1;
        // prefix sum
        var sum: u32 = 0;
        i = 0;
        while (i < RADIX) : (i += 1) {
            const c = count[i];
            count[i] = sum;
            sum += c;
        }
        // scatter
        i = 0;
        while (i < N) : (i += 1) {
            const d = (a[i] >> shift) & 0xff;
            b[count[d]] = a[i];
            count[d] += 1;
        }
        // ping-pong
        const t = a;
        a = b;
        b = t;
        shift += 8;
    }
}

fn runKernel(a: []u32, base: []const u32, tmp: []u32, count: []u32) void {
    var it: u32 = 0;
    while (it < N_ITERS) : (it += 1) {
        var i: usize = 0;
        while (i < N) : (i += 1) a[i] = base[i] +% it;
        radixSort(a, tmp, count);
    }
}

pub fn main(init_args: std.process.Init) !void {
    const io = init_args.io;
    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    const allocator = std.heap.page_allocator;
    const base = try allocator.alloc(u32, N);
    const a = try allocator.alloc(u32, N);
    const tmp = try allocator.alloc(u32, N);
    const count = try allocator.alloc(u32, RADIX);
    defer allocator.free(base);
    defer allocator.free(a);
    defer allocator.free(tmp);
    defer allocator.free(count);

    fill(base);

    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) runKernel(a, base, tmp, count);

    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = nowMs();
        runKernel(a, base, tmp, count);
        samples[i] = nowMs() - t0;
    }

    const cs = checksumU32(a);
    try stdout.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{ medianUs(&samples), cs, N * N_ITERS, PASSES, N_RUNS });
    try stdout.flush();
}
