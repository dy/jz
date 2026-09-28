import * as scalar from './scalar.js';
import { wrapAngle } from './angle.js';
export function create() {
    return [
        1,
        0
    ];
}
export function fromValues(r, theta) {
    return [
        r,
        theta
    ];
}
export function clone(a) {
    return [
        a[0],
        a[1]
    ];
}
export function copy(out, a) {
    out[0] = a[0];
    out[1] = a[1];
    return out;
}
export function set(out, r, theta) {
    out[0] = r;
    out[1] = theta;
    return out;
}
export function normalize(out, a) {
    out[0] = a[0] === 0 ? 0 : 1;
    out[1] = a[1];
    return out;
}
export function scale(out, a, s) {
    out[0] = a[0] * s;
    out[1] = a[1];
    return out;
}
export function rotate(out, a, rad) {
    out[0] = a[0];
    out[1] = wrapAngle(a[1] + rad);
    return out;
}
export function lerp(out, a, b, t) {
    out[0] = scalar.lerp(a[0], b[0], t);
    out[1] = a[1] + wrapAngle(b[1] - a[1]) * t;
    return out;
}
export function setFromVec2(out, v) {
    const x = v[0];
    const y = v[1];
    out[0] = Math.sqrt(x * x + y * y);
    out[1] = out[0] === 0 ? 0 : Math.atan2(y, x);
    return out;
}
export const fromVec2 = setFromVec2;
export function toVec2(out, a) {
    const r = a[0];
    const theta = a[1];
    out[0] = r * Math.cos(theta);
    out[1] = r * Math.sin(theta);
    return out;
}
export function angleTo(a, b) {
    return Math.abs(wrapAngle(b[1] - a[1]));
}
export function distance(a, b) {
    const ra = a[0];
    const rb = b[0];
    const d = ra * ra + rb * rb - 2 * ra * rb * Math.cos(b[1] - a[1]);
    return Math.sqrt(Math.max(0, d));
}
export function equals(a, b) {
    return scalar.equals(a[0], b[0]) && scalar.equals(a[1], b[1]);
}
export function exactEquals(a, b) {
    return a[0] === b[0] && a[1] === b[1];
}
export function str(a) {
    return `Polar(${a[0]}, ${a[1]})`;
}
