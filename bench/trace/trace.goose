// trace.goose: Goose port of trace.js (same bitmap, passes and checksum):
// square-tracing contour following over a bitmap of filled circles and
// lakes, every contour's chain code recorded.

import bench from "../_lib";

let W = 512;
let H = 512;
let N_ITERS = 4;
let N_RUNS = 21;
let N_WARMUP = 5;
let MAXCODES = 1 << 18;

fn build_bitmap(bmp: u8[:]) {
    var s: u32 = 0x51ce7a3;
    fn rnd() -> u32 { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return s; }
    for i in W * H { bmp[i] = 0; }
    for c in 42 {
        let cx: i64 = 44 + rnd() % (W - 88);
        let cy: i64 = 44 + rnd() % (H - 88);
        let r: i64 = 8 + rnd() % 33;
        let r2 = r * r;
        let fill: u8 = if c % 5 == 4 { 0 } else { 1 };     // every 5th circle punches a lake
        for y in cy - r..cy + r + 1 {
            let dy = y - cy;
            for x in cx - r..cx + r + 1 {
                let dx = x - cx;
                if dx * dx + dy * dy <= r2 { bmp[y * W + x] = fill; }
            }
        }
    }
}

fn trace_loop(bmp: u8[:], visited: u8[:], codes: u8[:], nc0: i64, sx: i64, sy: i64) -> i64 {
    var nc = nc0;
    var x = sx;
    var y = sy;
    var dir: u8 = 3;                        // entered heading north
    var steps = 0;
    while steps < MAXCODES {
        let inside = x >= 0 && x < W && y >= 0 && y < H && bmp[y * W + x] == 1;
        if inside {
            visited[y * W + x] = 1;
            dir = (dir + 3) & 3;            // turn left
        } else {
            dir = (dir + 1) & 3;            // turn right
        }
        if nc < MAXCODES { codes[nc] = dir; nc++; }
        if dir == 0 { x++; }
        else if dir == 1 { y++; }
        else if dir == 2 { x--; }
        else { y--; }
        steps++;
        if x == sx && y == sy && dir == 3 { break; }
    }
    return nc;
}

fn trace_all(bmp: u8[:], visited: u8[:], codes: u8[:]) -> u32 {
    var nc = 0;
    var h: u32 = 0;
    for i in W * H { visited[i] = 0; }
    for y in 1..H - 1 {
        for x in 1..W - 1 {
            if bmp[y * W + x] == 1 && bmp[y * W + x - 1] == 0 && visited[y * W + x] == 0 {
                let start = nc;
                nc = trace_loop(bmp, visited, codes, nc, x, y);
                h = mix(h, (nc - start) as! u32);
            }
        }
    }
    return mix(h, nc as! u32);
}

fn run_kernel(bmp: u8[:], visited: u8[:], codes: u8[:]) -> u32 {
    var h: u32 = 0;
    for it in N_ITERS { h = mix(h, trace_all(bmp, visited, codes)); }
    return h;
}

fn main() {
    var bmp: u8[>..] = [];
    var visited: u8[>..] = [];
    var codes: u8[>..] = [];
    bmp.resize(W * H, 0);
    visited.resize(W * H, 0);
    codes.resize(MAXCODES, 0);
    build_bitmap(bmp);
    var acc: u32 = 0;
    for i in N_WARMUP { acc = mix(acc, run_kernel(bmp, visited, codes)); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        acc = mix(acc, run_kernel(bmp, visited, codes));
        t = now_ms() - t0;
    }
    var h: u32 = 0x811c9dc5;
    h = mix(h, acc);
    var i = 0;
    while i < MAXCODES {
        h = mix(h, codes[i]);
        i += 64;
    }
    print_result(median_us(samples), h, W * H * N_ITERS, 1, N_RUNS);
}
