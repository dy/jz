// polytri.goose: Goose port of polytri.js (same polygons, passes and
// checksum): ear-clipping triangulation of a comb and a convex polygon and the
// quick convex decomposition of a gear, with pmndrs/math's
// polygon2-triangulate, polygon2-decompose (Quick) and polygon2 helpers
// ported as written. Index arrays are built per call; the output buffer is
// written past its length, as the JS array is. The decomposition's polygons
// are appended to one grow-only coordinate pool, its stack holding slices of
// it; lineIntersection returns its point as two results.

import bench from "../_lib";
import math;

let N_ITERS = 40;
let N_RUNS = 21;
let N_WARMUP = 5;
let CONVEX_N = 32;
let SPIKES = 12;
let MAX_VALUE = 1.7976931348623157e308;     // Number.MAX_VALUE

let COMB = [0, 0, 6, 0, 6, 3, 5, 3, 5, 1, 4, 1, 4, 3, 3, 3, 3, 1, 2, 1, 2, 3, 1, 3, 1, 1, 0, 1];

// pmndrs/math shapes/polygon2
fn signed_area(vertices: f64[:], n: i64) -> f64 {
    var area = 0.0;
    var j = n - 1;
    for i in n {
        let xi = vertices[i * 2];
        let yi = vertices[i * 2 + 1];
        let xj = vertices[j * 2];
        let yj = vertices[j * 2 + 1];
        area += xj * yi - xi * yj;
        j = i;
    }
    return area / 2;
}

fn is_reflex_vertex(vertices: f64[:], n: i64, i: i64) -> bool {
    let p = (i - 1 + n) % n * 2;
    let c = i * 2;
    let q = (i + 1) % n * 2;
    let ax = vertices[c] - vertices[p];
    let ay = vertices[c + 1] - vertices[p + 1];
    let bx = vertices[q] - vertices[c];
    let by = vertices[q + 1] - vertices[c + 1];
    return ax * by - ay * bx < 0;
}

fn reverse_in_place(v: f64[:], n: i64) {
    var lo = 0;
    var hi = n - 1;
    while lo < hi {
        let x = v[lo * 2];
        let y = v[lo * 2 + 1];
        v[lo * 2] = v[hi * 2];
        v[lo * 2 + 1] = v[hi * 2 + 1];
        v[hi * 2] = x;
        v[hi * 2 + 1] = y;
        lo++;
        hi--;
    }
}

// pmndrs/math geometry/polygon2-triangulate
let IDX_MASK: u32 = 0x0fffffff;
let EAR_FLAG: u32 = 0x80000000;

fn next_idx(i: i64, n: i64) -> i64 { if i + 1 < n { i + 1 } else { 0 } }
fn prev_idx(i: i64, n: i64) -> i64 { if i - 1 >= 0 { i - 1 } else { n - 1 } }

fn area2(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64) -> f64 { (bx - ax) * (cy - ay) - (cx - ax) * (by - ay) }
fn collinear(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64) -> bool { area2(ax, ay, bx, by, cx, cy) == 0 }

fn intersect_prop(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64, dx: f64, dy: f64) -> bool {
    if collinear(ax, ay, bx, by, cx, cy) || collinear(ax, ay, bx, by, dx, dy) ||
       collinear(cx, cy, dx, dy, ax, ay) || collinear(cx, cy, dx, dy, bx, by) { return false; }
    let l1 = area2(ax, ay, bx, by, cx, cy) < 0;
    let l2 = area2(ax, ay, bx, by, dx, dy) < 0;
    let l3 = area2(cx, cy, dx, dy, ax, ay) < 0;
    let l4 = area2(cx, cy, dx, dy, bx, by) < 0;
    return l1 != l2 && l3 != l4;
}

fn between(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64) -> bool {
    if !collinear(ax, ay, bx, by, cx, cy) { return false; }
    if ax != bx { return ax <= cx && cx <= bx || ax >= cx && cx >= bx; }
    return ay <= cy && cy <= by || ay >= cy && cy >= by;
}

fn intersect_seg(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64, dx: f64, dy: f64) -> bool {
    if intersect_prop(ax, ay, bx, by, cx, cy, dx, dy) { return true; }
    return between(ax, ay, bx, by, cx, cy) || between(ax, ay, bx, by, dx, dy) ||
           between(cx, cy, dx, dy, ax, ay) || between(cx, cy, dx, dy, bx, by);
}

fn vx(vertices: f64[:], indices: u32[:], s: i64) -> f64 { vertices[(indices[s] & IDX_MASK) * 2] }
fn vy(vertices: f64[:], indices: u32[:], s: i64) -> f64 { vertices[(indices[s] & IDX_MASK) * 2 + 1] }

fn diagonalie(i: i64, j: i64, n: i64, vertices: f64[:], indices: u32[:], loose: bool) -> bool {
    let d0x = vx(vertices, indices, i);
    let d0y = vy(vertices, indices, i);
    let d1x = vx(vertices, indices, j);
    let d1y = vy(vertices, indices, j);
    for k in n {
        let k1 = next_idx(k, n);
        if k == i || k1 == i || k == j || k1 == j { continue; }
        let e0x = vx(vertices, indices, k);
        let e0y = vy(vertices, indices, k);
        let e1x = vx(vertices, indices, k1);
        let e1y = vy(vertices, indices, k1);
        if d0x == e0x && d0y == e0y || d1x == e0x && d1y == e0y || d0x == e1x && d0y == e1y || d1x == e1x && d1y == e1y { continue; }
        let hit = if loose { intersect_prop(d0x, d0y, d1x, d1y, e0x, e0y, e1x, e1y) } else { intersect_seg(d0x, d0y, d1x, d1y, e0x, e0y, e1x, e1y) };
        if hit { return false; }
    }
    return true;
}

fn in_cone(i: i64, j: i64, n: i64, vertices: f64[:], indices: u32[:], loose: bool) -> bool {
    let ax = vx(vertices, indices, i);
    let ay = vy(vertices, indices, i);
    let bx = vx(vertices, indices, j);
    let by = vy(vertices, indices, j);
    let ni = next_idx(i, n);
    let pi = prev_idx(i, n);
    let nx = vx(vertices, indices, ni);
    let ny = vy(vertices, indices, ni);
    let px = vx(vertices, indices, pi);
    let py = vy(vertices, indices, pi);
    if area2(px, py, ax, ay, nx, ny) <= 0 {
        let c1 = area2(ax, ay, bx, by, px, py);
        let c2 = area2(bx, by, ax, ay, nx, ny);
        return if loose { c1 <= 0 && c2 <= 0 } else { c1 < 0 && c2 < 0 };
    }
    return !(area2(ax, ay, bx, by, nx, ny) <= 0 && area2(bx, by, ax, ay, px, py) <= 0);
}

fn diagonal(i: i64, j: i64, n: i64, vertices: f64[:], indices: u32[:], loose: bool) -> bool {
    in_cone(i, j, n, vertices, indices, loose) && diagonalie(i, j, n, vertices, indices, loose)
}

// out[i] = v on a JS array: past the end it grows.
fn set_at(out: i64[>..]&, i: i64, v: i64) { if i < out.len { out[i] = v; } else { out.push(v); } }

fn triangulate(out: i64[>..]&, vertices: f64[:], n: i64) -> i64 {
    if n < 3 { return 0; }
    let ccw = signed_area(vertices, n) >= 0;
    var indices: u32[>..] = [];
    for i in n { indices.push((if ccw { n - 1 - i } else { i }) as u32); }
    var ntris = 0;
    var dst = 0;
    for i in n {
        let i1 = next_idx(i, n);
        if diagonal(i, next_idx(i1, n), n, vertices, indices, false) { indices[i1] |= EAR_FLAG; }
    }
    var nv = n;
    while nv > 3 {
        var min_len = -1.0;
        var mini = -1;
        for i in nv {
            let i1 = next_idx(i, nv);
            if indices[i1] & EAR_FLAG != 0 {
                let p0 = indices[i] & IDX_MASK;
                let p2 = indices[next_idx(i1, nv)] & IDX_MASK;
                let dx = vertices[p2 * 2] - vertices[p0 * 2];
                let dy = vertices[p2 * 2 + 1] - vertices[p0 * 2 + 1];
                let len = dx * dx + dy * dy;
                if min_len < 0 || len < min_len { min_len = len; mini = i; }
            }
        }
        if mini == -1 {
            for i in nv {
                let i1 = next_idx(i, nv);
                let i2 = next_idx(i1, nv);
                if diagonal(i, i2, nv, vertices, indices, true) {
                    let p0 = indices[i] & IDX_MASK;
                    let p2 = indices[next_idx(i2, nv)] & IDX_MASK;
                    let dx = vertices[p2 * 2] - vertices[p0 * 2];
                    let dy = vertices[p2 * 2 + 1] - vertices[p0 * 2 + 1];
                    let len = dx * dx + dy * dy;
                    if min_len < 0 || len < min_len { min_len = len; mini = i; }
                }
            }
            if mini == -1 { return ntris; }
        }
        let i = mini;
        var i1 = next_idx(i, nv);
        let i2 = next_idx(i1, nv);
        set_at(out, dst, indices[i] & IDX_MASK); dst++;
        set_at(out, dst, indices[i1] & IDX_MASK); dst++;
        set_at(out, dst, indices[i2] & IDX_MASK); dst++;
        ntris++;
        nv--;
        for k in i1..nv { indices[k] = indices[k + 1]; }
        if i1 >= nv { i1 = 0; }
        let i_prev = prev_idx(i1, nv);
        if diagonal(prev_idx(i_prev, nv), i1, nv, vertices, indices, false) { indices[i_prev] |= EAR_FLAG; }
        else { indices[i_prev] &= IDX_MASK; }
        if diagonal(i_prev, next_idx(i1, nv), nv, vertices, indices, false) { indices[i1] |= EAR_FLAG; }
        else { indices[i1] &= IDX_MASK; }
    }
    set_at(out, dst, indices[0] & IDX_MASK); dst++;
    set_at(out, dst, indices[1] & IDX_MASK); dst++;
    set_at(out, dst, indices[2] & IDX_MASK); dst++;
    ntris++;
    return ntris;
}

// pmndrs/math geometry/polygon2-decompose (Quick)
fn tri_area(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64) -> f64 { (bx - ax) * (cy - ay) - (cx - ax) * (by - ay) }

fn sq_dist(ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let dx = bx - ax;
    let dy = by - ay;
    return dx * dx + dy * dy;
}

fn line_intersection(p1x: f64, p1y: f64, p2x: f64, p2y: f64, q1x: f64, q1y: f64, q2x: f64, q2y: f64) -> f64, f64 {
    let a1 = p2y - p1y;
    let b1 = p1x - p2x;
    let c1 = a1 * p1x + b1 * p1y;
    let a2 = q2y - q1y;
    let b2 = q1x - q2x;
    let c2 = a2 * q1x + b2 * q1y;
    let det = a1 * b2 - a2 * b1;
    if det != 0 { return (b2 * c1 - b1 * c2) / det, (a1 * c2 - a2 * c1) / det; }
    return 0.0, 0.0;
}

fn segments_intersect(p1x: f64, p1y: f64, p2x: f64, p2y: f64, q1x: f64, q1y: f64, q2x: f64, q2y: f64) -> bool {
    let rx = p2x - p1x;
    let ry = p2y - p1y;
    let ex = q2x - q1x;
    let ey = q2y - q1y;
    var denom = rx * ey - ry * ex;
    if denom == 0 { return false; }
    let wx = q1x - p1x;
    let wy = q1y - p1y;
    var num_u = wx * ey - wy * ex;
    var num_v = wx * ry - wy * rx;
    if denom < 0 { denom = -denom; num_u = -num_u; num_v = -num_v; }
    return num_u >= 0 && num_u <= denom && num_v >= 0 && num_v <= denom;
}

fn append_range(dst: f64[>..]&, src: f64[:], from: i64, to: i64) {
    for k in from..to { dst.push(src[k * 2]); dst.push(src[k * 2 + 1]); }
}

let QUICK_DECOMP_MAX_LEVEL = 100;

fn can_see_segment(poly: f64[:], a: i64, b: i64) -> bool {
    let s = poly.len >> 1;
    let ax = poly[a * 2];
    let ay = poly[a * 2 + 1];
    let bx = poly[b * 2];
    let by = poly[b * 2 + 1];
    for i in s {
        let i1 = if i + 1 == s { 0 } else { i + 1 };
        if i == a || i == b || i1 == a || i1 == b { continue; }
        if segments_intersect(ax, ay, bx, by, poly[i * 2], poly[i * 2 + 1], poly[i1 * 2], poly[i1 * 2 + 1]) { return false; }
    }
    return true;
}

// The number of convex parts (decomposePolygon2Quick(...).length).
fn decompose_quick(vertices: f64[:], n: i64) -> i64 {
    if n < 3 { return 0; }
    var pool: f64[>..] = [];
    var out: (f64[:])[>..] = [];
    var stack: (f64[:])[>..<] = [];
    var levels: i64[>..<] = [];
    pool.append(vertices[..n * 2]);                 // toCCW
    if signed_area(pool, n) < 0 { reverse_in_place(pool, n); }
    stack.push(pool[0..n * 2]);
    levels.push(0);
    while stack.len > 0 {
        let poly = stack.pop();
        let level = levels.pop();
        let s = poly.len >> 1;
        if s < 3 { continue; }
        if level > QUICK_DECOMP_MAX_LEVEL { out.push(poly); continue; }
        var handled = false;
        for i in s {
            if !is_reflex_vertex(poly, s, i) { continue; }
            let ip = if i == 0 { s - 1 } else { i - 1 };
            let i_n = if i + 1 == s { 0 } else { i + 1 };
            let i_prev_x = poly[ip * 2];
            let i_prev_y = poly[ip * 2 + 1];
            let i_cur_x = poly[i * 2];
            let i_cur_y = poly[i * 2 + 1];
            let i_next_x = poly[i_n * 2];
            let i_next_y = poly[i_n * 2 + 1];
            var lower_dist = MAX_VALUE;
            var upper_dist = MAX_VALUE;
            var lower_int_x = 0.0;
            var lower_int_y = 0.0;
            var upper_int_x = 0.0;
            var upper_int_y = 0.0;
            var lower_index = 0;
            var upper_index = 0;
            for j in s {
                let jx = poly[j * 2];
                let jy = poly[j * 2 + 1];
                if tri_area(i_prev_x, i_prev_y, i_cur_x, i_cur_y, jx, jy) > 0 {
                    let jm = if j == 0 { s - 1 } else { j - 1 };
                    let jmx = poly[jm * 2];
                    let jmy = poly[jm * 2 + 1];
                    if tri_area(i_prev_x, i_prev_y, i_cur_x, i_cur_y, jmx, jmy) <= 0 {
                        let px, py = line_intersection(i_prev_x, i_prev_y, i_cur_x, i_cur_y, jx, jy, jmx, jmy);
                        if tri_area(i_next_x, i_next_y, i_cur_x, i_cur_y, px, py) < 0 {
                            let d = sq_dist(i_cur_x, i_cur_y, px, py);
                            if d < lower_dist { lower_dist = d; lower_int_x = px; lower_int_y = py; lower_index = j; }
                        }
                    }
                }
                if tri_area(i_next_x, i_next_y, i_cur_x, i_cur_y, jx, jy) <= 0 {
                    let jp = if j + 1 == s { 0 } else { j + 1 };
                    let jpx = poly[jp * 2];
                    let jpy = poly[jp * 2 + 1];
                    if tri_area(i_next_x, i_next_y, i_cur_x, i_cur_y, jpx, jpy) > 0 {
                        let px, py = line_intersection(i_next_x, i_next_y, i_cur_x, i_cur_y, jx, jy, jpx, jpy);
                        if tri_area(i_prev_x, i_prev_y, i_cur_x, i_cur_y, px, py) > 0 {
                            let d = sq_dist(i_cur_x, i_cur_y, px, py);
                            if d < upper_dist { upper_dist = d; upper_int_x = px; upper_int_y = py; upper_index = j; }
                        }
                    }
                }
            }
            var lower_poly: f64[>..] = [];
            var upper_poly: f64[>..] = [];
            if lower_index == (upper_index + 1) % s {
                let px = (lower_int_x + upper_int_x) / 2;
                let py = (lower_int_y + upper_int_y) / 2;
                if i < upper_index {
                    append_range(lower_poly, poly, i, upper_index + 1);
                    lower_poly.push(px); lower_poly.push(py);
                    upper_poly.push(px); upper_poly.push(py);
                    if lower_index != 0 { append_range(upper_poly, poly, lower_index, s); }
                    append_range(upper_poly, poly, 0, i + 1);
                } else {
                    if i != 0 { append_range(lower_poly, poly, i, s); }
                    append_range(lower_poly, poly, 0, upper_index + 1);
                    lower_poly.push(px); lower_poly.push(py);
                    upper_poly.push(px); upper_poly.push(py);
                    append_range(upper_poly, poly, lower_index, i + 1);
                }
            } else {
                if lower_index > upper_index { upper_index += s; }
                if upper_index < lower_index { handled = true; break; }
                var closest_dist = MAX_VALUE;
                var closest_index = 0;
                for j in lower_index..upper_index + 1 {
                    let jj = if j >= s { j - s } else { j };
                    let jx = poly[jj * 2];
                    let jy = poly[jj * 2 + 1];
                    if tri_area(i_prev_x, i_prev_y, i_cur_x, i_cur_y, jx, jy) >= 0 && tri_area(i_next_x, i_next_y, i_cur_x, i_cur_y, jx, jy) <= 0 {
                        let d = sq_dist(i_cur_x, i_cur_y, jx, jy);
                        if d < closest_dist && can_see_segment(poly, i, jj) { closest_dist = d; closest_index = jj; }
                    }
                }
                if i < closest_index {
                    append_range(lower_poly, poly, i, closest_index + 1);
                    if closest_index != 0 { append_range(upper_poly, poly, closest_index, s); }
                    append_range(upper_poly, poly, 0, i + 1);
                } else {
                    if i != 0 { append_range(lower_poly, poly, i, s); }
                    append_range(lower_poly, poly, 0, closest_index + 1);
                    append_range(upper_poly, poly, closest_index, i + 1);
                }
            }
            let lo = pool.len;
            pool.append(lower_poly);
            let up = pool.len;
            pool.append(upper_poly);
            let lower_s = pool[lo..up];
            let upper_s = pool[up..pool.len];
            if lower_poly.len < upper_poly.len { stack.push(upper_s); stack.push(lower_s); }
            else { stack.push(lower_s); stack.push(upper_s); }
            levels.push(level + 1);
            levels.push(level + 1);
            handled = true;
            break;
        }
        if !handled { out.push(poly); }
    }
    return out.len;
}

fn run(acc: f64[2 + 3 * (CONVEX_N - 2)]&, iters: i64, out: i64[>..]&, comb: f64[:], convex: f64[:], gear: f64[:]) {
    var tris = 0;
    var parts = 0;
    for i in iters {
        tris += triangulate(out, comb, comb.len / 2);
        tris += triangulate(out, convex, CONVEX_N);
        parts += decompose_quick(gear, SPIKES * 2);
    }
    acc[0] = tris;
    acc[1] = parts;
    for k in 3 * (CONVEX_N - 2) { acc[2 + k] = out[k]; }
}

fn main() {
    var comb: f64[>..] = [];
    for v in COMB { comb.push(v); }
    var convex: f64[>..] = [];
    for i in CONVEX_N {
        let a = i / (CONVEX_N * 1.0) * PI * 2;
        convex.push(cos(a) * 5);
        convex.push(sin(a) * 5);
    }
    var gear: f64[>..] = [];
    for i in SPIKES * 2 {
        let a = i / (SPIKES * 2.0) * PI * 2;
        let r = if i % 2 == 0 { 5.0 } else { 2.5 };
        gear.push(cos(a) * r);
        gear.push(sin(a) * r);
    }
    var out: i64[>..] = [];
    var acc = [0.0; 2 + 3 * (CONVEX_N - 2)];
    for i in N_WARMUP { run(acc, N_ITERS, out, comb, convex, gear); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        run(acc, N_ITERS, out, comb, convex, gear);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(acc), N_ITERS * 3, 3, N_RUNS);
}
