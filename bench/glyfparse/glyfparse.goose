// glyfparse.goose: Goose port of glyfparse.js (same stream, glyphs, passes
// and checksum): TrueType glyf-style decoding, run-length flags then
// variable-width x and y coordinate deltas, folded into a running hash.

import bench from "../_lib";

let NG = 600;               // glyphs
let MAXPTS = 120;
let STREAM_CAP = 1 << 19;
let N_ITERS = 12;
let N_RUNS = 21;
let N_WARMUP = 5;

fn build_stream(stream: u8[:], glyph_off: i32[:], glyph_pts: i32[:]) -> i64 {
    var s: u32 = 0x8e1d3a5;
    fn rnd() -> u32 { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return s; }
    var w = 0;
    var flags: u8[MAXPTS] = [0; MAXPTS];
    for g in NG {
        glyph_off[g] = w as i32;
        let np: i64 = 20 + rnd() % (MAXPTS - 20 + 1);
        glyph_pts[g] = np as i32;
        for p in np {
            let dx_kind = rnd() % 3;                // 0 short, 1 long, 2 same
            let dy_kind = rnd() % 3;
            var f = rnd() & 1;                      // on-curve
            if dx_kind == 0 { f |= 0x02 | ((rnd() & 1) << 4); }
            else if dx_kind == 2 { f |= 0x10; }
            if dy_kind == 0 { f |= 0x04 | ((rnd() & 1) << 5); }
            else if dy_kind == 2 { f |= 0x20; }
            flags[p] = f as u8;
        }
        var p = 0;
        while p < np {
            var run = 1;
            while p + run < np && flags[p + run] == flags[p] && run < 255 { run++; }
            if run > 1 {
                stream[w] = flags[p] | 0x08; w++;
                stream[w] = (run - 1) as u8; w++;
            } else {
                stream[w] = flags[p]; w++;
            }
            p += run;
        }
        for p2 in np {
            let f = flags[p2];
            if f & 0x02 != 0 { stream[w] = (rnd() % 256) as u8; w++; }
            else if f & 0x10 == 0 {
                let d = rnd() & 0xffff;
                stream[w] = (d >> 8) as u8; w++;
                stream[w] = (d & 255) as u8; w++;
            }
        }
        for p2 in np {
            let f = flags[p2];
            if f & 0x04 != 0 { stream[w] = (rnd() % 256) as u8; w++; }
            else if f & 0x20 == 0 {
                let d = rnd() & 0xffff;
                stream[w] = (d >> 8) as u8; w++;
                stream[w] = (d & 255) as u8; w++;
            }
        }
    }
    return w;
}

// A big-endian 16-bit delta, sign-extended.
fn delta16(stream: u8[:], r: i64) -> i64 { (stream[r] as u16 << 8 | stream[r + 1]) as! i16 }

fn parse_all(stream: u8[:], glyph_off: i32[:], glyph_pts: i32[:], flag_buf: u8[:]) -> u32 {
    var h: u32 = 0x811c9dc5;
    for g in NG {
        var r: i64 = glyph_off[g];
        let np: i64 = glyph_pts[g];
        var p = 0;
        while p < np {
            let f = stream[r]; r++;
            flag_buf[p] = f; p++;
            if f & 0x08 != 0 {
                var rep = stream[r]; r++;
                while rep > 0 { flag_buf[p] = f; p++; rep--; }
            }
        }
        var x = 0;
        var on_count = 0;
        for i in np {
            let f = flag_buf[i];
            if f & 0x02 != 0 {
                let d = stream[r]; r++;
                x = if f & 0x10 != 0 { x + d } else { x - d };
            } else if f & 0x10 == 0 {
                x = x + delta16(stream, r);
                r += 2;
            }
            h = mix(h, x as! u32);
            on_count += f & 1;
        }
        var y = 0;
        for i in np {
            let f = flag_buf[i];
            if f & 0x04 != 0 {
                let d = stream[r]; r++;
                y = if f & 0x20 != 0 { y + d } else { y - d };
            } else if f & 0x20 == 0 {
                y = y + delta16(stream, r);
                r += 2;
            }
            h = mix(h, y as! u32);
        }
        h = mix(h, on_count as! u32);
    }
    return h;
}

fn run_kernel(stream: u8[:], glyph_off: i32[:], glyph_pts: i32[:], flag_buf: u8[:]) -> u32 {
    var h: u32 = 0;
    for it in N_ITERS { h = mix(h, parse_all(stream, glyph_off, glyph_pts, flag_buf)); }
    return h;
}

fn main() {
    var stream: u8[>..] = [];
    var glyph_off: i32[>..] = [];
    var glyph_pts: i32[>..] = [];
    stream.resize(STREAM_CAP, 0);
    glyph_off.resize(NG, 0);
    glyph_pts.resize(NG, 0);
    var flag_buf: u8[MAXPTS] = [0; MAXPTS];
    build_stream(stream, glyph_off, glyph_pts);
    var acc: u32 = 0;
    for i in N_WARMUP { acc = mix(acc, run_kernel(stream, glyph_off, glyph_pts, flag_buf)); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        acc = mix(acc, run_kernel(stream, glyph_off, glyph_pts, flag_buf));
        t = now_ms() - t0;
    }
    print_result(median_us(samples), acc, NG * N_ITERS, 1, N_RUNS);
}
