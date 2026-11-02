// crc32.goose: Goose port of crc32.js (same buffer, table, passes and
// checksum): table-driven reflected CRC-32 over a byte buffer, the buffer
// perturbed after every pass. The 256-entry table is a fixed u32[256].

import bench from "../_lib";

let N = 16384;
let N_ITERS = 220;
let N_RUNS = 21;
let N_WARMUP = 5;

fn build_table(table: u32[256]&) {
    for n in 256 {
        var c = n as u32;
        for k in 8 { c = if c & 1 != 0 { 0xEDB88320 ^ (c >> 1) } else { c >> 1 }; }
        table[n] = c;
    }
}

fn init_buf(buf: u8[:]) {
    var x: u32 = 0x12345678;
    for &b in buf {
        x = x * 1103515245 + 12345;
        b = ((x >> 16) & 0xff) as! u8;
    }
}

fn crc32(buf: u8[:], table: u32[256]&) -> u32 {
    var c: u32 = 0xffffffff;
    for b in buf { c = table[(c ^ b) & 0xff] ^ (c >> 8); }
    return c ^ 0xffffffff;
}

fn run_kernel(buf: u8[:], table: u32[256]&) -> u32 {
    var h: u32 = 0;
    for it in N_ITERS {
        h = mix(h, crc32(buf, table));
        let j = it % N;
        buf[j] += 1;          // perturb the buffer so the CRC can't be hoisted out of the loop
    }
    return h;
}

fn main() {
    var buf: u8[>..] = [];
    buf.resize(N, 0);
    var table: u32[256] = [0; 256];
    build_table(table);
    init_buf(buf);
    var cs: u32 = 0;
    for i in N_WARMUP { cs = run_kernel(buf, table); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        cs = run_kernel(buf, table);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), cs, N * N_ITERS, 1, N_RUNS);
}
