const std = @import("std");
const Io = std.Io;

const N = 4096;
const WINDOW = 1024;
const MIN_MATCH = 3;
const MAX_MATCH = 18;
const CAP = N * 2 + 64;
const N_ITERS = 5;
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

fn initBuf(buf: *[N]u8) void {
    var x: i32 = 0x12345678;
    var i: usize = 0;
    while (i < N) : (i += 1) {
        x = x *% 1103515245 +% 12345;
        if (i > 64 and (x & 0x70) == 0) {
            const back: usize = 1 + @as(usize, @intCast((@as(u32, @bitCast(x)) >> 8) & 63));
            buf[i] = buf[i - back];
        } else {
            buf[i] = @intCast((@as(u32, @bitCast(x)) >> 16) & 0xff);
        }
    }
}

fn compress(src: *const [N]u8, nn: usize, out: *[CAP]u8) usize {
    var op: usize = 0;
    var ip: usize = 0;
    while (ip < nn) {
        const ctrl_pos = op;
        op += 1;
        var ctrl: u8 = 0;
        var b: usize = 0;
        while (b < 8 and ip < nn) : (b += 1) {
            const start: usize = if (ip >= WINDOW) ip - WINDOW else 0;
            const max_len: usize = @min(nn - ip, MAX_MATCH);
            var best_len: usize = 0;
            var best_dist: usize = 0;
            var j: usize = ip;
            while (j > start) {
                j -= 1;
                var len: usize = 0;
                while (len < max_len and src[j + len] == src[ip + len]) : (len += 1) {}
                if (len > best_len) {
                    best_len = len;
                    best_dist = ip - j;
                    if (len >= max_len) break;
                }
            }
            if (best_len >= MIN_MATCH) {
                ctrl |= @as(u8, 1) << @intCast(b);
                const code: u32 = @as(u32, @intCast((best_dist - 1) << 4)) | @as(u32, @intCast(best_len - MIN_MATCH));
                out[op]     = @intCast((code >> 8) & 0xff);
                out[op + 1] = @intCast(code & 0xff);
                op += 2;
                ip += best_len;
            } else {
                out[op] = src[ip];
                op += 1;
                ip += 1;
            }
        }
        out[ctrl_pos] = ctrl;
    }
    return op;
}

fn inflate(inp: *const [CAP]u8, clen: usize, dst: *[N]u8) usize {
    var ip: usize = 0;
    var op: usize = 0;
    while (ip < clen) {
        const ctrl = inp[ip];
        ip += 1;
        var b: usize = 0;
        while (b < 8 and ip < clen) : (b += 1) {
            if ((ctrl & (@as(u8, 1) << @intCast(b))) != 0) {
                const code: u32 = (@as(u32, inp[ip]) << 8) | @as(u32, inp[ip + 1]);
                ip += 2;
                const dist: usize = @as(usize, code >> 4) + 1;
                const len: usize  = @as(usize, code & 0x0f) + MIN_MATCH;
                var k: usize = 0;
                while (k < len) : (k += 1) {
                    dst[op] = dst[op - dist];
                    op += 1;
                }
            } else {
                dst[op] = inp[ip];
                op += 1;
                ip += 1;
            }
        }
    }
    return op;
}

fn runKernel(src: *[N]u8, comp: *[CAP]u8, dec: *[N]u8) u32 {
    var h: u32 = 0;
    var it: usize = 0;
    while (it < N_ITERS) : (it += 1) {
        const clen = compress(src, N, comp);
        const dlen = inflate(comp, clen, dec);
        var ok: u32 = if (dlen == N) 1 else 0;
        var i: usize = 0;
        while (i < N) : (i += 1) {
            if (dec[i] != src[i]) ok = 0;
        }
        h = mix(h, @intCast(clen));
        i = 0;
        while (i < clen) : (i += 1) h = mix(h, @as(u32, comp[i]));
        h = mix(h, ok);
        const j = it % N;
        src[j] +%= 1;
    }
    return h;
}

pub fn main(init_args: std.process.Init) !void {
    const io = init_args.io;
    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    var src = [_]u8{0} ** N;
    var comp = [_]u8{0} ** CAP;
    var dec = [_]u8{0} ** N;
    initBuf(&src);
    var cs: u32 = 0;
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) cs = runKernel(&src, &comp, &dec);
    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = nowMs();
        cs = runKernel(&src, &comp, &dec);
        samples[i] = nowMs() - t0;
    }
    try stdout.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{ medianUs(&samples), cs, N * N_ITERS, 1, N_RUNS });
    try stdout.flush();
}
