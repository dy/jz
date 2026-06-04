let width = 320;
let height = 200;

let mem;
export let resize = (w, h) => {
    width = w; height = h;
    mem = new Int32Array(w * h);
    return mem;
}
export let dataOffset = () => mem;

let distance = (x1, y1, x2, y2) => {
    let dx = x1 - x2;
    let dy = y1 - y2;
    return Math.sqrt(dx * dx + dy * dy);
}

export let update = (tick) => {
    let w = width, h = height;
    let hw = w * 0.5, hh = h * 0.5;

    let cx1 = (Math.sin(tick * 2.0) + Math.sin(tick)) * hw * 0.3 + hw;
    let cy1 = (Math.cos(tick)) * hh * 0.3 + hh;
    let cx2 = (Math.sin(tick * 4.0) + Math.sin(tick + 1.2)) * hw * 0.3 + hw;
    let cy2 = (Math.sin(tick * 3.0) + Math.cos(tick + 0.1)) * hh * 0.3 + hh;

    let res = 48.0 / Math.max(w, h);
    let y = 0;
    while (y < height) {
        let x = 0;
        while (x < width) {
            let offset = (width * y + x);
            let v = Math.abs(
                Math.sin(distance(x, y, cx1, cy1) * res) +
                Math.sin(distance(x, y, cx2, cy2) * res)
            ) * 120.0;
            let vi = (v * 255 / 120) | 0;
            mem[offset] = (0xff000000) | (vi << 16) | (vi << 8) | vi;
            x++;
        }
        y++;
    }
}
