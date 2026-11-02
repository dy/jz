// immutable.goose: Goose port of immutable.js (same particles, steps and
// checksum): every step replaces each particle with a fresh {x, y, vx, vy}
// record. In Goose a record is a value, built in place in its array slot.

import bench from "../_lib";

let N = 4096;               // particles
let STEPS = 32;             // steps per pass (one fresh record per particle per step)
let LIM = 1023;             // box bound
let N_RUNS = 21;
let N_WARMUP = 5;

struct P { x: i32, y: i32, vx: i32, vy: i32 }

fn init_particles() -> P[>..] {
    var ps: P[>..] = [];
    var s: u32 = 0x1234abcd;
    for i in N {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        let vx = ((s >> 4) & 15) as i32 - 8;
        let vy = ((s >> 8) & 15) as i32 - 8;
        ps.push(P {
            x: ((s >> 12) & LIM) as i32,
            y: ((s >> 20) & LIM) as i32,
            vx: if vx == 0 { 1 } else { vx },
            vy: if vy == 0 { 1 } else { vy },
        });
    }
    return ps;
}

fn run_kernel(ps: P[:]) -> u32 {
    var h: u32 = 0x811c9dc5;
    for it in STEPS {
        var sum = it as i32;
        for i in N {
            let p = ps[i];
            let nx = p.x + p.vx;
            let ny = p.y + p.vy;
            let hit_x = nx < 0 || nx > LIM;
            let hit_y = ny < 0 || ny > LIM;
            let x = if hit_x { p.x } else { nx };
            let y = if hit_y { p.y } else { ny };
            let vx = if hit_x { -p.vx } else { p.vx };
            let vy = if hit_y { -p.vy } else { p.vy };
            ps[i] = P { x: x, y: y, vx: vx, vy: vy };
            sum = sum + x + y * 31;
        }
        h = mix(h, sum as! u32);
    }
    return h;
}

fn main() {
    var cs: u32 = 0;
    // A fresh particle set per run: the kernel mutates the array, so timing
    // runs must not compound each other's motion.
    for i in N_WARMUP {
        let ps = init_particles();
        cs = run_kernel(ps);
    }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let ps = init_particles();
        let t0 = now_ms();
        cs = run_kernel(ps);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), cs, N * STEPS, 1, N_RUNS);
}
