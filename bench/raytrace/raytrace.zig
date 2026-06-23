// raytrace.zig — a minimal sphere ray tracer: one primary ray per pixel, a
// closest-hit search over a small sphere scene, then Lambert diffuse + ambient
// shading into an f64 framebuffer. The canonical 3-D rendering kernel — a branchy,
// loop-carried scalar pipeline (ray–sphere quadratic, closest-hit select, normal
// + light dot product) that no target auto-vectorizes, so it is a pure
// scalar-codegen race.
//
// Transcendental-free: only +,-,*,/ and sqrt, all IEEE-754 correctly-rounded, so
// the framebuffer is bit-identical across engines and native targets. Go's arm64
// backend force-fuses a*b+c → FMADDD (no flag to disable), so its checksum is the
// documented `fma` parity class, like fft/synth/biquad — same algorithm, last-ulp
// rounding only.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Float64Array, Math.sqrt, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in pixels/µs, FNV-1a checksum over
// the rendered framebuffer.
const std = @import("std");
const Io = std.Io;

const W: usize = 384;
const H: usize = 384;
const NS: usize = 8;
const N_RUNS = 21;
const N_WARMUP = 5;

fn nowMs() f64 {
    var ts: std.c.timespec = undefined;
    _ = std.c.clock_gettime(std.c.CLOCK.MONOTONIC, &ts);
    return @as(f64, @floatFromInt(ts.sec)) * 1000.0 + @as(f64, @floatFromInt(ts.nsec)) / 1_000_000.0;
}

fn mix(h: u32, x: u32) u32 {
    return (h ^ x) *% 0x01000193;
}

fn checksumF64(o: []const f64) u32 {
    var h: u32 = 0x811c9dc5;
    var i: usize = 0;
    while (i < o.len * 2) : (i += 256) {
        const b: u64 = @bitCast(o[i / 2]);
        const w: u32 = if ((i & 1) == 0) @truncate(b) else @truncate(b >> 32);
        h = mix(h, w);
    }
    return h;
}

fn medianUs(s: *[N_RUNS]f64) u64 {
    var i: usize = 1;
    while (i < s.len) : (i += 1) {
        const v = s[i];
        var j = i;
        while (j > 0 and s[j - 1] > v) : (j -= 1) s[j] = s[j - 1];
        s[j] = v;
    }
    return @intFromFloat(s[(s.len - 1) >> 1] * 1000.0);
}

fn buildScene(sx: []f64, sy: []f64, sz: []f64, sr: []f64, cr: []f64, cg: []f64, cb: []f64) void {
    var i: usize = 0;
    while (i < NS) : (i += 1) {
        const fi = @as(f64, @floatFromInt(i));
        sx[i] = (@as(f64, @floatFromInt(@as(i32, @intCast(i % 3)))) - 1.0) * 2.2;
        sy[i] = (@as(f64, @floatFromInt(@as(i32, @intCast(i / 3)))) - 1.0) * 1.6;
        sz[i] = -5.0 - fi * 1.3;
        sr[i] = 0.7 + @as(f64, @floatFromInt(i % 4)) * 0.18;
        cr[i] = 0.30 + @as(f64, @floatFromInt(i % 5)) * 0.14;
        cg[i] = 0.25 + @as(f64, @floatFromInt(i % 3)) * 0.24;
        cb[i] = 0.40 + @as(f64, @floatFromInt(i % 7)) * 0.08;
    }
}

fn render(fb: []f64, sx: []const f64, sy: []const f64, sz: []const f64, sr: []const f64,
          cr: []const f64, cg: []const f64, cb: []const f64,
          lx: f64, ly: f64, lz: f64) void {
    var py: usize = 0;
    while (py < H) : (py += 1) {
        const sv = 1.0 - (@as(f64, @floatFromInt(py)) + 0.5) / @as(f64, @floatFromInt(H)) * 2.0;
        var px: usize = 0;
        while (px < W) : (px += 1) {
            const su = (@as(f64, @floatFromInt(px)) + 0.5) / @as(f64, @floatFromInt(W)) * 2.0 - 1.0;
            var dx = su;
            var dy = sv;
            var dz: f64 = -1.0;
            const dinv = 1.0 / @sqrt(dx * dx + dy * dy + dz * dz);
            dx = dx * dinv;
            dy = dy * dinv;
            dz = dz * dinv;

            var tBest: f64 = 1e30;
            var hit: i32 = -1;
            var s: usize = 0;
            while (s < NS) : (s += 1) {
                const ox = -sx[s];
                const oy = -sy[s];
                const oz = -sz[s];
                const b = ox * dx + oy * dy + oz * dz;
                const c = ox * ox + oy * oy + oz * oz - sr[s] * sr[s];
                const disc = b * b - c;
                if (disc > 0.0) {
                    const t = -b - @sqrt(disc);
                    if (t > 0.001 and t < tBest) {
                        tBest = t;
                        hit = @intCast(s);
                    }
                }
            }

            var r: f64 = 0.0;
            var g: f64 = 0.0;
            var bl: f64 = 0.0;
            if (hit >= 0) {
                const h_idx = @as(usize, @intCast(hit));
                const hx = dx * tBest;
                const hy = dy * tBest;
                const hz = dz * tBest;
                var nx = hx - sx[h_idx];
                var ny = hy - sy[h_idx];
                var nz = hz - sz[h_idx];
                const ninv = 1.0 / @sqrt(nx * nx + ny * ny + nz * nz);
                nx = nx * ninv;
                ny = ny * ninv;
                nz = nz * ninv;
                var diff = nx * lx + ny * ly + nz * lz;
                if (diff < 0.0) diff = 0.0;
                const shade = 0.15 + 0.85 * diff;
                r = cr[h_idx] * shade;
                g = cg[h_idx] * shade;
                bl = cb[h_idx] * shade;
            }
            const o = (py * W + px) * 3;
            fb[o] = r;
            fb[o + 1] = g;
            fb[o + 2] = bl;
        }
    }
}

pub fn main(init_args: std.process.Init) !void {
    const io = init_args.io;
    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    const allocator = std.heap.page_allocator;
    const sx = try allocator.alloc(f64, NS);
    const sy = try allocator.alloc(f64, NS);
    const sz = try allocator.alloc(f64, NS);
    const sr = try allocator.alloc(f64, NS);
    const cr = try allocator.alloc(f64, NS);
    const cg = try allocator.alloc(f64, NS);
    const cb = try allocator.alloc(f64, NS);
    defer allocator.free(sx);
    defer allocator.free(sy);
    defer allocator.free(sz);
    defer allocator.free(sr);
    defer allocator.free(cr);
    defer allocator.free(cg);
    defer allocator.free(cb);

    buildScene(sx, sy, sz, sr, cr, cg, cb);

    const fb = try allocator.alloc(f64, W * H * 3);
    defer allocator.free(fb);

    const llen = 1.0 / @sqrt(0.6 * 0.6 + 1.0 * 1.0 + 0.5 * 0.5);
    const lx: f64 = -0.6 * llen;
    const ly: f64 = 1.0 * llen;
    const lz: f64 = 0.5 * llen;

    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) render(fb, sx, sy, sz, sr, cr, cg, cb, lx, ly, lz);

    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = nowMs();
        render(fb, sx, sy, sz, sr, cr, cg, cb, lx, ly, lz);
        samples[i] = nowMs() - t0;
    }

    const cs = checksumF64(fb);
    try stdout.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{ medianUs(&samples), cs, W * H, NS, N_RUNS });
    try stdout.flush();
}
