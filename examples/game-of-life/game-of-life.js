let BGR_ALIVE = 0;
let BGR_DEAD = 0;
let BIT_ROT = 0;

let width = 0, height = 0, offset = 0;
let mem;

export let dataOffset = () => mem;

export let init = (w, h, alive, dead, rot_val) => {
    BGR_ALIVE = alive;
    BGR_DEAD = dead;
    BIT_ROT = rot_val;
    width = w;
    height = h;
    offset = w * h;
    mem = new Uint32Array(w * h * 2);

    for (let y = 0; y < h; ++y) {
        for (let x = 0; x < w; ++x) {
            mem[offset + (y * width + x)] = Math.random() > 0.1
                ? BGR_DEAD & 0x00ffffff
                : (BGR_ALIVE | 0xff000000) >>> 0;
        }
    }
    return mem;
};

let rot = (x, y, v) => {
    let alpha = Math.max((v >>> 24) - BIT_ROT, 0);
    mem[offset + (y * width + x)] = ((alpha << 24) | (v & 0x00ffffff)) >>> 0;
};

export let step = () => {
    let w = width, h = height;
    let hm1 = h - 1, wm1 = w - 1;

    for (let y = 0; y < h; ++y) {
        let ym1 = y == 0 ? hm1 : y - 1,
            yp1 = y == hm1 ? 0 : y + 1;
        for (let x = 0; x < w; ++x) {
            let xm1 = x == 0 ? wm1 : x - 1,
                xp1 = x == wm1 ? 0 : x + 1;

            let aliveNeighbors =
                (mem[ym1 * w + xm1] & 1) + (mem[ym1 * w + x] & 1) + (mem[ym1 * w + xp1] & 1) +
                (mem[y   * w + xm1] & 1)                          + (mem[y   * w + xp1] & 1) +
                (mem[yp1 * w + xm1] & 1) + (mem[yp1 * w + x] & 1) + (mem[yp1 * w + xp1] & 1);

            // NB: the AS original rots SURVIVORS and snaps the dying to an opaque dead
            // color — its dead color is a visible magenta, so that reads as trails. On
            // this gallery's black theme that fades still-lifes to invisible; inverted
            // here: the living hold full brightness, the dying carry the fading afterglow.
            let self = mem[y * w + x];
            if (self & 1) {
                if ((aliveNeighbors & 0b1110) == 0b0010) {
                    mem[offset + (y * width + x)] = (self | 0xff000000) >>> 0;
                } else {
                    rot(x, y, self & ~1);   // dies: alive bit off, brightness starts its fade-out
                }
            } else {
                if (aliveNeighbors == 3) {
                    mem[offset + (y * width + x)] = (BGR_ALIVE | 0xff000000) >>> 0;
                } else {
                    rot(x, y, self);
                }
            }
        }
    }
};

export let fill = (x, y, p) => {
    for (let ix = 0; ix < width; ++ix) {
        if (Math.random() < p) mem[offset + (y * width + ix)] = (BGR_ALIVE | 0xff000000) >>> 0;
    }
    for (let iy = 0; iy < height; ++iy) {
        if (Math.random() < p) mem[offset + (iy * width + x)] = (BGR_ALIVE | 0xff000000) >>> 0;
    }
};
