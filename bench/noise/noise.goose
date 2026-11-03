// noise.goose: Goose port of noise.js (same permutation, field and checksum):
// 2-D Perlin gradient noise summed over 5 fBm octaves. The permutation is a
// fixed i32[512] table; lerp is std's, the same a + (b - a)·t.

import bench from "../_lib";
import math;

let W = 256;
let H = 256;
let OCT = 5;                // fBm octaves
let N_RUNS = 21;
let N_WARMUP = 5;

fn build_perm(perm: i32[512]&) {
    for i in 256 { perm[i] = i as i32; }
    var s: u32 = 0x1234abcd;
    var i = 255;
    while i > 0 {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        let j = s % (i + 1) as u32;
        let t = perm[i]; perm[i] = perm[j]; perm[j] = t;
        i--;
    }
    for i in 256 { perm[256 + i] = perm[i]; }
}

fn fade(t: f64) -> f64 { t * t * t * (t * (t * 6.0 - 15.0) + 10.0) }

fn grad(hash: i32, x: f64, y: f64) -> f64 {
    let h = hash & 3;
    let u = if h & 1 == 0 { x } else { -x };
    let v = if h & 2 == 0 { y } else { -y };
    return u + v;
}

fn perlin(perm: i32[512]&, x: f64, y: f64) -> f64 {
    let xi = floor(x);
    let yi = floor(y);
    let xf = x - xi;
    let yf = y - yi;
    let bx = (xi as i64) & 255;
    let by = (yi as i64) & 255;
    let u = fade(xf);
    let v = fade(yf);
    let aa = perm[perm[bx] + by];
    let ab = perm[perm[bx] + by + 1];
    let ba = perm[perm[bx + 1] + by];
    let bb = perm[perm[bx + 1] + by + 1];
    let x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1.0, yf), u);
    let x2 = lerp(grad(ab, xf, yf - 1.0), grad(bb, xf - 1.0, yf - 1.0), u);
    return lerp(x1, x2, v);
}

fn fbm(perm: i32[512]&, x: f64, y: f64) -> f64 {
    var sum = 0.0;
    var amp = 0.5;
    var freq = 1.0;
    for o in OCT {
        sum = sum + amp * perlin(perm, x * freq, y * freq);
        freq = freq * 2.0;
        amp = amp * 0.5;
    }
    return sum;
}

fn render(perm: i32[512]&, field: f64[:]) {
    for py in H {
        let y = py * 0.03125;           // /32: smooth coordinate
        for px in W {
            let x = px * 0.03125;
            field[py * W + px] = fbm(perm, x, y);
        }
    }
}

fn main() {
    var perm: i32[512] = [0; 512];
    build_perm(perm);
    var field: f64[>..] = [];
    field.resize(W * H, 0.0);
    for i in N_WARMUP { render(perm, field); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        render(perm, field);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(field), W * H, OCT, N_RUNS);
}
