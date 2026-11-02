// mandelbrot.goose: Goose port of mandelbrot.js (same grid, iteration cap and
// checksum): escape-time iteration per pixel into a u32 iteration-count buffer.

import bench from "../_lib";

let W = 256;
let H = 256;
let MAX_ITER = 256;
let N_RUNS = 21;
let N_WARMUP = 5;

let X0 = -2.0;
let X1 = 0.5;
let Y0 = -1.25;
let Y1 = 1.25;

fn render(out: u32[:]) {
    let dx = (X1 - X0) / W;
    let dy = (Y1 - Y0) / H;
    for py in H {
        let cy = Y0 + py * dy;
        for px in W {
            let cx = X0 + px * dx;
            var zx = 0.0;
            var zy = 0.0;
            var i = 0;
            while i < MAX_ITER {
                let x2 = zx * zx;
                let y2 = zy * zy;
                if x2 + y2 > 4.0 { break; }
                zy = 2 * zx * zy + cy;
                zx = x2 - y2 + cx;
                i++;
            }
            out[py * W + px] = i as u32;
        }
    }
}

fn main() {
    var out: u32[>..] = [];
    out.resize(W * H, 0);
    for i in N_WARMUP { render(out); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        render(out);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_u32(out), W * H, MAX_ITER, N_RUNS);
}
