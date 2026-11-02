// tokenizer.goose: Goose port of tokenizer.js (same source text, runs and
// checksum): a branch-heavy lexer that classifies each byte, accumulates
// integer tokens and FNV-mixes the token stream. The source is a u8 builder,
// Goose's string.

import bench from "../_lib";

let BASE = "let alpha_12 = beta + 12345; if (alpha_12 >= 99) { total = total + alpha_12; }\n";
let N_REPEAT = 512;
let N_RUNS = 21;
let N_WARMUP = 5;

fn make_source() -> u8[>..] {
    var s: u8[>..] = [];
    for i in N_REPEAT { s.append(BASE); }
    return s;
}

fn is_alpha(c: u8) -> bool { (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95 }

fn scan(src: u8[:], len: i64) -> u32 {
    var h: u32 = 0x811c9dc5;
    var number: u32 = 0;
    var in_number = false;
    var in_ident = false;
    var tokens: u32 = 0;
    for i in len {
        let c = src[i];
        if c >= 48 && c <= 57 {
            number = number * 10 + (c - 48);
            in_number = true;
        } else {
            if in_number { h = mix(h, number); tokens++; number = 0; in_number = false; }
            if is_alpha(c) {
                if !in_ident { h = mix(h, c); tokens++; }
                in_ident = true;
            } else {
                if c > 32 { h = mix(h, c); tokens++; }
                in_ident = false;
            }
        }
    }
    if in_number { h = mix(h, number); tokens++; }
    h = mix(h, tokens);
    return h;
}

fn main() {
    let src = make_source();
    let n = src.len;
    var cs: u32 = 0;
    for i in N_WARMUP { cs = scan(src, n - (i & 7)); }

    var samples = [0.0; N_RUNS];
    for &s, i in samples {
        let t0 = now_ms();
        cs = scan(src, n - (i & 7));
        s = now_ms() - t0;
    }
    print_result(median_us(samples), cs, n, 5, N_RUNS);
}
