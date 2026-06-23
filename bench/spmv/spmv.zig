// spmv.zig — sparse matrix × dense vector in CSR form (y = A·x). The canonical
// sparse-linear-algebra kernel (iterative solvers, PageRank, GNN message passing,
// FEM): the inner loop is a multiply-accumulate whose vector operand is an
// INDIRECT gather x[col[k]] through a column-index array. That data-dependent
// gather — distinct from the suite's contiguous reductions — is the access
// pattern dense codegen handles worst.
//
// Values and x are small integers, so each product and the row sum are exact in
// f64 regardless of summation order or FMA fusion — the result vector is
// bit-identical across every engine and native target (no fma parity class here).
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Float64Array/Int32Array, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in nonzeros/µs, FNV-1a checksum
// over the result vector.
const std = @import("std");
const Io = std.Io;

const ROWS: usize = 4096;
const NPR: usize = 16; // nonzeros per row
const NNZ: usize = ROWS * NPR;
const N_ITERS: usize = 80; // SpMV passes per kernel run
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

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

// XorShift32 — must match JS: s ^= s<<13; s ^= s>>>17; s ^= s<<5; return s>>>0
// In JS, shifts on signed int32 then >>> 0 gives unsigned result.
// We track state as i32 (wrapping), return u32.
var xorState: i32 = undefined;

fn xorNext() u32 {
    var s = xorState;
    s ^= s << 13;
    s ^= @as(i32, @bitCast(@as(u32, @bitCast(s)) >> 17));
    s ^= s << 5;
    xorState = s;
    return @as(u32, @bitCast(s));
}

fn build(rowPtr: []i32, colIdx: []i32, values: []f64, x: []f64) void {
    xorState = @bitCast(@as(u32, 0x1234abcd));
    // rowPtr[r] = r * NPR
    var r: usize = 0;
    while (r <= ROWS) : (r += 1) rowPtr[r] = @intCast(r * NPR);
    // colIdx and values
    var k: usize = 0;
    while (k < NNZ) : (k += 1) {
        colIdx[k] = @intCast(xorNext() % ROWS);
        const raw: i32 = @intCast(@as(i64, xorNext() % 9) - 4);
        values[k] = @floatFromInt(raw);
    }
    // x
    var i: usize = 0;
    while (i < ROWS) : (i += 1) {
        const raw: i32 = @intCast(@as(i64, xorNext() % 7) - 3);
        x[i] = @floatFromInt(raw);
    }
}

fn spmv(rowPtr: []const i32, colIdx: []const i32, values: []const f64, x: []const f64, y: []f64) void {
    var r: usize = 0;
    while (r < ROWS) : (r += 1) {
        var sum: f64 = 0;
        const end: usize = @intCast(rowPtr[r + 1]);
        var kk: usize = @intCast(rowPtr[r]);
        while (kk < end) : (kk += 1) {
            sum += values[kk] * x[@intCast(colIdx[kk])];
        }
        y[r] = sum;
    }
}

fn runKernel(rowPtr: []const i32, colIdx: []const i32, values: []const f64, x: []f64, y: []f64) void {
    var it: usize = 0;
    while (it < N_ITERS) : (it += 1) {
        spmv(rowPtr, colIdx, values, x, y);
        var i: usize = 0;
        while (i < ROWS) : (i += 1) x[i] = x[i] + 1.0;
    }
}

// checksumF64: treat Float64Array as Uint32Array (stride 256 over u32 indices)
// JS: u = Uint32Array(y.buffer, 0, y.length*2); stride=256
// h = FNV mix: h = imul(h ^ u[i], 0x01000193) — signed i32 wrapping, then |0
// final: h >>> 0
fn checksumF64(y: []const f64) u32 {
    // Reinterpret y as u32 array (each f64 = 2 u32s)
    const u_len: usize = y.len * 2;
    var h: i32 = @bitCast(@as(u32, 0x811c9dc5));
    const stride: usize = 256;
    var i: usize = 0;
    while (i < u_len) : (i += stride) {
        // Get the u32 at index i (which f64 element and which half)
        const f64_idx = i / 2;
        const half = i % 2; // 0 = low word, 1 = high word
        const bits: u64 = @bitCast(y[f64_idx]);
        const u_val: u32 = if (half == 0)
            @truncate(bits)
        else
            @truncate(bits >> 32);
        const x_val: i32 = @bitCast(u_val);
        h = @bitCast(@as(u32, @bitCast(h ^ x_val)) *% @as(u32, 0x01000193));
    }
    return @bitCast(h);
}

pub fn main(init_args: std.process.Init) !void {
    const io = init_args.io;
    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    const allocator = std.heap.page_allocator;
    const rowPtr = try allocator.alloc(i32, ROWS + 1);
    const colIdx = try allocator.alloc(i32, NNZ);
    const values = try allocator.alloc(f64, NNZ);
    const x = try allocator.alloc(f64, ROWS);
    const y = try allocator.alloc(f64, ROWS);
    defer allocator.free(rowPtr);
    defer allocator.free(colIdx);
    defer allocator.free(values);
    defer allocator.free(x);
    defer allocator.free(y);

    // Warmup
    var wi: usize = 0;
    while (wi < N_WARMUP) : (wi += 1) {
        build(rowPtr, colIdx, values, x);
        runKernel(rowPtr, colIdx, values, x, y);
    }

    var samples = [_]f64{0} ** N_RUNS;
    var i: usize = 0;
    while (i < N_RUNS) : (i += 1) {
        build(rowPtr, colIdx, values, x);
        const t0 = nowMs();
        runKernel(rowPtr, colIdx, values, x, y);
        samples[i] = nowMs() - t0;
    }

    const cs = checksumF64(y);
    try stdout.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{ medianUs(&samples), cs, NNZ * N_ITERS, 2, N_RUNS });
    try stdout.flush();
}
