// qoi.goose: Goose port of qoi.js (same image, ops, passes and checksum): QOI
// lossless image encode then decode. The colour index is four u8[64] tables,
// as the JS, C and Rust versions keep it.

import bench from "../_lib";

let NPIX = 256 * 256;       // RGBA pixels
let IMG_LEN = NPIX * 4;
let CAP = NPIX * 5 + 64;    // worst-case QOI output (all RGBA literals) + headroom
let N_ITERS = 10;           // encode + decode passes per kernel run
let N_RUNS = 21;
let N_WARMUP = 5;

struct Index { r: u8[64], g: u8[64], b: u8[64], a: u8[64] }

// Deterministic image with structure so all six QOI ops fire: flat runs, small
// deltas (diff/luma), fresh colours (rgb/index), and alpha changes (rgba).
fn mk_image(img: u8[:]) {
    var x: u32 = 0x12345678;
    var r: u32 = 128;
    var g: u32 = 128;
    var b: u32 = 128;
    var a: u32 = 255;
    for p in NPIX {
        x = x * 1103515245 + 12345;
        let roll = (x >> 28) & 7;
        if roll < 3 {
            // keep previous pixel: run-length
        } else if roll < 6 {
            r = (r + ((x >> 4) & 3) - 1) & 255;     // small delta: diff / luma
            g = (g + ((x >> 6) & 3) - 1) & 255;
            b = (b + ((x >> 8) & 3) - 1) & 255;
        } else if roll == 6 {
            r = (x >> 10) & 255; g = (x >> 16) & 255; b = (x >> 20) & 255;   // fresh colour
        } else {
            a = (x >> 12) & 255;                     // alpha change: rgba
        }
        let o = p << 2;
        img[o] = r as! u8; img[o + 1] = g as! u8; img[o + 2] = b as! u8; img[o + 3] = a as! u8;
    }
}

// The difference of two channels as a signed 8-bit value (QOI's wraparound).
fn delta(x: u8, y: u8) -> i32 { (x - y) as! i8 }

fn encode(img: u8[:], npix: i64, ix: Index&, out: u8[:]) -> i64 {
    for i in 64 { ix.r[i] = 0; ix.g[i] = 0; ix.b[i] = 0; ix.a[i] = 0; }
    var pr: u8 = 0;
    var pg: u8 = 0;
    var pb: u8 = 0;
    var pa: u8 = 255;
    var run = 0;
    var op = 0;
    for p in npix {
        let o = p << 2;
        let r = img[o];
        let g = img[o + 1];
        let b = img[o + 2];
        let a = img[o + 3];
        if r == pr && g == pg && b == pb && a == pa {
            run++;
            if run == 62 || p == npix - 1 { out[op] = (0xc0 | (run - 1)) as! u8; op++; run = 0; }
        } else {
            if run > 0 { out[op] = (0xc0 | (run - 1)) as! u8; op++; run = 0; }
            let h = (r as i64 * 3 + g as i64 * 5 + b as i64 * 7 + a as i64 * 11) & 63;
            if ix.r[h] == r && ix.g[h] == g && ix.b[h] == b && ix.a[h] == a {
                out[op] = h as! u8;     // QOI_OP_INDEX (0x00 | h)
                op++;
            } else {
                ix.r[h] = r; ix.g[h] = g; ix.b[h] = b; ix.a[h] = a;
                if a == pa {
                    let vr = delta(r, pr);
                    let vg = delta(g, pg);
                    let vb = delta(b, pb);
                    let vgr = vr - vg;
                    let vgb = vb - vg;
                    if vr >= -2 && vr <= 1 && vg >= -2 && vg <= 1 && vb >= -2 && vb <= 1 {
                        out[op] = (0x40 | ((vr + 2) << 4) | ((vg + 2) << 2) | (vb + 2)) as! u8;
                        op++;
                    } else if vgr >= -8 && vgr <= 7 && vg >= -32 && vg <= 31 && vgb >= -8 && vgb <= 7 {
                        out[op] = (0x80 | (vg + 32)) as! u8;
                        out[op + 1] = (((vgr + 8) << 4) | (vgb + 8)) as! u8;
                        op += 2;
                    } else {
                        out[op] = 0xfe; out[op + 1] = r; out[op + 2] = g; out[op + 3] = b;
                        op += 4;
                    }
                } else {
                    out[op] = 0xff; out[op + 1] = r; out[op + 2] = g; out[op + 3] = b; out[op + 4] = a;
                    op += 5;
                }
            }
        }
        pr = r; pg = g; pb = b; pa = a;
    }
    return op;
}

fn decode(inp: u8[:], clen: i64, npix: i64, ix: Index&, out: u8[:]) -> i64 {
    for i in 64 { ix.r[i] = 0; ix.g[i] = 0; ix.b[i] = 0; ix.a[i] = 0; }
    var pr: u8 = 0;
    var pg: u8 = 0;
    var pb: u8 = 0;
    var pa: u8 = 255;
    var run = 0;
    var ip = 0;
    for p in npix {
        if run > 0 {
            run--;
        } else if ip < clen {
            let b0 = inp[ip];
            ip++;
            if b0 == 0xfe { pr = inp[ip]; pg = inp[ip + 1]; pb = inp[ip + 2]; ip += 3; }
            else if b0 == 0xff { pr = inp[ip]; pg = inp[ip + 1]; pb = inp[ip + 2]; pa = inp[ip + 3]; ip += 4; }
            else if b0 & 0xc0 == 0x00 { pr = ix.r[b0]; pg = ix.g[b0]; pb = ix.b[b0]; pa = ix.a[b0]; }
            else if b0 & 0xc0 == 0x40 {
                pr = pr + ((b0 >> 4) & 3) - 2;     // u8 arithmetic wraps: & 255
                pg = pg + ((b0 >> 2) & 3) - 2;
                pb = pb + (b0 & 3) - 2;
            } else if b0 & 0xc0 == 0x80 {
                let b1 = inp[ip];
                ip++;
                let vg = (b0 & 63) - 32;           // u8: the wrapped vg, as & 255 leaves it
                pr = pr + vg + ((b1 >> 4) & 15) - 8;
                pg = pg + vg;
                pb = pb + vg + (b1 & 15) - 8;
            } else {
                run = b0 & 63;
            }
            let h = (pr as i64 * 3 + pg as i64 * 5 + pb as i64 * 7 + pa as i64 * 11) & 63;
            ix.r[h] = pr; ix.g[h] = pg; ix.b[h] = pb; ix.a[h] = pa;
        }
        let o = p << 2;
        out[o] = pr; out[o + 1] = pg; out[o + 2] = pb; out[o + 3] = pa;
    }
    return ip;
}

fn run_kernel(img: u8[:], ix: Index&, comp: u8[:], dec: u8[:]) -> u32 {
    var h: u32 = 0;
    for it in N_ITERS {
        let clen = encode(img, NPIX, ix, comp);
        decode(comp, clen, NPIX, ix, dec);
        var ok: u32 = 1;
        for i in IMG_LEN { if dec[i] != img[i] { ok = 0; } }
        h = mix(h, clen as! u32);
        for i in clen { h = mix(h, comp[i]); }
        h = mix(h, ok);
        let j = (it % NPIX) << 2;
        img[j] += 1;                // perturb so the codec can't be hoisted out of the loop
    }
    return h;
}

fn main() {
    var img: u8[>..] = [];
    var comp: u8[>..] = [];
    var dec: u8[>..] = [];
    img.resize(IMG_LEN, 0);
    comp.resize(CAP, 0);
    dec.resize(IMG_LEN, 0);
    var ix = default<Index>();
    mk_image(img);
    var cs: u32 = 0;
    for i in N_WARMUP { cs = run_kernel(img, ix, comp, dec); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        cs = run_kernel(img, ix, comp, dec);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), cs, NPIX * N_ITERS, 1, N_RUNS);
}
