import * as scalar from './scalar.js';
export function create() {
    return [
        0,
        0
    ];
}
export function clone(a) {
    return [
        a[0],
        a[1]
    ];
}
export function fromValues(x, y) {
    return [
        x,
        y
    ];
}
export function copy(out, a) {
    out[0] = a[0];
    out[1] = a[1];
    return out;
}
export function set(out, x, y) {
    out[0] = x;
    out[1] = y;
    return out;
}
export function fromBuffer(out, buffer, startIndex) {
    out[0] = buffer[startIndex];
    out[1] = buffer[startIndex + 1];
    return out;
}
export function toBuffer(outBuffer, vec, startIndex) {
    outBuffer[startIndex] = vec[0];
    outBuffer[startIndex + 1] = vec[1];
    return outBuffer;
}
export function add(out, a, b) {
    out[0] = a[0] + b[0];
    out[1] = a[1] + b[1];
    return out;
}
export function addScalar(out, a, b) {
    out[0] = a[0] + b;
    out[1] = a[1] + b;
    return out;
}
export function subtract(out, a, b) {
    out[0] = a[0] - b[0];
    out[1] = a[1] - b[1];
    return out;
}
export function subtractScalar(out, a, b) {
    out[0] = a[0] - b;
    out[1] = a[1] - b;
    return out;
}
export function multiply(out, a, b) {
    out[0] = a[0] * b[0];
    out[1] = a[1] * b[1];
    return out;
}
export function divide(out, a, b) {
    out[0] = a[0] / b[0];
    out[1] = a[1] / b[1];
    return out;
}
export function ceil(out, a) {
    out[0] = Math.ceil(a[0]);
    out[1] = Math.ceil(a[1]);
    return out;
}
export function floor(out, a) {
    out[0] = Math.floor(a[0]);
    out[1] = Math.floor(a[1]);
    return out;
}
export function min(out, a, b) {
    out[0] = Math.min(a[0], b[0]);
    out[1] = Math.min(a[1], b[1]);
    return out;
}
export function max(out, a, b) {
    out[0] = Math.max(a[0], b[0]);
    out[1] = Math.max(a[1], b[1]);
    return out;
}
export function round(out, a) {
    out[0] = scalar.round(a[0]);
    out[1] = scalar.round(a[1]);
    return out;
}
export function scale(out, a, b) {
    out[0] = a[0] * b;
    out[1] = a[1] * b;
    return out;
}
export function scaleAndAdd(out, a, b, scale) {
    out[0] = a[0] + b[0] * scale;
    out[1] = a[1] + b[1] * scale;
    return out;
}
export function distance(a, b) {
    const x = b[0] - a[0];
    const y = b[1] - a[1];
    return Math.sqrt(x * x + y * y);
}
export function squaredDistance(a, b) {
    const x = b[0] - a[0];
    const y = b[1] - a[1];
    return x * x + y * y;
}
export function length(a) {
    const x = a[0];
    const y = a[1];
    return Math.sqrt(x * x + y * y);
}
export function squaredLength(a) {
    const x = a[0];
    const y = a[1];
    return x * x + y * y;
}
export function negate(out, a) {
    out[0] = -a[0];
    out[1] = -a[1];
    return out;
}
export function inverse(out, a) {
    out[0] = 1.0 / a[0];
    out[1] = 1.0 / a[1];
    return out;
}
export function normalize(out, a) {
    const x = a[0];
    const y = a[1];
    let len = x * x + y * y;
    if (len > 0) {
        len = 1 / Math.sqrt(len);
    }
    out[0] = a[0] * len;
    out[1] = a[1] * len;
    return out;
}
export function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1];
}
export function cross(out, a, b) {
    const z = a[0] * b[1] - a[1] * b[0];
    out[0] = out[1] = 0;
    out[2] = z;
    return out;
}
export function lerp(out, a, b, t) {
    const ax = a[0];
    const ay = a[1];
    out[0] = ax + t * (b[0] - ax);
    out[1] = ay + t * (b[1] - ay);
    return out;
}
export function lagrange(out, a, b, c, t) {
    const c0 = 2 * (t - 1) * (t - 0.5);
    const c1 = -4 * (t - 1) * t;
    const c2 = 2 * (t - 0.5) * t;
    out[0] = c0 * a[0] + c1 * b[0] + c2 * c[0];
    out[1] = c0 * a[1] + c1 * b[1] + c2 * c[1];
    return out;
}
export function transformMat2(out, a, m) {
    const x = a[0];
    const y = a[1];
    out[0] = m[0] * x + m[2] * y;
    out[1] = m[1] * x + m[3] * y;
    return out;
}
export function transformMat2d(out, a, m) {
    const x = a[0];
    const y = a[1];
    out[0] = m[0] * x + m[2] * y + m[4];
    out[1] = m[1] * x + m[3] * y + m[5];
    return out;
}
export function transformMat3(out, a, m) {
    const x = a[0];
    const y = a[1];
    out[0] = m[0] * x + m[3] * y + m[6];
    out[1] = m[1] * x + m[4] * y + m[7];
    return out;
}
export function transformMat4(out, a, m) {
    const x = a[0];
    const y = a[1];
    out[0] = m[0] * x + m[4] * y + m[12];
    out[1] = m[1] * x + m[5] * y + m[13];
    return out;
}
export function rotate(out, a, b, rad) {
    const p0 = a[0] - b[0];
    const p1 = a[1] - b[1];
    const sinC = Math.sin(rad);
    const cosC = Math.cos(rad);
    out[0] = p0 * cosC - p1 * sinC + b[0];
    out[1] = p0 * sinC + p1 * cosC + b[1];
    return out;
}
export function angle(a, b) {
    const x1 = a[0];
    const y1 = a[1];
    const x2 = b[0];
    const y2 = b[1];
    const mag = Math.sqrt((x1 * x1 + y1 * y1) * (x2 * x2 + y2 * y2));
    const cosine = mag && (x1 * x2 + y1 * y2) / mag;
    return Math.acos(Math.min(Math.max(cosine, -1), 1));
}
export function signedAngle(a, b) {
    const ax = a[0];
    const ay = a[1];
    const bx = b[0];
    const by = b[1];
    return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
}
export function zero(out) {
    out[0] = 0.0;
    out[1] = 0.0;
    return out;
}
export function str(a) {
    return `vec2(${a[0]}, ${a[1]})`;
}
export function exactEquals(a, b) {
    return a[0] === b[0] && a[1] === b[1];
}
export function equals(a, b) {
    const a0 = a[0];
    const a1 = a[1];
    const b0 = b[0];
    const b1 = b[1];
    return Math.abs(a0 - b0) <= scalar.EPSILON * Math.max(1.0, Math.abs(a0), Math.abs(b0)) && Math.abs(a1 - b1) <= scalar.EPSILON * Math.max(1.0, Math.abs(a1), Math.abs(b1));
}
export function finite(a) {
    return Number.isFinite(a[0]) && Number.isFinite(a[1]);
}
export const len = length;
export const sub = subtract;
export const mul = multiply;
export const div = divide;
export const dist = distance;
export const sqrDist = squaredDistance;
export const sqrLen = squaredLength;
