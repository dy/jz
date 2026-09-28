import * as scalar from './scalar.js';
export function create() {
    return [
        0,
        0,
        0
    ];
}
export function clone(a) {
    return [
        a[0],
        a[1],
        a[2]
    ];
}
export function fromValues(x, y, z) {
    return [
        x,
        y,
        z
    ];
}
export function length(a) {
    const x = a[0];
    const y = a[1];
    const z = a[2];
    return Math.sqrt(x * x + y * y + z * z);
}
export function copy(out, a) {
    out[0] = a[0];
    out[1] = a[1];
    out[2] = a[2];
    return out;
}
export function set(out, x, y, z) {
    out[0] = x;
    out[1] = y;
    out[2] = z;
    return out;
}
export function setScalar(out, s) {
    out[0] = s;
    out[1] = s;
    out[2] = s;
    return out;
}
export function fromBuffer(out, buffer, startIndex) {
    out[0] = buffer[startIndex];
    out[1] = buffer[startIndex + 1];
    out[2] = buffer[startIndex + 2];
    return out;
}
export function toBuffer(outBuffer, vec, startIndex) {
    outBuffer[startIndex] = vec[0];
    outBuffer[startIndex + 1] = vec[1];
    outBuffer[startIndex + 2] = vec[2];
    return outBuffer;
}
export function add(out, a, b) {
    out[0] = a[0] + b[0];
    out[1] = a[1] + b[1];
    out[2] = a[2] + b[2];
    return out;
}
export function addScalar(out, a, b) {
    out[0] = a[0] + b;
    out[1] = a[1] + b;
    out[2] = a[2] + b;
    return out;
}
export function subtract(out, a, b) {
    out[0] = a[0] - b[0];
    out[1] = a[1] - b[1];
    out[2] = a[2] - b[2];
    return out;
}
export function subtractScalar(out, a, b) {
    out[0] = a[0] - b;
    out[1] = a[1] - b;
    out[2] = a[2] - b;
    return out;
}
export function multiply(out, a, b) {
    out[0] = a[0] * b[0];
    out[1] = a[1] * b[1];
    out[2] = a[2] * b[2];
    return out;
}
export function divide(out, a, b) {
    out[0] = a[0] / b[0];
    out[1] = a[1] / b[1];
    out[2] = a[2] / b[2];
    return out;
}
export function ceil(out, a) {
    out[0] = Math.ceil(a[0]);
    out[1] = Math.ceil(a[1]);
    out[2] = Math.ceil(a[2]);
    return out;
}
export function floor(out, a) {
    out[0] = Math.floor(a[0]);
    out[1] = Math.floor(a[1]);
    out[2] = Math.floor(a[2]);
    return out;
}
export function min(out, a, b) {
    out[0] = Math.min(a[0], b[0]);
    out[1] = Math.min(a[1], b[1]);
    out[2] = Math.min(a[2], b[2]);
    return out;
}
export function max(out, a, b) {
    out[0] = Math.max(a[0], b[0]);
    out[1] = Math.max(a[1], b[1]);
    out[2] = Math.max(a[2], b[2]);
    return out;
}
export function round(out, a) {
    out[0] = scalar.round(a[0]);
    out[1] = scalar.round(a[1]);
    out[2] = scalar.round(a[2]);
    return out;
}
export function scale(out, a, b) {
    out[0] = a[0] * b;
    out[1] = a[1] * b;
    out[2] = a[2] * b;
    return out;
}
export function scaleAndAdd(out, a, b, scale) {
    out[0] = a[0] + b[0] * scale;
    out[1] = a[1] + b[1] * scale;
    out[2] = a[2] + b[2] * scale;
    return out;
}
export function distance(a, b) {
    const x = b[0] - a[0];
    const y = b[1] - a[1];
    const z = b[2] - a[2];
    return Math.sqrt(x * x + y * y + z * z);
}
export function squaredDistance(a, b) {
    const x = b[0] - a[0];
    const y = b[1] - a[1];
    const z = b[2] - a[2];
    return x * x + y * y + z * z;
}
export function squaredLength(a) {
    const x = a[0];
    const y = a[1];
    const z = a[2];
    return x * x + y * y + z * z;
}
export function negate(out, a) {
    out[0] = -a[0];
    out[1] = -a[1];
    out[2] = -a[2];
    return out;
}
export function inverse(out, a) {
    out[0] = 1.0 / a[0];
    out[1] = 1.0 / a[1];
    out[2] = 1.0 / a[2];
    return out;
}
export function normalize(out, a) {
    const x = a[0];
    const y = a[1];
    const z = a[2];
    let len = x * x + y * y + z * z;
    if (len > 0) {
        len = 1 / Math.sqrt(len);
    }
    out[0] = a[0] * len;
    out[1] = a[1] * len;
    out[2] = a[2] * len;
    return out;
}
export function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross(out, a, b) {
    const ax = a[0];
    const ay = a[1];
    const az = a[2];
    const bx = b[0];
    const by = b[1];
    const bz = b[2];
    out[0] = ay * bz - az * by;
    out[1] = az * bx - ax * bz;
    out[2] = ax * by - ay * bx;
    return out;
}
export function perpendicular(out, a) {
    if (Math.abs(a[0]) > Math.abs(a[1])) {
        const len = Math.sqrt(a[0] * a[0] + a[2] * a[2]);
        const invLen = 1.0 / len;
        out[0] = a[2] * invLen;
        out[1] = 0;
        out[2] = -a[0] * invLen;
    } else {
        const len = Math.sqrt(a[1] * a[1] + a[2] * a[2]);
        if (len === 0) {
            out[0] = 1;
            out[1] = 0;
            out[2] = 0;
            return out;
        }
        const invLen = 1.0 / len;
        out[0] = 0;
        out[1] = a[2] * invLen;
        out[2] = -a[1] * invLen;
    }
    return out;
}
export function lerp(out, a, b, t) {
    const ax = a[0];
    const ay = a[1];
    const az = a[2];
    out[0] = ax + t * (b[0] - ax);
    out[1] = ay + t * (b[1] - ay);
    out[2] = az + t * (b[2] - az);
    return out;
}
export function lagrange(out, a, b, c, t) {
    const c0 = 2 * (t - 1) * (t - 0.5);
    const c1 = -4 * (t - 1) * t;
    const c2 = 2 * (t - 0.5) * t;
    out[0] = c0 * a[0] + c1 * b[0] + c2 * c[0];
    out[1] = c0 * a[1] + c1 * b[1] + c2 * c[1];
    out[2] = c0 * a[2] + c1 * b[2] + c2 * c[2];
    return out;
}
export function slerp(out, a, b, t) {
    const angle = Math.acos(Math.min(Math.max(dot(a, b), -1), 1));
    const sinTotal = Math.sin(angle);
    const ratioA = Math.sin((1 - t) * angle) / sinTotal;
    const ratioB = Math.sin(t * angle) / sinTotal;
    out[0] = ratioA * a[0] + ratioB * b[0];
    out[1] = ratioA * a[1] + ratioB * b[1];
    out[2] = ratioA * a[2] + ratioB * b[2];
    return out;
}
export function hermite(out, a, b, c, d, t) {
    const factorTimes2 = t * t;
    const factor1 = factorTimes2 * (2 * t - 3) + 1;
    const factor2 = factorTimes2 * (t - 2) + t;
    const factor3 = factorTimes2 * (t - 1);
    const factor4 = factorTimes2 * (3 - 2 * t);
    out[0] = a[0] * factor1 + b[0] * factor2 + c[0] * factor3 + d[0] * factor4;
    out[1] = a[1] * factor1 + b[1] * factor2 + c[1] * factor3 + d[1] * factor4;
    out[2] = a[2] * factor1 + b[2] * factor2 + c[2] * factor3 + d[2] * factor4;
    return out;
}
export function bezier(out, a, b, c, d, t) {
    const inverseFactor = 1 - t;
    const inverseFactorTimesTwo = inverseFactor * inverseFactor;
    const factorTimes2 = t * t;
    const factor1 = inverseFactorTimesTwo * inverseFactor;
    const factor2 = 3 * t * inverseFactorTimesTwo;
    const factor3 = 3 * factorTimes2 * inverseFactor;
    const factor4 = factorTimes2 * t;
    out[0] = a[0] * factor1 + b[0] * factor2 + c[0] * factor3 + d[0] * factor4;
    out[1] = a[1] * factor1 + b[1] * factor2 + c[1] * factor3 + d[1] * factor4;
    out[2] = a[2] * factor1 + b[2] * factor2 + c[2] * factor3 + d[2] * factor4;
    return out;
}
export function transformMat4(out, a, m) {
    const x = a[0];
    const y = a[1];
    const z = a[2];
    let w = m[3] * x + m[7] * y + m[11] * z + m[15];
    w = w || 1.0;
    out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    return out;
}
export function transformMat3(out, a, m) {
    const x = a[0];
    const y = a[1];
    const z = a[2];
    out[0] = x * m[0] + y * m[3] + z * m[6];
    out[1] = x * m[1] + y * m[4] + z * m[7];
    out[2] = x * m[2] + y * m[5] + z * m[8];
    return out;
}
export function transformQuat(out, a, q) {
    const qx = q[0];
    const qy = q[1];
    const qz = q[2];
    const qw = q[3];
    const x = a[0];
    const y = a[1];
    const z = a[2];
    let uvx = qy * z - qz * y;
    let uvy = qz * x - qx * z;
    let uvz = qx * y - qy * x;
    let uuvx = qy * uvz - qz * uvy;
    let uuvy = qz * uvx - qx * uvz;
    let uuvz = qx * uvy - qy * uvx;
    const w2 = qw * 2;
    uvx *= w2;
    uvy *= w2;
    uvz *= w2;
    uuvx *= 2;
    uuvy *= 2;
    uuvz *= 2;
    out[0] = x + uvx + uuvx;
    out[1] = y + uvy + uuvy;
    out[2] = z + uvz + uuvz;
    return out;
}
export function rotateX(out, a, b, rad) {
    const p1 = a[1] - b[1];
    const p2 = a[2] - b[2];
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    out[0] = a[0];
    out[1] = p1 * c - p2 * s + b[1];
    out[2] = p1 * s + p2 * c + b[2];
    return out;
}
export function rotateY(out, a, b, rad) {
    const p0 = a[0] - b[0];
    const p2 = a[2] - b[2];
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    out[0] = p2 * s + p0 * c + b[0];
    out[1] = a[1];
    out[2] = p2 * c - p0 * s + b[2];
    return out;
}
export function rotateZ(out, a, b, rad) {
    const p0 = a[0] - b[0];
    const p1 = a[1] - b[1];
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    out[0] = p0 * c - p1 * s + b[0];
    out[1] = p0 * s + p1 * c + b[1];
    out[2] = a[2];
    return out;
}
export function angle(a, b) {
    const ax = a[0];
    const ay = a[1];
    const az = a[2];
    const bx = b[0];
    const by = b[1];
    const bz = b[2];
    const mag = Math.sqrt((ax * ax + ay * ay + az * az) * (bx * bx + by * by + bz * bz));
    const cosine = mag && dot(a, b) / mag;
    return Math.acos(Math.min(Math.max(cosine, -1), 1));
}
export function signedAngle(a, b, axis) {
    const nx = axis[0];
    const ny = axis[1];
    const nz = axis[2];
    const ad = a[0] * nx + a[1] * ny + a[2] * nz;
    const ax = a[0] - nx * ad;
    const ay = a[1] - ny * ad;
    const az = a[2] - nz * ad;
    const bd = b[0] * nx + b[1] * ny + b[2] * nz;
    const bx = b[0] - nx * bd;
    const by = b[1] - ny * bd;
    const bz = b[2] - nz * bd;
    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    return Math.atan2(cx * nx + cy * ny + cz * nz, ax * bx + ay * by + az * bz);
}
const _rotateTowards_axis = [
    0,
    0,
    0
];
export function rotateTowards(out, from, to, maxAngle) {
    const fx = from[0];
    const fy = from[1];
    const fz = from[2];
    const tx = to[0];
    const ty = to[1];
    const tz = to[2];
    const cosine = Math.min(Math.max(fx * tx + fy * ty + fz * tz, -1), 1);
    const limit = maxAngle > 0 ? maxAngle : 0;
    if (Math.acos(cosine) <= limit) {
        out[0] = tx;
        out[1] = ty;
        out[2] = tz;
        return out;
    }
    let axisX = fy * tz - fz * ty;
    let axisY = fz * tx - fx * tz;
    let axisZ = fx * ty - fy * tx;
    const axisLength = Math.sqrt(axisX * axisX + axisY * axisY + axisZ * axisZ);
    if (axisLength < 1e-8) {
        perpendicular(_rotateTowards_axis, from);
        axisX = _rotateTowards_axis[0];
        axisY = _rotateTowards_axis[1];
        axisZ = _rotateTowards_axis[2];
    } else {
        const inverseLength = 1 / axisLength;
        axisX *= inverseLength;
        axisY *= inverseLength;
        axisZ *= inverseLength;
    }
    const c = Math.cos(limit);
    const s = Math.sin(limit);
    const d = (axisX * fx + axisY * fy + axisZ * fz) * (1 - c);
    out[0] = fx * c + (axisY * fz - axisZ * fy) * s + axisX * d;
    out[1] = fy * c + (axisZ * fx - axisX * fz) * s + axisY * d;
    out[2] = fz * c + (axisX * fy - axisY * fx) * s + axisZ * d;
    return out;
}
export function zero(out) {
    out[0] = 0.0;
    out[1] = 0.0;
    out[2] = 0.0;
    return out;
}
export function str(a) {
    return `vec3(${a[0]}, ${a[1]}, ${a[2]})`;
}
export function exactEquals(a, b) {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
export function equals(a, b) {
    const a0 = a[0];
    const a1 = a[1];
    const a2 = a[2];
    const b0 = b[0];
    const b1 = b[1];
    const b2 = b[2];
    return Math.abs(a0 - b0) <= scalar.EPSILON * Math.max(1.0, Math.abs(a0), Math.abs(b0)) && Math.abs(a1 - b1) <= scalar.EPSILON * Math.max(1.0, Math.abs(a1), Math.abs(b1)) && Math.abs(a2 - b2) <= scalar.EPSILON * Math.max(1.0, Math.abs(a2), Math.abs(b2));
}
export function finite(a) {
    return Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);
}
export function isScaleInsideOut(scale) {
    const mask = (scale[0] < 0 ? 1 : 0) | (scale[1] < 0 ? 2 : 0) | (scale[2] < 0 ? 4 : 0);
    let count = 0;
    let m = mask;
    while(m){
        count += m & 1;
        m >>= 1;
    }
    return (count & 1) !== 0;
}
export const sub = subtract;
export const mul = multiply;
export const div = divide;
export const dist = distance;
export const sqrDist = squaredDistance;
export const len = length;
export const sqrLen = squaredLength;
