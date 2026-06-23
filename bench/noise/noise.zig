// noise.zig — 2-D Perlin gradient noise summed over several octaves (fractal
// Brownian motion), the canonical procedural-generation kernel (terrain heights,
// textures, clouds, displacement). A permutation-table hash feeds gradient dot
// products blended by a quintic smoothstep — integer table lookups interleaved
// with loop-carried f64 interpolation, an ALU/memory mix distinct from the
// suite's other loops.
//
// Transcendental-free (+,-,*; no trig/pow), and the sample coordinates stay
// non-negative so Math.floor never straddles zero, so the field is bit-identical
// across engines and native targets. Go's arm64 auto-FMA of the lerp chains gives
// the documented `fma` parity class, like fft/synth.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Float64Array/Int32Array,
// Math.floor, no class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in samples/µs, FNV-1a checksum over
// the generated field.
const std = @import("std");
const Io = std.Io;

const W = 256;
const H = 256;
const OCT = 5;
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

fn mix(h: u32, x: u32) u32 {
    return (h ^ x) *% 0x01000193;
}

// checksumF64: treat the f64 array as u32 pairs, sample every 256 u32 elements
fn checksumF64(field: []const f64) u32 {
    const stride: usize = 256;
    var h: u32 = 0x811c9dc5;
    // Reinterpret f64 slice as u32 slice
    const bytes = std.mem.sliceAsBytes(field);
    const u32s = std.mem.bytesAsSlice(u32, bytes);
    var i: usize = 0;
    while (i < u32s.len) : (i += stride) {
        h = mix(h, u32s[i]);
    }
    return h;
}

fn buildPerm(perm: []i32) void {
    var i: usize = 0;
    while (i < 256) : (i += 1) perm[i] = @intCast(i);
    var s: u32 = 0x1234abcd;
    i = 255;
    while (i > 0) : (i -= 1) {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        const j: usize = s % (@as(u32, @intCast(i)) + 1);
        const t = perm[i];
        perm[i] = perm[j];
        perm[j] = t;
    }
    i = 0;
    while (i < 256) : (i += 1) perm[256 + i] = perm[i];
}

fn fade(t: f64) f64 {
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

fn lerp(a: f64, b: f64, t: f64) f64 {
    return a + t * (b - a);
}

fn grad(hash: i32, x: f64, y: f64) f64 {
    const h = hash & 3;
    const u: f64 = if ((h & 1) == 0) x else -x;
    const v: f64 = if ((h & 2) == 0) y else -y;
    return u + v;
}

fn perlin(perm: []const i32, x: f64, y: f64) f64 {
    const xi: i32 = @intFromFloat(@floor(x));
    const yi: i32 = @intFromFloat(@floor(y));
    const xf: f64 = x - @as(f64, @floatFromInt(xi));
    const yf: f64 = y - @as(f64, @floatFromInt(yi));
    const X: usize = @intCast(xi & 255);
    const Y: usize = @intCast(yi & 255);
    const u = fade(xf);
    const v = fade(yf);
    const aa = perm[@intCast(perm[X] + @as(i32, @intCast(Y)))];
    const ab = perm[@intCast(perm[X] + @as(i32, @intCast(Y)) + 1)];
    const ba = perm[@intCast(perm[X + 1] + @as(i32, @intCast(Y)))];
    const bb = perm[@intCast(perm[X + 1] + @as(i32, @intCast(Y)) + 1)];
    const x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1.0, yf), u);
    const x2 = lerp(grad(ab, xf, yf - 1.0), grad(bb, xf - 1.0, yf - 1.0), u);
    return lerp(x1, x2, v);
}

fn fbm(perm: []const i32, x: f64, y: f64) f64 {
    var sum: f64 = 0.0;
    var amp: f64 = 0.5;
    var freq: f64 = 1.0;
    var o: usize = 0;
    while (o < OCT) : (o += 1) {
        sum = sum + amp * perlin(perm, x * freq, y * freq);
        freq = freq * 2.0;
        amp = amp * 0.5;
    }
    return sum;
}

fn render(perm: []const i32, field: []f64) void {
    var py: usize = 0;
    while (py < H) : (py += 1) {
        const y: f64 = @as(f64, @floatFromInt(py)) * 0.03125;
        var px: usize = 0;
        while (px < W) : (px += 1) {
            const x: f64 = @as(f64, @floatFromInt(px)) * 0.03125;
            field[py * W + px] = fbm(perm, x, y);
        }
    }
}

pub fn main(init_args: std.process.Init) !void {
    const io = init_args.io;
    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    const allocator = std.heap.page_allocator;
    const perm = try allocator.alloc(i32, 512);
    const field = try allocator.alloc(f64, W * H);
    defer allocator.free(perm);
    defer allocator.free(field);

    buildPerm(perm);

    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) render(perm, field);

    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = nowMs();
        render(perm, field);
        samples[i] = nowMs() - t0;
    }

    const cs = checksumF64(field);
    try stdout.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{ medianUs(&samples), cs, W * H, OCT, N_RUNS });
    try stdout.flush();
}
