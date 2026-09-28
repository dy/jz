import { signedArea } from '../shapes/polygon2.js';
const IDX_MASK = 0x0fffffff;
const EAR_FLAG = 0x80000000;
const nextIdx = (i, n)=>i + 1 < n ? i + 1 : 0;
const prevIdx = (i, n)=>i - 1 >= 0 ? i - 1 : n - 1;
function area2(ax, ay, bx, by, cx, cy) {
    return (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
}
function collinear(ax, ay, bx, by, cx, cy) {
    return area2(ax, ay, bx, by, cx, cy) === 0;
}
function intersectProp(ax, ay, bx, by, cx, cy, dx, dy) {
    if (collinear(ax, ay, bx, by, cx, cy) || collinear(ax, ay, bx, by, dx, dy) || collinear(cx, cy, dx, dy, ax, ay) || collinear(cx, cy, dx, dy, bx, by)) {
        return false;
    }
    const l1 = area2(ax, ay, bx, by, cx, cy) < 0;
    const l2 = area2(ax, ay, bx, by, dx, dy) < 0;
    const l3 = area2(cx, cy, dx, dy, ax, ay) < 0;
    const l4 = area2(cx, cy, dx, dy, bx, by) < 0;
    return l1 !== l2 && l3 !== l4;
}
function between(ax, ay, bx, by, cx, cy) {
    if (!collinear(ax, ay, bx, by, cx, cy)) return false;
    if (ax !== bx) return ax <= cx && cx <= bx || ax >= cx && cx >= bx;
    return ay <= cy && cy <= by || ay >= cy && cy >= by;
}
function intersectSeg(ax, ay, bx, by, cx, cy, dx, dy) {
    if (intersectProp(ax, ay, bx, by, cx, cy, dx, dy)) return true;
    return between(ax, ay, bx, by, cx, cy) || between(ax, ay, bx, by, dx, dy) || between(cx, cy, dx, dy, ax, ay) || between(cx, cy, dx, dy, bx, by);
}
const vX = (vertices, indices, s)=>vertices[(indices[s] & IDX_MASK) * 2];
const vY = (vertices, indices, s)=>vertices[(indices[s] & IDX_MASK) * 2 + 1];
function diagonalie(i, j, n, vertices, indices, loose) {
    const d0x = vX(vertices, indices, i);
    const d0y = vY(vertices, indices, i);
    const d1x = vX(vertices, indices, j);
    const d1y = vY(vertices, indices, j);
    for(let k = 0; k < n; k++){
        const k1 = nextIdx(k, n);
        if (k === i || k1 === i || k === j || k1 === j) continue;
        const e0x = vX(vertices, indices, k);
        const e0y = vY(vertices, indices, k);
        const e1x = vX(vertices, indices, k1);
        const e1y = vY(vertices, indices, k1);
        if (d0x === e0x && d0y === e0y || d1x === e0x && d1y === e0y || d0x === e1x && d0y === e1y || d1x === e1x && d1y === e1y) {
            continue;
        }
        const hit = loose ? intersectProp(d0x, d0y, d1x, d1y, e0x, e0y, e1x, e1y) : intersectSeg(d0x, d0y, d1x, d1y, e0x, e0y, e1x, e1y);
        if (hit) return false;
    }
    return true;
}
function inCone(i, j, n, vertices, indices, loose) {
    const ax = vX(vertices, indices, i);
    const ay = vY(vertices, indices, i);
    const bx = vX(vertices, indices, j);
    const by = vY(vertices, indices, j);
    const ni = nextIdx(i, n);
    const pi = prevIdx(i, n);
    const nx = vX(vertices, indices, ni);
    const ny = vY(vertices, indices, ni);
    const px = vX(vertices, indices, pi);
    const py = vY(vertices, indices, pi);
    if (area2(px, py, ax, ay, nx, ny) <= 0) {
        const c1 = area2(ax, ay, bx, by, px, py);
        const c2 = area2(bx, by, ax, ay, nx, ny);
        return loose ? c1 <= 0 && c2 <= 0 : c1 < 0 && c2 < 0;
    }
    return !(area2(ax, ay, bx, by, nx, ny) <= 0 && area2(bx, by, ax, ay, px, py) <= 0);
}
function diagonal(i, j, n, vertices, indices, loose) {
    return inCone(i, j, n, vertices, indices, loose) && diagonalie(i, j, n, vertices, indices, loose);
}
export function triangulatePolygon2(out, vertices, n) {
    if (n < 3) return 0;
    const ccw = signedArea(vertices, n) >= 0;
    const indices = new Array(n);
    for(let i = 0; i < n; i++)indices[i] = ccw ? n - 1 - i : i;
    let ntris = 0;
    let dst = 0;
    for(let i = 0; i < n; i++){
        const i1 = nextIdx(i, n);
        if (diagonal(i, nextIdx(i1, n), n, vertices, indices, false)) indices[i1] |= EAR_FLAG;
    }
    let nv = n;
    while(nv > 3){
        let minLen = -1;
        let mini = -1;
        for(let i = 0; i < nv; i++){
            const i1 = nextIdx(i, nv);
            if (indices[i1] & EAR_FLAG) {
                const p0 = indices[i] & IDX_MASK;
                const p2 = indices[nextIdx(i1, nv)] & IDX_MASK;
                const dx = vertices[p2 * 2] - vertices[p0 * 2];
                const dy = vertices[p2 * 2 + 1] - vertices[p0 * 2 + 1];
                const len = dx * dx + dy * dy;
                if (minLen < 0 || len < minLen) {
                    minLen = len;
                    mini = i;
                }
            }
        }
        if (mini === -1) {
            for(let i = 0; i < nv; i++){
                const i1 = nextIdx(i, nv);
                const i2 = nextIdx(i1, nv);
                if (diagonal(i, i2, nv, vertices, indices, true)) {
                    const p0 = indices[i] & IDX_MASK;
                    const p2 = indices[nextIdx(i2, nv)] & IDX_MASK;
                    const dx = vertices[p2 * 2] - vertices[p0 * 2];
                    const dy = vertices[p2 * 2 + 1] - vertices[p0 * 2 + 1];
                    const len = dx * dx + dy * dy;
                    if (minLen < 0 || len < minLen) {
                        minLen = len;
                        mini = i;
                    }
                }
            }
            if (mini === -1) return ntris;
        }
        const i = mini;
        let i1 = nextIdx(i, nv);
        const i2 = nextIdx(i1, nv);
        out[dst++] = indices[i] & IDX_MASK;
        out[dst++] = indices[i1] & IDX_MASK;
        out[dst++] = indices[i2] & IDX_MASK;
        ntris++;
        nv--;
        for(let k = i1; k < nv; k++)indices[k] = indices[k + 1];
        if (i1 >= nv) i1 = 0;
        const iPrev = prevIdx(i1, nv);
        if (diagonal(prevIdx(iPrev, nv), i1, nv, vertices, indices, false)) indices[iPrev] |= EAR_FLAG;
        else indices[iPrev] &= IDX_MASK;
        if (diagonal(iPrev, nextIdx(i1, nv), nv, vertices, indices, false)) indices[i1] |= EAR_FLAG;
        else indices[i1] &= IDX_MASK;
    }
    out[dst++] = indices[0] & IDX_MASK;
    out[dst++] = indices[1] & IDX_MASK;
    out[dst++] = indices[2] & IDX_MASK;
    ntris++;
    return ntris;
}
