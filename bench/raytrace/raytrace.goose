// raytrace.goose: Goose port of raytrace.js (same scene, light and checksum):
// one primary ray per pixel, closest sphere hit, Lambert plus ambient shading
// into an f64 RGB framebuffer. The scene is fixed f64[NS] arrays per
// component, as the JS, C and Rust versions keep it.

import bench from "../_lib";
import math;

let W = 384;
let H = 384;
let NS = 8;                 // sphere count
let N_RUNS = 21;
let N_WARMUP = 5;

struct Scene { sx: f64[NS], sy: f64[NS], sz: f64[NS], sr: f64[NS], cr: f64[NS], cg: f64[NS], cb: f64[NS] }

fn build_scene(sc: Scene&) {
    for i in NS {
        sc.sx[i] = ((i % 3) - 1) * 2.2;
        sc.sy[i] = ((i / 3) - 1) * 1.6;
        sc.sz[i] = -5.0 - i * 1.3;
        sc.sr[i] = 0.7 + (i % 4) * 0.18;
        sc.cr[i] = 0.30 + (i % 5) * 0.14;
        sc.cg[i] = 0.25 + (i % 3) * 0.24;
        sc.cb[i] = 0.40 + (i % 7) * 0.08;
    }
}

fn render(fb: f64[:], sc: Scene&, lx: f64, ly: f64, lz: f64) {
    for py in H {
        let sv = 1.0 - (py + 0.5) / H * 2.0;        // screen y in [-1, 1)
        for px in W {
            let su = (px + 0.5) / W * 2.0 - 1.0;    // screen x in [-1, 1)
            var dx = su;
            var dy = sv;
            var dz = -1.0;
            let dinv = 1.0 / sqrt(dx * dx + dy * dy + dz * dz);
            dx = dx * dinv; dy = dy * dinv; dz = dz * dinv;
            var t_best = 1e30;
            var hit = -1;
            for s in NS {
                let ox = -sc.sx[s];                 // origin(0) - center
                let oy = -sc.sy[s];
                let oz = -sc.sz[s];
                let b = ox * dx + oy * dy + oz * dz;
                let c = ox * ox + oy * oy + oz * oz - sc.sr[s] * sc.sr[s];
                let disc = b * b - c;
                if disc > 0.0 {
                    let t = -b - sqrt(disc);
                    if t > 0.001 && t < t_best { t_best = t; hit = s; }
                }
            }
            var r = 0.0;
            var g = 0.0;
            var bl = 0.0;
            if hit >= 0 {
                let hx = dx * t_best;
                let hy = dy * t_best;
                let hz = dz * t_best;
                var nx = hx - sc.sx[hit];
                var ny = hy - sc.sy[hit];
                var nz = hz - sc.sz[hit];
                let ninv = 1.0 / sqrt(nx * nx + ny * ny + nz * nz);
                nx = nx * ninv; ny = ny * ninv; nz = nz * ninv;
                var diff = nx * lx + ny * ly + nz * lz;
                if diff < 0.0 { diff = 0.0; }
                let shade = 0.15 + 0.85 * diff;     // ambient + diffuse
                r = sc.cr[hit] * shade; g = sc.cg[hit] * shade; bl = sc.cb[hit] * shade;
            }
            let o = (py * W + px) * 3;
            fb[o] = r; fb[o + 1] = g; fb[o + 2] = bl;
        }
    }
}

fn main() {
    var sc = default<Scene>();
    build_scene(sc);
    var fb: f64[>..] = [];
    fb.resize(W * H * 3, 0.0);
    let llen = 1.0 / sqrt(0.6 * 0.6 + 1.0 * 1.0 + 0.5 * 0.5);
    let lx = -0.6 * llen;
    let ly = 1.0 * llen;
    let lz = 0.5 * llen;
    for i in N_WARMUP { render(fb, sc, lx, ly, lz); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        render(fb, sc, lx, ly, lz);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(fb), W * H, NS, N_RUNS);
}
