let BGR_ALIVE = 0;
let BGR_DEAD = 0;

let width = 0, height = 0, offset = 0;
let mem;

export let dataOffset = () => mem;

// rot_val is a vestigial arg (the old afterglow fade rate) the driver still passes — unused now
// that Life renders as a clean binary field.
export let init = (w, h, alive, dead, rot_val) => {
    BGR_ALIVE = alive;
    BGR_DEAD = dead;
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

            // Clean binary Life: a cell is alive (full-bright ink) or dead (background), no
            // afterglow trail. Survive = 2 or 3 live neighbours; birth = exactly 3.
            let self = mem[y * w + x];
            let live = (self & 1)
                ? ((aliveNeighbors & 0b1110) == 0b0010)   // alive: survive on 2 or 3
                : (aliveNeighbors == 3);                  // dead: born on exactly 3
            mem[offset + (y * width + x)] = live
                ? (BGR_ALIVE | 0xff000000) >>> 0
                : (BGR_DEAD | 0xff000000) >>> 0;
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

// ── self-driving loop: the module owns simulation time ─────────────────────
// In-module requestAnimationFrame schedules step() (double-buffer roll
// included); the page's rAF merely observes frameCount() and repaints when it
// advanced. stepTime() feeds the FPS meter — measured in-module, so it reads
// pure kernel throughput on either engine (jz-wasm or this same source as JS).
let raf = 0, frame = 0, stepMs = 0;

export let frameCount = () => frame;
export let stepTime = () => stepMs;

export let start = () => {
    cancelAnimationFrame(raf);   // idempotent — a second start() must not leak a second loop
    let tick = () => {
        mem.copyWithin(0, offset, offset * 2);   // roll NEXT → CURRENT
        let t0 = performance.now();
        step();
        stepMs = performance.now() - t0;
        frame = frame + 1;
        raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
};

export let stop = () => { cancelAnimationFrame(raf); };
