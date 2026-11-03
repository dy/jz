// entity.goose: Goose port of entity.js (same entities, steps and checksum):
// explicit Euler under gravity, updated in place over an array of inline
// {x, y, vx, vy} records.

import bench from "../_lib";

let N = 1 << 16;            // 65,536 entities
let STEPS = 256;            // frames integrated per run
let DT = 0.015625;          // 1/64 s: exact in f64, keeps the cascade bit-stable
let G = -9.8;               // gravity (units/s²)
let N_RUNS = 21;
let N_WARMUP = 5;

struct Entity { x: f64, y: f64, vx: f64, vy: f64 }

fn mk_entities(n: i64) -> Entity[>..] {
    var ps: Entity[>..] = [];
    for i in n { ps.push(Entity { x: 0.0, y: 0.0, vx: 0.0, vy: 0.0 }); }
    return ps;
}

fn seed_state(ps: Entity[:]) {
    var s: u32 = 0x1234abcd;
    fn r() -> f64 { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return s / 4294967296.0 * 2 - 1; }
    for &p in ps { p.x = r(); p.y = r(); p.vx = r(); p.vy = r(); }
}

fn step(ps: Entity[:]) {
    for &p in ps {
        let nvy = p.vy + G * DT;
        p.x = p.x + p.vx * DT;
        p.y = p.y + nvy * DT;
        p.vy = nvy;
    }
}

fn run(ps: Entity[:]) {
    for f in STEPS { step(ps); }
}

fn main() {
    var ps = mk_entities(N);
    for i in N_WARMUP { seed_state(ps); run(ps); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        seed_state(ps);
        let t0 = now_ms();
        run(ps);
        t = now_ms() - t0;
    }
    var px: f64[>..] = [];
    var py: f64[>..] = [];
    for p in ps { px.push(p.x); py.push(p.y); }
    print_result(median_us(samples), checksum_f64(py) ^ checksum_f64(px), N * STEPS, STEPS, N_RUNS);
}
