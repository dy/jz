// wav.goose: Goose port of wav.js (same signal, header, passes and checksum):
// a PCM-16 WAV encoder, per-sample clamp and int16 quantization behind a
// RIFF/WAVE header.

import bench from "../_lib";

let N = 131072;             // mono samples
let SR = 44100;             // sample rate
let HDR = 44;               // RIFF/WAVE/fmt /data header bytes
let BYTES = HDR + N * 2;
let N_ITERS = 16;           // encode passes per kernel run
let N_RUNS = 21;
let N_WARMUP = 5;

// Deterministic pseudo-signal in ~[-1.2, 1.2): XorShift32 floats, slightly
// over unity so ~17% of samples exercise the clamp rails.
fn mk_samples(s: f64[:]) {
    var x: u32 = 0x1234abcd;
    for &v in s {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        v = (x / 4294967296.0 * 2 - 1) * 1.2;
    }
}

fn write_u32(b: u8[:], off: i64, v: i64) {
    b[off] = (v & 0xff) as! u8;
    b[off + 1] = ((v >> 8) & 0xff) as! u8;
    b[off + 2] = ((v >> 16) & 0xff) as! u8;
    b[off + 3] = ((v >> 24) & 0xff) as! u8;
}

fn write_u16(b: u8[:], off: i64, v: i64) {
    b[off] = (v & 0xff) as! u8;
    b[off + 1] = ((v >> 8) & 0xff) as! u8;
}

fn encode(samples: f64[:], n: i64, out: u8[:]) -> i64 {
    let data_bytes = n * 2;
    out[0] = 82; out[1] = 73; out[2] = 70; out[3] = 70;         // "RIFF"
    write_u32(out, 4, 36 + data_bytes);
    out[8] = 87; out[9] = 65; out[10] = 86; out[11] = 69;       // "WAVE"
    out[12] = 102; out[13] = 109; out[14] = 116; out[15] = 32;  // "fmt "
    write_u32(out, 16, 16);         // fmt chunk size
    write_u16(out, 20, 1);          // PCM
    write_u16(out, 22, 1);          // mono
    write_u32(out, 24, SR);
    write_u32(out, 28, SR * 2);     // byte rate (sr * blockAlign)
    write_u16(out, 32, 2);          // block align
    write_u16(out, 34, 16);         // bits per sample
    out[36] = 100; out[37] = 97; out[38] = 116; out[39] = 97;   // "data"
    write_u32(out, 40, data_bytes);
    var op = HDR;
    for i in n {
        var v = samples[i] * 32767.0;
        if v > 32767.0 { v = 32767.0; }
        else if v < -32768.0 { v = -32768.0; }
        let u = (v as i64) & 0xffff;    // truncate toward zero, keep low 16 bits
        out[op] = (u & 0xff) as! u8;
        out[op + 1] = ((u >> 8) & 0xff) as! u8;
        op += 2;
    }
    return op;
}

fn run_kernel(samples: f64[:], out: u8[:]) -> u32 {
    var h: u32 = 0;
    for it in N_ITERS {
        encode(samples, N, out);
        h = mix(h, checksum_u8(out));
        let j = it % N;
        samples[j] = -samples[j];       // perturb so the encode can't be hoisted out of the loop
    }
    return h;
}

fn main() {
    var samples: f64[>..] = [];
    var out: u8[>..] = [];
    samples.resize(N, 0.0);
    out.resize(BYTES, 0);
    mk_samples(samples);
    var cs: u32 = 0;
    for i in N_WARMUP { cs = run_kernel(samples, out); }

    var times = [0.0; N_RUNS];
    for &t in times {
        let t0 = now_ms();
        cs = run_kernel(samples, out);
        t = now_ms() - t0;
    }
    print_result(median_us(times), cs, N * N_ITERS, 1, N_RUNS);
}
