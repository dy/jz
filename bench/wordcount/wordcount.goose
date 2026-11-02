// wordcount.goose: Goose port of wordcount.js (same vocabulary, token stream,
// probes and checksum): token-frequency counting into a hash map with string
// keys, a fresh map per pass. Words are inline u8[..8] strings; the map is the
// standard library's dictionary keyed by views of them.

import bench from "../_lib";
import dictionary;

let NWORDS = 512;           // distinct words in the vocabulary
let N = 1 << 14;            // tokens per pass
let NPROBES = 64;           // fixed lookups folded into the checksum
let N_ITERS = 16;           // passes per kernel run
let N_RUNS = 21;
let N_WARMUP = 5;

fn build_words() -> u8[..8][>..] {
    var words: u8[..8][>..] = [];
    var s: u32 = 0x1234abcd;
    for i in NWORDS {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        let len = 3 + (s >> 8) % 6;
        var w: u8[..8] = [];
        var x = s;
        for j: u32 in 0..len {
            x = x * 0x9e3779b1 + j;
            w.push((97 + (x >> 16) % 26) as! u8);
        }
        words.push(w);
    }
    return words;
}

fn fill_tokens(toks: i32[:]) {
    var s: u32 = 0x2545f491;
    for &t in toks {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        t = (if s & 8 == 0 { (s >> 4) & 15 } else { (s >> 4) & (NWORDS - 1) }) as i32;
    }
}

fn run_kernel(words: u8[..8][:], toks: i32[:], probes: u8[..8][:]) -> u32 {
    var h: u32 = 0x811c9dc5;
    for pass in N_ITERS {
        var counts = dictionary<const u8[:], i32> {};
        for t in toks { counts.update(words[t], 0) { it += 1; }; }
        for p in probes {
            let n = counts.get(p);
            h = mix(h, if n { n as! u32 } else { 0 });
        }
    }
    return h;
}

fn main() {
    let words = build_words();
    var toks: i32[>..] = [];
    toks.resize(N, 0);
    fill_tokens(toks);
    // Probe every 8th word plus 8 absent keys: a missing count reads 0.
    var probes: u8[..8][>..] = [];
    for j in NPROBES - 8 { probes.push(words[(j * 8) & (NWORDS - 1)]); }
    for j in 8 {
        var p: u8[..8] = [];
        format(p, "zz", j);
        probes.push(p);
    }
    var cs: u32 = 0;
    for i in N_WARMUP { cs = run_kernel(words, toks, probes); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        cs = run_kernel(words, toks, probes);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), cs, N * N_ITERS, NWORDS, N_RUNS);
}
