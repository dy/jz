// blur.goose: Goose port of blur.js (same image, radius and checksum):
// separable box blur over an RGBA8 image, edge-clamped, horizontal then
// vertical.

import bench from "../_lib";

let W = 512;
let H = 512;
let R = 4;                  // blur radius: 9-tap window per axis
let WIN = 2 * R + 1;
let N = W * H * 4;
let N_RUNS = 21;
let N_WARMUP = 5;

// Deterministic RGBA noise: XorShift32 bytes, identical per target.
fn mk_image(n: i64) -> u8[>..] {
    var out: u8[>..] = [];
    var s: u32 = 0x1234abcd;
    for i in n {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        out.push((s & 255) as! u8);
    }
    return out;
}

// Horizontal box blur: each output pixel is the mean of [x - r, x + r], edge-clamped.
fn hblur(src: u8[:], dst: u8[:], w: i64, h: i64, r: i64) {
    let win = 2 * r + 1;
    for y in h {
        let row = y * w;
        for x in w {
            var sr = 0;
            var sg = 0;
            var sb = 0;
            var sa = 0;
            for k in -r..r + 1 {
                var xi = x + k;
                if xi < 0 { xi = 0; }
                else if xi >= w { xi = w - 1; }
                let p = (row + xi) << 2;
                sr += src[p]; sg += src[p + 1]; sb += src[p + 2]; sa += src[p + 3];
            }
            let o = (row + x) << 2;
            dst[o] = (sr / win) as! u8;
            dst[o + 1] = (sg / win) as! u8;
            dst[o + 2] = (sb / win) as! u8;
            dst[o + 3] = (sa / win) as! u8;
        }
    }
}

// Vertical box blur: each output pixel is the mean of [y - r, y + r], edge-clamped.
fn vblur(src: u8[:], dst: u8[:], w: i64, h: i64, r: i64) {
    let win = 2 * r + 1;
    for y in h {
        for x in w {
            var sr = 0;
            var sg = 0;
            var sb = 0;
            var sa = 0;
            for k in -r..r + 1 {
                var yi = y + k;
                if yi < 0 { yi = 0; }
                else if yi >= h { yi = h - 1; }
                let p = (yi * w + x) << 2;
                sr += src[p]; sg += src[p + 1]; sb += src[p + 2]; sa += src[p + 3];
            }
            let o = (y * w + x) << 2;
            dst[o] = (sr / win) as! u8;
            dst[o + 1] = (sg / win) as! u8;
            dst[o + 2] = (sb / win) as! u8;
            dst[o + 3] = (sa / win) as! u8;
        }
    }
}

fn main() {
    let img = mk_image(N);
    var tmp: u8[>..] = [];
    var out: u8[>..] = [];
    tmp.resize(N, 0);
    out.resize(N, 0);
    for i in N_WARMUP { hblur(img, tmp, W, H, R); vblur(tmp, out, W, H, R); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        hblur(img, tmp, W, H, R);
        vblur(tmp, out, W, H, R);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_u8(out), W * H, WIN, N_RUNS);
}
