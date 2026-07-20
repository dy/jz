// glyfparse.rs — TrueType `glyf`-style outline decoding: flag runs with REPEAT counts,
// then variable-length coordinate deltas (short-unsigned-with-sign bit or long-16-bit or
// same-as-previous), accumulated to absolute positions — the byte-grammar every font
// stack (HarfBuzz, FreeType, fonttools) hot-loops over. The profile: unpredictable
// per-byte branches, variable-length records, bit tests, running accumulators — parser
// codegen without dragging in a whole compiler. Pure integer, bit-identical everywhere.
//
// The stream is synthesized once (deterministic xorshift) by the same rules, so parsing
// is validated by construction: the checksum covers decoded absolute coordinates and
// per-glyph point counts.
//
// Single source compiled by all targets and run directly by the JS engines.
// Subset: const/let + arrows, typed arrays, no class/async/regex.
//
// Reports: median ms across N_RUNS, FNV-1a checksum over decoded coordinates.
use std::time::Instant;

const NG: usize = 600;               // glyphs
const MAXPTS: usize = 120;
const STREAM_CAP: usize = 1 << 19;
const N_ITERS: usize = 12;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

fn median_us(samples: &mut [f64]) -> u64 {
    for i in 1..samples.len() {
        let v = samples[i];
        let mut j = i;
        while j > 0 && samples[j - 1] > v {
            samples[j] = samples[j - 1];
            j -= 1;
        }
        samples[j] = v;
    }
    (samples[(samples.len() - 1) >> 1] * 1000.0) as u64
}

// flag bits (TrueType): 0x01 on-curve · 0x02 x-short · 0x04 y-short · 0x08 repeat ·
// 0x10 x-same/positive · 0x20 y-same/positive
fn build_stream(stream: &mut [u8], glyph_off: &mut [i32], glyph_pts: &mut [i32]) {
    let mut s: u32 = 0x8e1d3a5;
    let next = |s: &mut u32| -> u32 {
        *s ^= *s << 13;
        *s ^= *s >> 17;
        *s ^= *s << 5;
        *s
    };
    let mut w: usize = 0;
    let mut flags = [0u8; MAXPTS];
    for g in 0..NG {
        glyph_off[g] = w as i32;
        let np = 20 + (next(&mut s) % (MAXPTS as u32 - 20 + 1)) as usize;
        glyph_pts[g] = np as i32;
        // decide per-point flags first
        for p in 0..np {
            let dx_kind = next(&mut s) % 3;
            let dy_kind = next(&mut s) % 3;
            let mut f: u8 = (next(&mut s) & 1) as u8;
            if dx_kind == 0 { f |= 0x02 | (((next(&mut s) & 1) as u8) << 4); }
            else if dx_kind == 2 { f |= 0x10; }
            if dy_kind == 0 { f |= 0x04 | (((next(&mut s) & 1) as u8) << 5); }
            else if dy_kind == 2 { f |= 0x20; }
            flags[p] = f;
        }
        // write flags with REPEAT compression
        let mut p = 0usize;
        while p < np {
            let mut run = 1usize;
            while p + run < np && flags[p + run] == flags[p] && run < 255 { run += 1; }
            if run > 1 {
                stream[w] = flags[p] | 0x08; w += 1;
                stream[w] = (run - 1) as u8; w += 1;
            } else {
                stream[w] = flags[p]; w += 1;
            }
            p += run;
        }
        // x deltas
        for p2 in 0..np {
            let f = flags[p2];
            if f & 0x02 != 0 {
                stream[w] = (next(&mut s) % 256) as u8; w += 1;
            } else if f & 0x10 == 0 {
                let d = next(&mut s) & 0xffff;
                stream[w] = (d >> 8) as u8; w += 1;
                stream[w] = (d & 255) as u8; w += 1;
            }
        }
        // y deltas
        for p2 in 0..np {
            let f = flags[p2];
            if f & 0x04 != 0 {
                stream[w] = (next(&mut s) % 256) as u8; w += 1;
            } else if f & 0x20 == 0 {
                let d = next(&mut s) & 0xffff;
                stream[w] = (d >> 8) as u8; w += 1;
                stream[w] = (d & 255) as u8; w += 1;
            }
        }
    }
}

// decode every glyph: flags (expanding repeats), then x accumulation, then y
fn parse_all(stream: &[u8], glyph_off: &[i32], glyph_pts: &[i32], flag_buf: &mut [u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for g in 0..NG {
        let mut r = glyph_off[g] as usize;
        let np = glyph_pts[g] as usize;
        let mut p = 0usize;
        while p < np {
            let f = stream[r]; r += 1;
            flag_buf[p] = f; p += 1;
            if f & 0x08 != 0 {
                let mut rep = stream[r]; r += 1;
                while rep > 0 { flag_buf[p] = f; p += 1; rep -= 1; }
            }
        }
        let mut x: i32 = 0;
        let mut on_count: i32 = 0;
        for i in 0..np {
            let f = flag_buf[i];
            if f & 0x02 != 0 {
                let d = stream[r] as i32; r += 1;
                x = if f & 0x10 != 0 { x + d } else { x - d };
            } else if f & 0x10 == 0 {
                let raw = (((stream[r] as u16) << 8) | stream[r + 1] as u16) as i16 as i32;
                x += raw;
                r += 2;
            }
            h = mix(h, x as u32);
            on_count += (f & 1) as i32;
        }
        let mut y: i32 = 0;
        for i in 0..np {
            let f = flag_buf[i];
            if f & 0x04 != 0 {
                let d = stream[r] as i32; r += 1;
                y = if f & 0x20 != 0 { y + d } else { y - d };
            } else if f & 0x20 == 0 {
                let raw = (((stream[r] as u16) << 8) | stream[r + 1] as u16) as i16 as i32;
                y += raw;
                r += 2;
            }
            h = mix(h, y as u32);
        }
        h = mix(h, on_count as u32);
    }
    h
}

fn run_kernel(stream: &[u8], glyph_off: &[i32], glyph_pts: &[i32], flag_buf: &mut [u8]) -> u32 {
    let mut h: u32 = 0;
    for _ in 0..N_ITERS {
        h = mix(h, parse_all(stream, glyph_off, glyph_pts, flag_buf));
    }
    h
}

fn main() {
    let mut stream = vec![0u8; STREAM_CAP];
    let mut glyph_off = vec![0i32; NG];
    let mut glyph_pts = vec![0i32; NG];
    let mut flag_buf = vec![0u8; MAXPTS];
    build_stream(&mut stream, &mut glyph_off, &mut glyph_pts);

    let mut acc: u32 = 0;
    for _ in 0..N_WARMUP {
        acc = mix(acc, run_kernel(&stream, &glyph_off, &glyph_pts, &mut flag_buf));
    }

    let mut samples = [0.0f64; N_RUNS];
    for s in &mut samples {
        let t0 = Instant::now();
        acc = mix(acc, run_kernel(&stream, &glyph_off, &glyph_pts, &mut flag_buf));
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        acc,
        NG * N_ITERS,
        1,
        N_RUNS
    );
}
