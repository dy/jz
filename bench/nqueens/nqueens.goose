// nqueens.goose: Goose port of nqueens.js (same board sizes, queries and
// checksum): bitmask N-Queens counting by backtracking recursion. Recursion
// is opt-in in Goose: the cycle's entry is a `recursive fn`.

import bench from "../_lib";

let NMIN = 8;
let NSPAN = 4;              // board sizes drawn from [NMIN, NMIN+NSPAN) = [8, 12)
let NQ = 20;                // independent count queries per kernel run
let N_RUNS = 21;
let N_WARMUP = 5;

// Deterministic per-query board sizes: XorShift32, identical per target.
fn fill_sizes(out: i32[NQ]&) {
    var s: u32 = 0x1234abcd;
    for &n in out {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        n = NMIN + (s % NSPAN) as i32;
    }
}

// Count placements that complete the board. cols/d1/d2 are the occupied-column
// and the two diagonal masks; avail isolates the legal squares of the current
// row, and b = avail & -avail walks them lowest bit first.
recursive fn solve(all: i32, cols: i32, d1: i32, d2: i32) -> i64 {
    if cols == all { return 1; }
    var cnt = 0;
    var avail = all & ~(cols | d1 | d2);
    while avail != 0 {
        let b = avail & -avail;
        avail = avail - b;
        cnt = cnt + solve(all, cols | b, (d1 | b) << 1, (d2 | b) >> 1);
    }
    return cnt;
}

fn count_n(n: i32) -> i64 { solve((1 << n) - 1, 0, 0, 0) }

fn run_kernel(sizes: i32[NQ]&) -> u32 {
    var h: u32 = 0x811c9dc5;
    for n in sizes { h = mix(h, count_n(n) as! u32); }
    return h;
}

fn main() {
    var sizes: i32[NQ] = [0; NQ];
    fill_sizes(sizes);
    var total = 0;
    for n in sizes { total = total + count_n(n); }

    var cs: u32 = 0;
    for i in N_WARMUP { cs = run_kernel(sizes); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        cs = run_kernel(sizes);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), cs, total, NMIN + NSPAN - 1, N_RUNS);
}
