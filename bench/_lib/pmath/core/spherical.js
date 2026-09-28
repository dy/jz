import { wrapAngle } from './angle.js';
import * as scalar from './scalar.js';
export function create() {
    return [
        1,
        0,
        0
    ];
}
export function fromValues(r, theta, phi) {
    return [
        r,
        theta,
        phi
    ];
}
export function clone(a) {
    return [
        a[0],
        a[1],
        a[2]
    ];
}
export function copy(out, a) {
    out[0] = a[0];
    out[1] = a[1];
    out[2] = a[2];
    return out;
}
export function set(out, r, theta, phi) {
    out[0] = r;
    out[1] = theta;
    out[2] = phi;
    return out;
}
export function normalize(out, a) {
    out[0] = a[0] === 0 ? 0 : 1;
    out[1] = a[1];
    out[2] = a[2];
    return out;
}
export function scale(out, a, s) {
    out[0] = a[0] * s;
    out[1] = a[1];
    out[2] = a[2];
    return out;
}
export function lerp(out, a, b, t) {
    out[0] = scalar.lerp(a[0], b[0], t);
    out[1] = a[1] + wrapAngle(b[1] - a[1]) * t;
    out[2] = a[2] + wrapAngle(b[2] - a[2]) * t;
    return out;
}
export function setFromVec3(out, v) {
    const x = v[0];
    const y = v[1];
    const z = v[2];
    const r = Math.sqrt(x * x + y * y + z * z);
    out[0] = r;
    out[1] = r === 0 ? 0 : Math.atan2(x, z);
    out[2] = r === 0 ? 0 : Math.acos(Math.max(-1, Math.min(1, y / r)));
    return out;
}
export const fromVec3 = setFromVec3;
export function makeSafe(out, a) {
    const EPS = scalar.EPSILON;
    out[0] = a[0];
    out[1] = a[1];
    out[2] = Math.max(EPS, Math.min(Math.PI - EPS, a[2]));
    return out;
}
export function toVec3(out, a) {
    const r = a[0];
    const theta = a[1];
    const phi = a[2];
    const rSinPhi = r * Math.sin(phi);
    out[0] = rSinPhi * Math.sin(theta);
    out[1] = r * Math.cos(phi);
    out[2] = rSinPhi * Math.cos(theta);
    return out;
}
export function fromVec2(out, v) {
    const x = v[0];
    const z = v[1];
    const r = Math.sqrt(x * x + z * z);
    out[0] = r;
    out[1] = r === 0 ? 0 : Math.atan2(x, z);
    out[2] = Math.PI / 2;
    return out;
}
export function toVec2(out, a) {
    const r = a[0];
    const theta = a[1];
    const phi = a[2];
    const rSinPhi = r * Math.sin(phi);
    out[0] = rSinPhi * Math.sin(theta);
    out[1] = rSinPhi * Math.cos(theta);
    return out;
}
export function equals(a, b) {
    return scalar.equals(a[0], b[0]) && scalar.equals(a[1], b[1]) && scalar.equals(a[2], b[2]);
}
export function exactEquals(a, b) {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
export function str(a) {
    return `Spherical(${a[0]}, ${a[1]}, ${a[2]})`;
}
export function angleTo(a, b) {
    const phiA = a[2];
    const phiB = b[2];
    const dTheta = b[1] - a[1];
    const sHalfPhi = Math.sin((phiB - phiA) / 2);
    const sHalfTheta = Math.sin(dTheta / 2);
    const hav = sHalfPhi * sHalfPhi + Math.sin(phiA) * Math.sin(phiB) * sHalfTheta * sHalfTheta;
    return 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, hav))));
}
