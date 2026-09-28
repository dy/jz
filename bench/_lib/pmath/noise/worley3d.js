import { createPermutation } from './permutation.js';
export function create(seed) {
    return createPermutation(seed);
}
export function sample({ perm }, x, y, z) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    let f1 = Infinity;
    for(let gz = -1; gz <= 1; gz++){
        const cz = iz + gz;
        const pz = perm[cz & 255];
        const qz = perm[cz + 13 & 255];
        const sz = perm[cz + 97 & 255];
        for(let gy = -1; gy <= 1; gy++){
            const cy = iy + gy;
            const py = perm[(cy & 255) + pz];
            const qy = perm[(cy + 37 & 255) + qz];
            const sy = perm[(cy + 53 & 255) + sz];
            for(let gx = -1; gx <= 1; gx++){
                const cx = ix + gx;
                const rx = perm[(cx & 255) + py] / 256;
                const ry = perm[(cx + 71 & 255) + qy] / 256;
                const rz = perm[(cx + 23 & 255) + sy] / 256;
                const dx = cx + rx - x;
                const dy = cy + ry - y;
                const dz = cz + rz - z;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 < f1) f1 = d2;
            }
        }
    }
    return Math.sqrt(f1);
}
