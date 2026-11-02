// conv2d.goose: Goose port of conv2d.js (same tensors, passes and checksum):
// an int8 quantized 3x3 convolution layer, i32 multiply-accumulate, then
// requantize, ReLU and clamp.

import bench from "../_lib";

let CIN = 4;
let COUT = 16;
let H = 34;
let W = 34;
let K = 3;
let OH = H - K + 1;         // 32
let OW = W - K + 1;         // 32
let IN_LEN = CIN * H * W;
let WT_LEN = COUT * CIN * K * K;
let OUT_LEN = COUT * OH * OW;
let SHIFT = 11;             // requant: acc >> SHIFT lands typical activations in 0..127
let N_ITERS = 24;           // conv passes per kernel run
let N_RUNS = 21;
let N_WARMUP = 5;

// Deterministic int8 fill via LCG: the high byte spans the full signed range.
fn fill_i8(arr: i8[:], seed: u32) {
    var x = seed;
    for &v in arr {
        x = x * 1103515245 + 12345;
        v = (x >> 24) as! i8;
    }
}

fn fill_bias(arr: i32[:], seed: u32) {
    var x = seed;
    for &v in arr {
        x = x * 1103515245 + 12345;
        v = ((x >> 20) & 1023) as i32;      // small positive int32 bias
    }
}

fn conv(inp: i8[:], wt: i8[:], bias: i32[:], out: u8[:]) {
    for oc in COUT {
        let b = bias[oc];
        let oc_base = oc * OH * OW;
        for oy in OH {
            for ox in OW {
                var acc = b;
                for ic in CIN {
                    let in_ch = ic * H * W;
                    let w_ch = (oc * CIN + ic) * K * K;
                    for ky in K {
                        let irow = in_ch + (oy + ky) * W + ox;
                        let wrow = w_ch + ky * K;
                        for kx in K { acc += inp[irow + kx] as i32 * wt[wrow + kx]; }
                    }
                }
                var q = acc >> SHIFT;       // requantize (arithmetic shift, sign-preserving)
                if q < 0 { q = 0; }         // ReLU
                if q > 127 { q = 127; }     // clamp to int8 range
                out[oc_base + oy * OW + ox] = q as! u8;
            }
        }
    }
}

fn run_kernel(inp: i8[:], wt: i8[:], bias: i32[:], out: u8[:]) -> u32 {
    var h: u32 = 0;
    for it in N_ITERS {
        conv(inp, wt, bias, out);
        h = mix(h, checksum_u8(out));
        let j = it % IN_LEN;
        inp[j] = (inp[j] as i32 + 1) as! i8;    // perturb so the conv can't be hoisted out of the loop
    }
    return h;
}

fn main() {
    var inp: i8[>..] = [];
    var wt: i8[>..] = [];
    var bias: i32[>..] = [];
    var out: u8[>..] = [];
    inp.resize(IN_LEN, 0);
    wt.resize(WT_LEN, 0);
    bias.resize(COUT, 0);
    out.resize(OUT_LEN, 0);
    fill_i8(inp, 0x12345678);
    fill_i8(wt, 0x2bb3c1f7);
    fill_bias(bias, 0x51e3a9d1);
    var cs: u32 = 0;
    for i in N_WARMUP { cs = run_kernel(inp, wt, bias, out); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        cs = run_kernel(inp, wt, bias, out);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), cs, COUT * OH * OW * CIN * K * K * N_ITERS, 1, N_RUNS);
}
