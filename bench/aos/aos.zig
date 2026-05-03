const std = @import("std");

const N = 16384;
const N_ITERS = 64;
const N_RUNS = 21;
const N_WARMUP = 5;

fn nowMs() f64 {
    var ts: std.c.timespec = undefined;
    _ = std.c.clock_gettime(std.c.CLOCK.MONOTONIC, &ts);
    return @as(f64, @floatFromInt(ts.sec)) * 1000.0 + @as(f64, @floatFromInt(ts.nsec)) / 1_000_000.0;
}

const Row = struct {
    x: f64,
    y: f64,
    z: f64,
};

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

fn initRows(rows: []Row) void {
    for (rows, 0..) |*row, i| {
        row.* = .{
            .x = @as(f64, @floatFromInt(i)) * 0.5,
            .y = @as(f64, @floatFromInt(i)) + 1.0,
            .z = @as(f64, @floatFromInt(@as(i32, @intCast(i & 7)) - 3)),
        };
    }
}

fn runKernel(rows: []const Row, xs: []f64, ys: []f64, zs: []f64) void {
    var r: usize = 0;
    while (r < N_ITERS) : (r += 1) {
        const rf = @as(f64, @floatFromInt(r));
        for (rows, 0..) |p, i| {
            xs[i] = p.x + p.y * 0.25 + rf;
            ys[i] = p.y - p.z * 0.5;
            zs[i] = p.z + p.x * 0.125;
        }
    }
}

pub fn main() !void {
    const allocator = std.heap.page_allocator;
    const rows = try allocator.alloc(Row, N);
    const xs = try allocator.alloc(f64, N);
    const ys = try allocator.alloc(f64, N);
    const zs = try allocator.alloc(f64, N);
    defer allocator.free(rows);
    defer allocator.free(xs);
    defer allocator.free(ys);
    defer allocator.free(zs);

    initRows(rows);
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) runKernel(rows, xs, ys, zs);
    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = nowMs();
        runKernel(rows, xs, ys, zs);
        samples[i] = nowMs() - t0;
    }
    const cs = checksumF64(xs) ^ checksumF64(ys) ^ checksumF64(zs);
    const stdout = std.io.getStdOut().writer();
    try stdout.print("median_us={} checksum={} samples={} stages={} runs={}\n", .{ medianUs(&samples), cs, N * N_ITERS, 3, N_RUNS });
}
