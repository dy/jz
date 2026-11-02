// bytebeat.goose: Goose port of bytebeat.js (same formula, length and
// checksum): integer one-line-song synthesis to 8-bit PCM.

import bench from "../_lib";

let N = 1 << 21;            // 2,097,152 samples (~262 s @ 8 kHz): the whole song
let N_RUNS = 21;
let N_WARMUP = 5;

// One bytebeat sample: pure integer ops on the index, all below 2^31.
fn sample(t: i64) -> u8 {
    let v1 = (t * 5 & t >> 7) | (t * 3 & t >> 10);
    let v2 = t * (((t >> 12) | (t >> 8)) & (63 & (t >> 4)));
    return ((v1 + v2) & 255) as! u8;
}

fn render(buf: u8[:], n: i64) {
    for t in n { buf[t] = sample(t); }
}

fn main() {
    var buf: u8[>..] = [];
    buf.resize(N, 0);
    for i in N_WARMUP { render(buf, N); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        render(buf, N);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_u8(buf), N, 1, N_RUNS);
}
