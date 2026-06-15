let width = 320;
let height = 200;

let mem;
let sx1 = 0, sy1 = 0, sx2 = 0, sy2 = 0, override = 0;

export let resize = (w, h) => {
    width = w; height = h;
    mem = new Int32Array(w * h);
    return mem;
}
export let dataOffset = () => mem;

export let setSources = (x1, y1, x2, y2) => {
    sx1 = x1; sy1 = y1; sx2 = x2; sy2 = y2;
    override = 1;
}

// Release the held sources so the animated orbit resumes.
export let resume = () => { override = 0; }

let distance = (x1, y1, x2, y2) => {
    let dx = x1 - x2;
    let dy = y1 - y2;
    return Math.sqrt(dx * dx + dy * dy);
}

export let update = (tick) => {
    let w = width, h = height;
    let hw = w * 0.5, hh = h * 0.5;

    let cx1, cy1, cx2, cy2;
    if (override) {
        cx1 = sx1; cy1 = sy1; cx2 = sx2; cy2 = sy2;
    } else {
        cx1 = (Math.sin(tick * 2.0) + Math.sin(tick)) * hw * 0.3 + hw;
        cy1 = (Math.cos(tick)) * hh * 0.3 + hh;
        cx2 = (Math.sin(tick * 4.0) + Math.sin(tick + 1.2)) * hw * 0.3 + hw;
        cy2 = (Math.sin(tick * 3.0) + Math.cos(tick + 0.1)) * hh * 0.3 + hh;
    }

    let res = 48.0 / Math.max(w, h);
    let y = 0;
    while (y < height) {
        let x = 0;
        while (x < width) {
            let offset = (width * y + x);
            // two equal sources sum to [-2,2]; |sum| * 0.5 is the normalized fringe amplitude in [0,1].
            // the −tick phase makes the rings travel outward, so the field animates even when the
            // sources are held still (dragged) — the pattern keeps living without resetting.
            let a = Math.abs(
                Math.sin(distance(x, y, cx1, cy1) * res - tick * 8.0) +
                Math.sin(distance(x, y, cx2, cy2) * res - tick * 8.0)
            ) * 0.5;
            // sRGB transfer = perceptual lightness: an even gradient, dark fringes lifted, and — since
            // a≤1 — no overflow. (The old map scaled amplitude to ~510, so the byte wrapped past 255
            // and a false black band cut through every bright fringe.)
            let s = a <= 0.0031308 ? a * 12.92 : 1.055 * a ** (1.0 / 2.4) - 0.055;
            let vi = (s * 255.0) | 0;
            if (vi > 255) vi = 255;
            mem[offset] = (0xff000000) | (vi << 16) | (vi << 8) | vi;
            x++;
        }
        y++;
    }
}
