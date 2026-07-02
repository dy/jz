// immutable.zig — a particle step in the immutable-update idiom: every step
// replaces each record wholesale instead of mutating fields. The canonical
// functional-state kernel (reducers, persistent game state, event-sourced
// models). Zig gets the pattern free through value semantics — a struct
// assigned by value, zero allocation — the static reference for what the
// fresh-object JS idiom costs. Pure integer bounce physics, so positions are
// bit-identical across every engine and native target.
//
// Reports: median ms across N_RUNS, throughput in particle-steps/µs, FNV-1a
// checksum over the per-pass position folds.
const std = @import("std");
const bench = @import("bench");

const N: usize = 4096;         // particles
const STEPS: usize = 32;       // steps per pass (one record replacement per particle per step)
const LIM: i32 = 1023;         // box bound
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

const P = struct { x: i32, y: i32, vx: i32, vy: i32 };

var ps: [N]P = undefined;

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

// Deterministic initial state — XorShift32 positions in [0, LIM], velocities
// in [-8, 8] forced nonzero, identical per target.
fn initParticles() void {
    var s: i32 = @bitCast(@as(u32, 0x1234abcd));
    var i: usize = 0;
    while (i < N) : (i += 1) {
        s ^= s << 13;
        s ^= @as(i32, @bitCast(@as(u32, @bitCast(s)) >> 17));
        s ^= s << 5;
        const vx: i32 = @as(i32, @intCast((@as(u32, @bitCast(s)) >> 4) & 15)) - 8;
        const vy: i32 = @as(i32, @intCast((@as(u32, @bitCast(s)) >> 8) & 15)) - 8;
        ps[i] = .{
            .x = @intCast((@as(u32, @bitCast(s)) >> 12) & @as(u32, @intCast(LIM))),
            .y = @intCast((@as(u32, @bitCast(s)) >> 20) & @as(u32, @intCast(LIM))),
            .vx = if (vx == 0) 1 else vx,
            .vy = if (vy == 0) 1 else vy,
        };
    }
}

fn runKernel() u32 {
    var h: u32 = 0x811c9dc5;
    var it: usize = 0;
    while (it < STEPS) : (it += 1) {
        var sum: i32 = @intCast(it);
        var i: usize = 0;
        while (i < N) : (i += 1) {
            const p = ps[i];
            const nx = p.x + p.vx;
            const ny = p.y + p.vy;
            const hitX = nx < 0 or nx > LIM;
            const hitY = ny < 0 or ny > LIM;
            const x = if (hitX) p.x else nx;
            const y = if (hitY) p.y else ny;
            const vx = if (hitX) -p.vx else p.vx;
            const vy = if (hitY) -p.vy else p.vy;
            ps[i] = .{ .x = x, .y = y, .vx = vx, .vy = vy };
            sum = @bitCast(@as(u32, @bitCast(sum)) +% @as(u32, @bitCast(x)) +% @as(u32, @bitCast(y)) *% 31);
        }
        h = mix(h, @bitCast(sum));
    }
    return h;
}

pub fn main() !void {
    var cs: u32 = 0;
    // Fresh particle set per run — the kernel mutates the array, so timing runs
    // must not compound each other's motion.
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) {
        initParticles();
        cs = runKernel();
    }

    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        initParticles();
        const t0 = bench.nowMs();
        cs = runKernel();
        samples[i] = bench.nowMs() - t0;
    }
    bench.printResult(medianUs(&samples), cs, N * STEPS, 1, N_RUNS);
}
