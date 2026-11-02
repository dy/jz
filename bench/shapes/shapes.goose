// shapes.goose: Goose port of shapes.js (same record stream, passes and
// checksum): a per-variant measure summed over records of 8 shapes. Goose's
// answer to heterogeneous records is an enum; the stream is only walked, so
// it is stored in variable mode (each record as large as its own variant),
// and measure is a set of case functions, one per variant, dispatched on the
// tag.

import bench from "../_lib";

let N = 1 << 14;            // records
let NSHAPES = 8;            // distinct record shapes
let N_ITERS = 48;           // record-stream passes per kernel run
let N_RUNS = 21;
let N_WARMUP = 5;

enum Shape {
    Point { x: i32, y: i32 },
    Circle { r: i32 },
    Rect { w: i32, h: i32 },
    Line { x0: i32, y0: i32, x1: i32, y1: i32 },
    Tri { a: i32, b: i32, c: i32 },
    Prism { w: i32, h: i32, d: i32 },
    Arc { r: i32, s: i32 },
    Poly { n: i32, s: i32 },
}

fn init_rows() -> Shape..[>..] {
    var rows: Shape..[>..] = [];
    var s: u32 = 0x1234abcd;
    for i in N {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        let k = s & (NSHAPES - 1);
        let a = ((s >> 3) & 1023) as i32;
        let b = ((s >> 13) & 1023) as i32;
        let c = ((s >> 23) & 511) as i32;
        if k == 0 { rows.push(Shape.Point { x: a, y: b }); }
        else if k == 1 { rows.push(Shape.Circle { r: a }); }
        else if k == 2 { rows.push(Shape.Rect { w: a, h: b }); }
        else if k == 3 { rows.push(Shape.Line { x0: a, y0: b, x1: c, y1: (a ^ b) & 511 }); }
        else if k == 4 { rows.push(Shape.Tri { a: a, b: b, c: c }); }
        else if k == 5 { rows.push(Shape.Prism { w: a, h: b, d: c }); }
        else if k == 6 { rows.push(Shape.Arc { r: a, s: b }); }
        else { rows.push(Shape.Poly { n: c, s: b }); }
    }
    return rows;
}

fn measure(o: Shape.Point) -> i32 { o.x + o.y }
fn measure(o: Shape.Circle) -> i32 { o.r * (o.r * 3) }
fn measure(o: Shape.Rect) -> i32 { o.w * o.h }
fn measure(o: Shape.Line) -> i32 {
    let dx = o.x1 - o.x0;
    let dy = o.y1 - o.y0;
    return (if dx < 0 { -dx } else { dx }) + (if dy < 0 { -dy } else { dy });
}
fn measure(o: Shape.Tri) -> i32 { o.a + o.b + o.c }
fn measure(o: Shape.Prism) -> i32 { o.w * o.h - o.d }
fn measure(o: Shape.Arc) -> i32 { o.r * o.s + o.r }
fn measure(o: Shape.Poly) -> i32 { o.n * (o.s * o.s) }

fn run_kernel(rows: Shape..[>..]&) -> u32 {
    var h: u32 = 0x811c9dc5;
    for it in N_ITERS {
        var sum = it as u32;
        for o in rows { sum = sum + measure(o) as! u32; }
        h = mix(h, sum);
    }
    return h;
}

fn main() {
    var rows = init_rows();
    var cs: u32 = 0;
    for i in N_WARMUP { cs = run_kernel(rows); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        cs = run_kernel(rows);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), cs, N * N_ITERS, NSHAPES, N_RUNS);
}
