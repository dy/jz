// polytri.rs – ear-clipping triangulation of a comb and a convex polygon and
// the quick convex decomposition of a gear, the runtime-built-array kernel.
//
// Ports pmndrs/math (MIT, Copyright (c) 2026 Isaac Mason, bench/_lib/pmath/LICENSE)
// as written: geometry/polygon2-triangulate.js (triangulatePolygon2 with
// nextIdx, prevIdx, area2, collinear, intersectProp, between, intersectSeg, vX,
// vY, diagonalie, inCone, diagonal), geometry/polygon2-decompose.js
// (decomposePolygon2Quick with triArea, lineIntersection, segmentsIntersect,
// appendRange, toCCW, canSeeSegment) and shapes/polygon2.js (signedArea,
// isReflexVertex, reverse), each JS module a Rust module.
//
// Layout: a polygon is a flat x, y Vec<f64>. Each JS array the code grows is a
// Vec grown by push: the polygons decomposePolygon2Quick builds, its stack,
// levels and result list, and triangulatePolygon2's out, which the JS writes
// past its length (`set`: an index at the length appends, as a JS array
// grows). The index array, `new Array(n)` per call, is a Vec<u32> per call, its
// EAR_FLAG bit the JS's int32 sign bit. Indices are usize: prevIdx's
// `i - 1 >= 0` is `i >= 1`, isReflexVertex's `(i - 1 + n) % n` is
// `(i + n - 1) % n`, and the -1 "no ear yet" is None. Safe Rust cannot pass one
// array as both reverse's out and input, so toCCW's reverse(out, out, n) is
// reverse in place; lineIntersection's module scratch _decompIsect is a local
// of the one function that uses it.
//
// Reports: median ms across N_RUNS, throughput in polygons/µs, FNV-1a checksum
// (checksumF64) of the counts and the last triangulation: its stride of 128
// values hashes the low word of the first, the triangle count.
use std::f64::consts::PI;
use std::time::Instant;

const N_ITERS: usize = 40;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;
const CONVEX_N: usize = 32;
const SPIKES: usize = 12;

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

// FNV-1a over the low 32 bits of every 128th f64 (matches benchlib checksumF64,
// which strides 256 over the Uint32Array view).
fn checksum_f64(out: &[f64]) -> u32 {
    let mut h = 0x811c_9dc5u32;
    let mut i = 0usize;
    while i < out.len() {
        h = mix(h, out[i].to_bits() as u32);
        i += 128;
    }
    h
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

// a[i] = v on a JS array, i at most its length: at the length it appends
fn set<T>(a: &mut Vec<T>, i: usize, v: T) {
    if i < a.len() {
        a[i] = v;
    } else {
        a.push(v);
    }
}

// pmndrs/math shapes/polygon2
pub mod polygon2 {
    pub fn signed_area(vertices: &[f64], n: usize) -> f64 {
        let mut area = 0.0;
        let mut j = n - 1;
        for i in 0..n {
            let xi = vertices[i * 2];
            let yi = vertices[i * 2 + 1];
            let xj = vertices[j * 2];
            let yj = vertices[j * 2 + 1];
            area += xj * yi - xi * yj;
            j = i;
        }
        area / 2.0
    }

    pub fn is_reflex_vertex(vertices: &[f64], n: usize, i: usize) -> bool {
        let p = (i + n - 1) % n * 2;
        let c = i * 2;
        let q = (i + 1) % n * 2;
        let ax = vertices[c] - vertices[p];
        let ay = vertices[c + 1] - vertices[p + 1];
        let bx = vertices[q] - vertices[c];
        let by = vertices[q + 1] - vertices[c + 1];
        ax * by - ay * bx < 0.0
    }

    // reverse(out, out, n): in place
    pub fn reverse(out: &mut [f64], n: usize) {
        let mut lo = 0;
        let mut hi = n - 1;
        while lo < hi {
            let x = out[lo * 2];
            let y = out[lo * 2 + 1];
            out[lo * 2] = out[hi * 2];
            out[lo * 2 + 1] = out[hi * 2 + 1];
            out[hi * 2] = x;
            out[hi * 2 + 1] = y;
            lo += 1;
            hi -= 1;
        }
    }
}

// pmndrs/math geometry/polygon2-triangulate
pub mod polygon2_triangulate {
    use super::polygon2::signed_area;
    use super::set;

    const IDX_MASK: u32 = 0x0fffffff;
    const EAR_FLAG: u32 = 0x80000000;

    fn next_idx(i: usize, n: usize) -> usize {
        if i + 1 < n { i + 1 } else { 0 }
    }

    fn prev_idx(i: usize, n: usize) -> usize {
        if i >= 1 { i - 1 } else { n - 1 }
    }

    fn area2(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64) -> f64 {
        (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
    }

    fn collinear(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64) -> bool {
        area2(ax, ay, bx, by, cx, cy) == 0.0
    }

    fn intersect_prop(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64, dx: f64, dy: f64) -> bool {
        if collinear(ax, ay, bx, by, cx, cy)
            || collinear(ax, ay, bx, by, dx, dy)
            || collinear(cx, cy, dx, dy, ax, ay)
            || collinear(cx, cy, dx, dy, bx, by)
        {
            return false;
        }
        let l1 = area2(ax, ay, bx, by, cx, cy) < 0.0;
        let l2 = area2(ax, ay, bx, by, dx, dy) < 0.0;
        let l3 = area2(cx, cy, dx, dy, ax, ay) < 0.0;
        let l4 = area2(cx, cy, dx, dy, bx, by) < 0.0;
        l1 != l2 && l3 != l4
    }

    fn between(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64) -> bool {
        if !collinear(ax, ay, bx, by, cx, cy) {
            return false;
        }
        if ax != bx {
            return ax <= cx && cx <= bx || ax >= cx && cx >= bx;
        }
        ay <= cy && cy <= by || ay >= cy && cy >= by
    }

    fn intersect_seg(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64, dx: f64, dy: f64) -> bool {
        if intersect_prop(ax, ay, bx, by, cx, cy, dx, dy) {
            return true;
        }
        between(ax, ay, bx, by, cx, cy)
            || between(ax, ay, bx, by, dx, dy)
            || between(cx, cy, dx, dy, ax, ay)
            || between(cx, cy, dx, dy, bx, by)
    }

    fn v_x(vertices: &[f64], indices: &[u32], s: usize) -> f64 {
        vertices[(indices[s] & IDX_MASK) as usize * 2]
    }

    fn v_y(vertices: &[f64], indices: &[u32], s: usize) -> f64 {
        vertices[(indices[s] & IDX_MASK) as usize * 2 + 1]
    }

    fn diagonalie(i: usize, j: usize, n: usize, vertices: &[f64], indices: &[u32], loose: bool) -> bool {
        let d0x = v_x(vertices, indices, i);
        let d0y = v_y(vertices, indices, i);
        let d1x = v_x(vertices, indices, j);
        let d1y = v_y(vertices, indices, j);
        for k in 0..n {
            let k1 = next_idx(k, n);
            if k == i || k1 == i || k == j || k1 == j {
                continue;
            }
            let e0x = v_x(vertices, indices, k);
            let e0y = v_y(vertices, indices, k);
            let e1x = v_x(vertices, indices, k1);
            let e1y = v_y(vertices, indices, k1);
            if d0x == e0x && d0y == e0y
                || d1x == e0x && d1y == e0y
                || d0x == e1x && d0y == e1y
                || d1x == e1x && d1y == e1y
            {
                continue;
            }
            let hit = if loose {
                intersect_prop(d0x, d0y, d1x, d1y, e0x, e0y, e1x, e1y)
            } else {
                intersect_seg(d0x, d0y, d1x, d1y, e0x, e0y, e1x, e1y)
            };
            if hit {
                return false;
            }
        }
        true
    }

    fn in_cone(i: usize, j: usize, n: usize, vertices: &[f64], indices: &[u32], loose: bool) -> bool {
        let ax = v_x(vertices, indices, i);
        let ay = v_y(vertices, indices, i);
        let bx = v_x(vertices, indices, j);
        let by = v_y(vertices, indices, j);
        let ni = next_idx(i, n);
        let pi = prev_idx(i, n);
        let nx = v_x(vertices, indices, ni);
        let ny = v_y(vertices, indices, ni);
        let px = v_x(vertices, indices, pi);
        let py = v_y(vertices, indices, pi);
        if area2(px, py, ax, ay, nx, ny) <= 0.0 {
            let c1 = area2(ax, ay, bx, by, px, py);
            let c2 = area2(bx, by, ax, ay, nx, ny);
            return if loose { c1 <= 0.0 && c2 <= 0.0 } else { c1 < 0.0 && c2 < 0.0 };
        }
        !(area2(ax, ay, bx, by, nx, ny) <= 0.0 && area2(bx, by, ax, ay, px, py) <= 0.0)
    }

    fn diagonal(i: usize, j: usize, n: usize, vertices: &[f64], indices: &[u32], loose: bool) -> bool {
        in_cone(i, j, n, vertices, indices, loose) && diagonalie(i, j, n, vertices, indices, loose)
    }

    pub fn triangulate_polygon2(out: &mut Vec<u32>, vertices: &[f64], n: usize) -> usize {
        if n < 3 {
            return 0;
        }
        let ccw = signed_area(vertices, n) >= 0.0;
        let mut indices = vec![0u32; n];
        for i in 0..n {
            indices[i] = (if ccw { n - 1 - i } else { i }) as u32;
        }
        let mut ntris = 0;
        let mut dst = 0;
        for i in 0..n {
            let i1 = next_idx(i, n);
            if diagonal(i, next_idx(i1, n), n, vertices, &indices, false) {
                indices[i1] |= EAR_FLAG;
            }
        }
        let mut nv = n;
        while nv > 3 {
            let mut min_len = -1.0;
            let mut mini = None;
            for i in 0..nv {
                let i1 = next_idx(i, nv);
                if indices[i1] & EAR_FLAG != 0 {
                    let p0 = (indices[i] & IDX_MASK) as usize;
                    let p2 = (indices[next_idx(i1, nv)] & IDX_MASK) as usize;
                    let dx = vertices[p2 * 2] - vertices[p0 * 2];
                    let dy = vertices[p2 * 2 + 1] - vertices[p0 * 2 + 1];
                    let len = dx * dx + dy * dy;
                    if min_len < 0.0 || len < min_len {
                        min_len = len;
                        mini = Some(i);
                    }
                }
            }
            if mini.is_none() {
                for i in 0..nv {
                    let i1 = next_idx(i, nv);
                    let i2 = next_idx(i1, nv);
                    if diagonal(i, i2, nv, vertices, &indices, true) {
                        let p0 = (indices[i] & IDX_MASK) as usize;
                        let p2 = (indices[next_idx(i2, nv)] & IDX_MASK) as usize;
                        let dx = vertices[p2 * 2] - vertices[p0 * 2];
                        let dy = vertices[p2 * 2 + 1] - vertices[p0 * 2 + 1];
                        let len = dx * dx + dy * dy;
                        if min_len < 0.0 || len < min_len {
                            min_len = len;
                            mini = Some(i);
                        }
                    }
                }
            }
            let Some(i) = mini else {
                return ntris;
            };
            let mut i1 = next_idx(i, nv);
            let i2 = next_idx(i1, nv);
            set(out, dst, indices[i] & IDX_MASK);
            dst += 1;
            set(out, dst, indices[i1] & IDX_MASK);
            dst += 1;
            set(out, dst, indices[i2] & IDX_MASK);
            dst += 1;
            ntris += 1;
            nv -= 1;
            for k in i1..nv {
                indices[k] = indices[k + 1];
            }
            if i1 >= nv {
                i1 = 0;
            }
            let i_prev = prev_idx(i1, nv);
            if diagonal(prev_idx(i_prev, nv), i1, nv, vertices, &indices, false) {
                indices[i_prev] |= EAR_FLAG;
            } else {
                indices[i_prev] &= IDX_MASK;
            }
            if diagonal(i_prev, next_idx(i1, nv), nv, vertices, &indices, false) {
                indices[i1] |= EAR_FLAG;
            } else {
                indices[i1] &= IDX_MASK;
            }
        }
        set(out, dst, indices[0] & IDX_MASK);
        dst += 1;
        set(out, dst, indices[1] & IDX_MASK);
        dst += 1;
        set(out, dst, indices[2] & IDX_MASK);
        ntris += 1;
        ntris
    }
}

// pmndrs/math geometry/polygon2-decompose
pub mod polygon2_decompose {
    use super::polygon2::{is_reflex_vertex, reverse, signed_area};
    use super::set;

    fn tri_area(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64) -> f64 {
        (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
    }

    fn sq_dist(ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
        let dx = bx - ax;
        let dy = by - ay;
        dx * dx + dy * dy
    }

    fn line_intersection(
        out: &mut [f64; 2],
        p1x: f64,
        p1y: f64,
        p2x: f64,
        p2y: f64,
        q1x: f64,
        q1y: f64,
        q2x: f64,
        q2y: f64,
    ) {
        let a1 = p2y - p1y;
        let b1 = p1x - p2x;
        let c1 = a1 * p1x + b1 * p1y;
        let a2 = q2y - q1y;
        let b2 = q1x - q2x;
        let c2 = a2 * q1x + b2 * q1y;
        let det = a1 * b2 - a2 * b1;
        if det != 0.0 {
            out[0] = (b2 * c1 - b1 * c2) / det;
            out[1] = (a1 * c2 - a2 * c1) / det;
        } else {
            out[0] = 0.0;
            out[1] = 0.0;
        }
    }

    fn segments_intersect(p1x: f64, p1y: f64, p2x: f64, p2y: f64, q1x: f64, q1y: f64, q2x: f64, q2y: f64) -> bool {
        let rx = p2x - p1x;
        let ry = p2y - p1y;
        let ex = q2x - q1x;
        let ey = q2y - q1y;
        let mut denom = rx * ey - ry * ex;
        if denom == 0.0 {
            return false;
        }
        let wx = q1x - p1x;
        let wy = q1y - p1y;
        let mut num_u = wx * ey - wy * ex;
        let mut num_v = wx * ry - wy * rx;
        if denom < 0.0 {
            denom = -denom;
            num_u = -num_u;
            num_v = -num_v;
        }
        num_u >= 0.0 && num_u <= denom && num_v >= 0.0 && num_v <= denom
    }

    fn append_range(dst: &mut Vec<f64>, src: &[f64], from: usize, to: usize) {
        for k in from..to {
            dst.push(src[k * 2]);
            dst.push(src[k * 2 + 1]);
        }
    }

    fn to_ccw(out: &mut Vec<f64>, vertices: &[f64], n: usize) {
        for k in 0..n * 2 {
            set(out, k, vertices[k]);
        }
        if signed_area(out, n) < 0.0 {
            reverse(out, n);
        }
    }

    const QUICK_DECOMP_MAX_LEVEL: usize = 100;

    fn can_see_segment(poly: &[f64], a: usize, b: usize) -> bool {
        let s = poly.len() >> 1;
        let ax = poly[a * 2];
        let ay = poly[a * 2 + 1];
        let bx = poly[b * 2];
        let by = poly[b * 2 + 1];
        for i in 0..s {
            let i1 = if i + 1 == s { 0 } else { i + 1 };
            if i == a || i == b || i1 == a || i1 == b {
                continue;
            }
            if segments_intersect(ax, ay, bx, by, poly[i * 2], poly[i * 2 + 1], poly[i1 * 2], poly[i1 * 2 + 1]) {
                return false;
            }
        }
        true
    }

    pub fn decompose_polygon2_quick(vertices: &[f64], n: usize) -> Vec<Vec<f64>> {
        if n < 3 {
            return Vec::new();
        }
        let mut decomp_isect = [0.0f64; 2];
        let mut out = Vec::new();
        let mut first = Vec::new();
        to_ccw(&mut first, vertices, n);
        let mut stack = vec![first];
        let mut levels = vec![0usize];
        while let Some(poly) = stack.pop() {
            let level = levels.pop().unwrap();
            let s = poly.len() >> 1;
            if s < 3 {
                continue;
            }
            if level > QUICK_DECOMP_MAX_LEVEL {
                out.push(poly);
                continue;
            }
            let mut handled = false;
            for i in 0..s {
                if !is_reflex_vertex(&poly, s, i) {
                    continue;
                }
                let ip = if i == 0 { s - 1 } else { i - 1 };
                let i_n = if i + 1 == s { 0 } else { i + 1 };
                let i_prev_x = poly[ip * 2];
                let i_prev_y = poly[ip * 2 + 1];
                let i_cur_x = poly[i * 2];
                let i_cur_y = poly[i * 2 + 1];
                let i_next_x = poly[i_n * 2];
                let i_next_y = poly[i_n * 2 + 1];
                let mut lower_dist = f64::MAX;
                let mut upper_dist = f64::MAX;
                let mut lower_int_x = 0.0;
                let mut lower_int_y = 0.0;
                let mut upper_int_x = 0.0;
                let mut upper_int_y = 0.0;
                let mut lower_index = 0;
                let mut upper_index = 0;
                for j in 0..s {
                    let jx = poly[j * 2];
                    let jy = poly[j * 2 + 1];
                    if tri_area(i_prev_x, i_prev_y, i_cur_x, i_cur_y, jx, jy) > 0.0 {
                        let jm = if j == 0 { s - 1 } else { j - 1 };
                        let jmx = poly[jm * 2];
                        let jmy = poly[jm * 2 + 1];
                        if tri_area(i_prev_x, i_prev_y, i_cur_x, i_cur_y, jmx, jmy) <= 0.0 {
                            line_intersection(&mut decomp_isect, i_prev_x, i_prev_y, i_cur_x, i_cur_y, jx, jy, jmx, jmy);
                            let px = decomp_isect[0];
                            let py = decomp_isect[1];
                            if tri_area(i_next_x, i_next_y, i_cur_x, i_cur_y, px, py) < 0.0 {
                                let d = sq_dist(i_cur_x, i_cur_y, px, py);
                                if d < lower_dist {
                                    lower_dist = d;
                                    lower_int_x = px;
                                    lower_int_y = py;
                                    lower_index = j;
                                }
                            }
                        }
                    }
                    if tri_area(i_next_x, i_next_y, i_cur_x, i_cur_y, jx, jy) <= 0.0 {
                        let jp = if j + 1 == s { 0 } else { j + 1 };
                        let jpx = poly[jp * 2];
                        let jpy = poly[jp * 2 + 1];
                        if tri_area(i_next_x, i_next_y, i_cur_x, i_cur_y, jpx, jpy) > 0.0 {
                            line_intersection(&mut decomp_isect, i_next_x, i_next_y, i_cur_x, i_cur_y, jx, jy, jpx, jpy);
                            let px = decomp_isect[0];
                            let py = decomp_isect[1];
                            if tri_area(i_prev_x, i_prev_y, i_cur_x, i_cur_y, px, py) > 0.0 {
                                let d = sq_dist(i_cur_x, i_cur_y, px, py);
                                if d < upper_dist {
                                    upper_dist = d;
                                    upper_int_x = px;
                                    upper_int_y = py;
                                    upper_index = j;
                                }
                            }
                        }
                    }
                }
                let mut lower_poly = Vec::new();
                let mut upper_poly = Vec::new();
                if lower_index == (upper_index + 1) % s {
                    let px = (lower_int_x + upper_int_x) / 2.0;
                    let py = (lower_int_y + upper_int_y) / 2.0;
                    if i < upper_index {
                        append_range(&mut lower_poly, &poly, i, upper_index + 1);
                        lower_poly.push(px);
                        lower_poly.push(py);
                        upper_poly.push(px);
                        upper_poly.push(py);
                        if lower_index != 0 {
                            append_range(&mut upper_poly, &poly, lower_index, s);
                        }
                        append_range(&mut upper_poly, &poly, 0, i + 1);
                    } else {
                        if i != 0 {
                            append_range(&mut lower_poly, &poly, i, s);
                        }
                        append_range(&mut lower_poly, &poly, 0, upper_index + 1);
                        lower_poly.push(px);
                        lower_poly.push(py);
                        upper_poly.push(px);
                        upper_poly.push(py);
                        append_range(&mut upper_poly, &poly, lower_index, i + 1);
                    }
                } else {
                    if lower_index > upper_index {
                        upper_index += s;
                    }
                    if upper_index < lower_index {
                        handled = true;
                        break;
                    }
                    let mut closest_dist = f64::MAX;
                    let mut closest_index = 0;
                    for j in lower_index..=upper_index {
                        let jj = if j >= s { j - s } else { j };
                        let jx = poly[jj * 2];
                        let jy = poly[jj * 2 + 1];
                        if tri_area(i_prev_x, i_prev_y, i_cur_x, i_cur_y, jx, jy) >= 0.0
                            && tri_area(i_next_x, i_next_y, i_cur_x, i_cur_y, jx, jy) <= 0.0
                        {
                            let d = sq_dist(i_cur_x, i_cur_y, jx, jy);
                            if d < closest_dist && can_see_segment(&poly, i, jj) {
                                closest_dist = d;
                                closest_index = jj;
                            }
                        }
                    }
                    if i < closest_index {
                        append_range(&mut lower_poly, &poly, i, closest_index + 1);
                        if closest_index != 0 {
                            append_range(&mut upper_poly, &poly, closest_index, s);
                        }
                        append_range(&mut upper_poly, &poly, 0, i + 1);
                    } else {
                        if i != 0 {
                            append_range(&mut lower_poly, &poly, i, s);
                        }
                        append_range(&mut lower_poly, &poly, 0, closest_index + 1);
                        append_range(&mut upper_poly, &poly, closest_index, i + 1);
                    }
                }
                if lower_poly.len() < upper_poly.len() {
                    stack.push(upper_poly);
                    stack.push(lower_poly);
                } else {
                    stack.push(lower_poly);
                    stack.push(upper_poly);
                }
                levels.push(level + 1);
                levels.push(level + 1);
                handled = true;
                break;
            }
            if !handled {
                out.push(poly);
            }
        }
        out
    }
}

const COMB: [f64; 28] = [
    0.0, 0.0, 6.0, 0.0, 6.0, 3.0, 5.0, 3.0, 5.0, 1.0, 4.0, 1.0, 4.0, 3.0, 3.0, 3.0, 3.0, 1.0, 2.0, 1.0, 2.0, 3.0,
    1.0, 3.0, 1.0, 1.0, 0.0, 1.0,
];

fn run(acc: &mut [f64], iters: usize, out: &mut Vec<u32>, convex: &[f64], gear: &[f64]) {
    let comb_n = COMB.len() / 2;
    let mut tris = 0;
    let mut parts = 0;
    for _ in 0..iters {
        tris += polygon2_triangulate::triangulate_polygon2(out, &COMB, comb_n);
        tris += polygon2_triangulate::triangulate_polygon2(out, convex, CONVEX_N);
        parts += polygon2_decompose::decompose_polygon2_quick(gear, SPIKES * 2).len();
    }
    acc[0] = tris as f64;
    acc[1] = parts as f64;
    for k in 0..3 * (CONVEX_N - 2) {
        acc[2 + k] = out[k] as f64;
    }
}

fn main() {
    let mut convex = Vec::new();
    for i in 0..CONVEX_N {
        let a = (i as f64 / CONVEX_N as f64) * PI * 2.0;
        convex.push(a.cos() * 5.0);
        convex.push(a.sin() * 5.0);
    }
    let mut gear = Vec::new();
    for i in 0..SPIKES * 2 {
        let a = (i as f64 / (SPIKES * 2) as f64) * PI * 2.0;
        let r = if i % 2 == 0 { 5.0 } else { 2.5 };
        gear.push(a.cos() * r);
        gear.push(a.sin() * r);
    }
    let mut out = Vec::new();

    let mut acc = [0.0f64; 2 + 3 * (CONVEX_N - 2)];
    for _ in 0..N_WARMUP {
        run(&mut acc, N_ITERS, &mut out, &convex, &gear);
    }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        run(&mut acc, N_ITERS, &mut out, &convex, &gear);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let us = median_us(&mut samples);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        us,
        checksum_f64(&acc),
        N_ITERS * 3,
        3,
        N_RUNS
    );
}
