const std = @import("std");
const Io = std.Io;

const NPIX: usize = 256 * 256;
const IMG_LEN: usize = NPIX * 4;
const CAP: usize = NPIX * 5 + 64;
const N_ITERS: usize = 10;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

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

fn mkImage(img: *[IMG_LEN]u8) void {
    var x: i32 = 0x12345678;
    var r: u8 = 128;
    var g: u8 = 128;
    var b: u8 = 128;
    var a: u8 = 255;
    var p: usize = 0;
    while (p < NPIX) : (p += 1) {
        x = x *% 1103515245 +% 12345;
        const ux: u32 = @bitCast(x);
        const roll: u32 = (ux >> 28) & 7;
        if (roll < 3) {
            // keep previous pixel - run-length
        } else if (roll < 6) {
            r = @truncate(@as(u32, r) +% ((ux >> 4) & 3) -% 1);
            g = @truncate(@as(u32, g) +% ((ux >> 6) & 3) -% 1);
            b = @truncate(@as(u32, b) +% ((ux >> 8) & 3) -% 1);
        } else if (roll == 6) {
            r = @truncate((ux >> 10) & 255);
            g = @truncate((ux >> 16) & 255);
            b = @truncate((ux >> 20) & 255);
        } else {
            a = @truncate((ux >> 12) & 255);
        }
        const o = p << 2;
        img[o] = r; img[o + 1] = g; img[o + 2] = b; img[o + 3] = a;
    }
}

fn encode(img: *const [IMG_LEN]u8, ir: *[64]u8, ig: *[64]u8, ib: *[64]u8, ia: *[64]u8, out: *[CAP]u8) usize {
    var i: usize = 0;
    while (i < 64) : (i += 1) { ir[i] = 0; ig[i] = 0; ib[i] = 0; ia[i] = 0; }
    var pr: u8 = 0; var pg: u8 = 0; var pb: u8 = 0; var pa: u8 = 255;
    var run: i32 = 0;
    var op: usize = 0;
    var p: usize = 0;
    while (p < NPIX) : (p += 1) {
        const o = p << 2;
        const r = img[o]; const g = img[o + 1]; const b = img[o + 2]; const a = img[o + 3];
        if (r == pr and g == pg and b == pb and a == pa) {
            run += 1;
            if (run == 62 or p == NPIX - 1) {
                out[op] = @as(u8, 0xc0) | @as(u8, @intCast(run - 1)); op += 1; run = 0;
            }
        } else {
            if (run > 0) { out[op] = @as(u8, 0xc0) | @as(u8, @intCast(run - 1)); op += 1; run = 0; }
            const h: usize = @intCast((@as(u32, r) * 3 + @as(u32, g) * 5 + @as(u32, b) * 7 + @as(u32, a) * 11) & 63);
            if (ir[h] == r and ig[h] == g and ib[h] == b and ia[h] == a) {
                out[op] = @intCast(h); op += 1;
            } else {
                ir[h] = r; ig[h] = g; ib[h] = b; ia[h] = a;
                if (a == pa) {
                    // signed-8-bit wraparound: cast u8 to i8 via bitCast, then extend to i32
                    const vr: i32 = @as(i32, @as(i8, @bitCast(r -% pr)));
                    const vg: i32 = @as(i32, @as(i8, @bitCast(g -% pg)));
                    const vb: i32 = @as(i32, @as(i8, @bitCast(b -% pb)));
                    const vgr: i32 = vr - vg;
                    const vgb: i32 = vb - vg;
                    if (vr >= -2 and vr <= 1 and vg >= -2 and vg <= 1 and vb >= -2 and vb <= 1) {
                        out[op] = @intCast(0x40 | ((vr + 2) << 4) | ((vg + 2) << 2) | (vb + 2)); op += 1;
                    } else if (vgr >= -8 and vgr <= 7 and vg >= -32 and vg <= 31 and vgb >= -8 and vgb <= 7) {
                        out[op] = @intCast(0x80 | (vg + 32)); op += 1;
                        out[op] = @intCast(((vgr + 8) << 4) | (vgb + 8)); op += 1;
                    } else {
                        out[op] = 0xfe; op += 1; out[op] = r; op += 1; out[op] = g; op += 1; out[op] = b; op += 1;
                    }
                } else {
                    out[op] = 0xff; op += 1; out[op] = r; op += 1; out[op] = g; op += 1; out[op] = b; op += 1; out[op] = a; op += 1;
                }
            }
        }
        pr = r; pg = g; pb = b; pa = a;
    }
    return op;
}

fn decode(inp: *const [CAP]u8, clen: usize, ir: *[64]u8, ig: *[64]u8, ib: *[64]u8, ia: *[64]u8, out: *[IMG_LEN]u8) void {
    var i: usize = 0;
    while (i < 64) : (i += 1) { ir[i] = 0; ig[i] = 0; ib[i] = 0; ia[i] = 0; }
    var pr: u8 = 0; var pg: u8 = 0; var pb: u8 = 0; var pa: u8 = 255;
    var run: i32 = 0;
    var ip: usize = 0;
    var p: usize = 0;
    while (p < NPIX) : (p += 1) {
        if (run > 0) {
            run -= 1;
        } else if (ip < clen) {
            const b0: i32 = @as(i32, inp[ip]); ip += 1;
            if (b0 == 0xfe) {
                pr = inp[ip]; ip += 1; pg = inp[ip]; ip += 1; pb = inp[ip]; ip += 1;
            } else if (b0 == 0xff) {
                pr = inp[ip]; ip += 1; pg = inp[ip]; ip += 1; pb = inp[ip]; ip += 1; pa = inp[ip]; ip += 1;
            } else if ((b0 & 0xc0) == 0x00) {
                const idx: usize = @intCast(b0);
                pr = ir[idx]; pg = ig[idx]; pb = ib[idx]; pa = ia[idx];
            } else if ((b0 & 0xc0) == 0x40) {
                pr = @truncate(@as(u32, @bitCast((@as(i32, pr) + ((b0 >> 4) & 3) - 2) & 255)));
                pg = @truncate(@as(u32, @bitCast((@as(i32, pg) + ((b0 >> 2) & 3) - 2) & 255)));
                pb = @truncate(@as(u32, @bitCast((@as(i32, pb) + (b0 & 3) - 2) & 255)));
            } else if ((b0 & 0xc0) == 0x80) {
                const b1: i32 = @as(i32, inp[ip]); ip += 1;
                const vg: i32 = (b0 & 63) - 32;
                pr = @truncate(@as(u32, @bitCast((@as(i32, pr) + vg + ((b1 >> 4) & 15) - 8) & 255)));
                pg = @truncate(@as(u32, @bitCast((@as(i32, pg) + vg) & 255)));
                pb = @truncate(@as(u32, @bitCast((@as(i32, pb) + vg + (b1 & 15) - 8) & 255)));
            } else {
                run = b0 & 63;
            }
            const h: usize = @intCast((@as(u32, pr) * 3 + @as(u32, pg) * 5 + @as(u32, pb) * 7 + @as(u32, pa) * 11) & 63);
            ir[h] = pr; ig[h] = pg; ib[h] = pb; ia[h] = pa;
        }
        const o = p << 2;
        out[o] = pr; out[o + 1] = pg; out[o + 2] = pb; out[o + 3] = pa;
    }
}

fn runKernel(img: *[IMG_LEN]u8, ir: *[64]u8, ig: *[64]u8, ib: *[64]u8, ia: *[64]u8, comp: *[CAP]u8, dec: *[IMG_LEN]u8) u32 {
    var h: u32 = 0;
    var it: usize = 0;
    while (it < N_ITERS) : (it += 1) {
        const clen = encode(img, ir, ig, ib, ia, comp);
        decode(comp, clen, ir, ig, ib, ia, dec);
        var ok: u32 = 1;
        var i: usize = 0;
        while (i < IMG_LEN) : (i += 1) {
            if (dec[i] != img[i]) ok = 0;
        }
        h = mix(h, @intCast(clen));
        i = 0;
        while (i < clen) : (i += 1) h = mix(h, @as(u32, comp[i]));
        h = mix(h, ok);
        const j = (it % NPIX) << 2;
        img[j] +%= 1;
    }
    return h;
}

pub fn main(init_args: std.process.Init) !void {
    const io = init_args.io;
    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    const ally = std.heap.c_allocator;
    const img_buf = try ally.alloc(u8, IMG_LEN);
    defer ally.free(img_buf);
    const comp_buf = try ally.alloc(u8, CAP);
    defer ally.free(comp_buf);
    const dec_buf = try ally.alloc(u8, IMG_LEN);
    defer ally.free(dec_buf);
    @memset(img_buf, 0);
    @memset(comp_buf, 0);
    @memset(dec_buf, 0);

    const img: *[IMG_LEN]u8 = img_buf[0..IMG_LEN];
    const comp: *[CAP]u8 = comp_buf[0..CAP];
    const dec: *[IMG_LEN]u8 = dec_buf[0..IMG_LEN];

    var ir = [_]u8{0} ** 64;
    var ig = [_]u8{0} ** 64;
    var ib = [_]u8{0} ** 64;
    var ia = [_]u8{0} ** 64;

    mkImage(img);
    var cs: u32 = 0;
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) cs = runKernel(img, &ir, &ig, &ib, &ia, comp, dec);
    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = nowMs();
        cs = runKernel(img, &ir, &ig, &ib, &ia, comp, dec);
        samples[i] = nowMs() - t0;
    }
    try stdout.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{ medianUs(&samples), cs, NPIX * N_ITERS, 1, N_RUNS });
    try stdout.flush();
}
