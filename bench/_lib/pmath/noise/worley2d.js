import { createPermutation } from './permutation.js';
export function create(seed) {
    return createPermutation(seed);
}
export function sample({ perm }, x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    let f1 = Infinity;
    for(let gy = -1; gy <= 1; gy++){
        const cy = iy + gy;
        const py = perm[cy & 255];
        const qy = perm[cy + 37 & 255];
        for(let gx = -1; gx <= 1; gx++){
            const cx = ix + gx;
            const rx = perm[(cx & 255) + py] / 256;
            const ry = perm[(cx + 71 & 255) + qy] / 256;
            const dx = cx + rx - x;
            const dy = cy + ry - y;
            const d2 = dx * dx + dy * dy;
            if (d2 < f1) f1 = d2;
        }
    }
    return Math.sqrt(f1);
}
