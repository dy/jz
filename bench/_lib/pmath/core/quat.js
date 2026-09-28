import * as mat3 from './mat3.js';
import { EPSILON } from './scalar.js';
import * as vec3 from './vec3.js';
import * as vec4 from './vec4.js';
export function create() {
    return [
        0,
        0,
        0,
        1
    ];
}
export function fromBuffer(out, buffer, startIndex) {
    out[0] = buffer[startIndex];
    out[1] = buffer[startIndex + 1];
    out[2] = buffer[startIndex + 2];
    out[3] = buffer[startIndex + 3];
    return out;
}
export function toBuffer(outBuffer, q, startIndex) {
    outBuffer[startIndex] = q[0];
    outBuffer[startIndex + 1] = q[1];
    outBuffer[startIndex + 2] = q[2];
    outBuffer[startIndex + 3] = q[3];
    return outBuffer;
}
export function identity(out) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 1;
    return out;
}
export function setAxisAngle(out, axis, rad) {
    rad *= 0.5;
    const s = Math.sin(rad);
    out[0] = s * axis[0];
    out[1] = s * axis[1];
    out[2] = s * axis[2];
    out[3] = Math.cos(rad);
    return out;
}
export function getAxisAngle(out_axis, q) {
    const rad = Math.acos(q[3]) * 2.0;
    const s = Math.sin(rad / 2.0);
    if (s > EPSILON) {
        out_axis[0] = q[0] / s;
        out_axis[1] = q[1] / s;
        out_axis[2] = q[2] / s;
    } else {
        out_axis[0] = 1;
        out_axis[1] = 0;
        out_axis[2] = 0;
    }
    return rad;
}
export function getAngle(a, b) {
    const dotproduct = dot(a, b);
    return Math.acos(2 * dotproduct * dotproduct - 1);
}
export function multiply(out, a, b) {
    const ax = a[0];
    const ay = a[1];
    const az = a[2];
    const aw = a[3];
    const bx = b[0];
    const by = b[1];
    const bz = b[2];
    const bw = b[3];
    out[0] = ax * bw + aw * bx + ay * bz - az * by;
    out[1] = ay * bw + aw * by + az * bx - ax * bz;
    out[2] = az * bw + aw * bz + ax * by - ay * bx;
    out[3] = aw * bw - ax * bx - ay * by - az * bz;
    return out;
}
export function rotateX(out, a, rad) {
    rad *= 0.5;
    const ax = a[0];
    const ay = a[1];
    const az = a[2];
    const aw = a[3];
    const bx = Math.sin(rad);
    const bw = Math.cos(rad);
    out[0] = ax * bw + aw * bx;
    out[1] = ay * bw + az * bx;
    out[2] = az * bw - ay * bx;
    out[3] = aw * bw - ax * bx;
    return out;
}
export function rotateY(out, a, rad) {
    rad *= 0.5;
    const ax = a[0];
    const ay = a[1];
    const az = a[2];
    const aw = a[3];
    const by = Math.sin(rad);
    const bw = Math.cos(rad);
    out[0] = ax * bw - az * by;
    out[1] = ay * bw + aw * by;
    out[2] = az * bw + ax * by;
    out[3] = aw * bw - ay * by;
    return out;
}
export function rotateZ(out, a, rad) {
    rad *= 0.5;
    const ax = a[0];
    const ay = a[1];
    const az = a[2];
    const aw = a[3];
    const bz = Math.sin(rad);
    const bw = Math.cos(rad);
    out[0] = ax * bw + ay * bz;
    out[1] = ay * bw - ax * bz;
    out[2] = az * bw + aw * bz;
    out[3] = aw * bw - az * bz;
    return out;
}
export function calculateW(out, a) {
    const x = a[0];
    const y = a[1];
    const z = a[2];
    out[0] = x;
    out[1] = y;
    out[2] = z;
    out[3] = Math.sqrt(Math.abs(1.0 - x * x - y * y - z * z));
    return out;
}
export function exp(out, a) {
    const x = a[0];
    const y = a[1];
    const z = a[2];
    const w = a[3];
    const r = Math.sqrt(x * x + y * y + z * z);
    const et = Math.exp(w);
    const s = r > 0 ? et * Math.sin(r) / r : 0;
    out[0] = x * s;
    out[1] = y * s;
    out[2] = z * s;
    out[3] = et * Math.cos(r);
    return out;
}
export function ln(out, a) {
    const x = a[0];
    const y = a[1];
    const z = a[2];
    const w = a[3];
    const r = Math.sqrt(x * x + y * y + z * z);
    const t = r > 0 ? Math.atan2(r, w) / r : 0;
    out[0] = x * t;
    out[1] = y * t;
    out[2] = z * t;
    out[3] = 0.5 * Math.log(x * x + y * y + z * z + w * w);
    return out;
}
export function pow(out, a, b) {
    ln(out, a);
    scale(out, out, b);
    exp(out, out);
    return out;
}
export function slerp(out, a, b, t) {
    const ax = a[0];
    const ay = a[1];
    const az = a[2];
    const aw = a[3];
    let bx = b[0];
    let by = b[1];
    let bz = b[2];
    let bw = b[3];
    let omega;
    let cosom;
    let sinom;
    let scale0;
    let scale1;
    cosom = ax * bx + ay * by + az * bz + aw * bw;
    if (cosom < 0.0) {
        cosom = -cosom;
        bx = -bx;
        by = -by;
        bz = -bz;
        bw = -bw;
    }
    if (1.0 - cosom > EPSILON) {
        omega = Math.acos(cosom);
        sinom = Math.sin(omega);
        scale0 = Math.sin((1.0 - t) * omega) / sinom;
        scale1 = Math.sin(t * omega) / sinom;
    } else {
        scale0 = 1.0 - t;
        scale1 = t;
    }
    out[0] = scale0 * ax + scale1 * bx;
    out[1] = scale0 * ay + scale1 * by;
    out[2] = scale0 * az + scale1 * bz;
    out[3] = scale0 * aw + scale1 * bw;
    return out;
}
export function invert(out, a) {
    const a0 = a[0];
    const a1 = a[1];
    const a2 = a[2];
    const a3 = a[3];
    const dot = a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3;
    if (dot === 0) {
        out[0] = 0;
        out[1] = 0;
        out[2] = 0;
        out[3] = 0;
        return out;
    }
    const invDot = 1.0 / dot;
    out[0] = -a0 * invDot;
    out[1] = -a1 * invDot;
    out[2] = -a2 * invDot;
    out[3] = a3 * invDot;
    return out;
}
export function conjugate(out, a) {
    out[0] = -a[0];
    out[1] = -a[1];
    out[2] = -a[2];
    out[3] = a[3];
    return out;
}
export function fromMat3(out, m) {
    const fTrace = m[0] + m[4] + m[8];
    let fRoot;
    if (fTrace > 0.0) {
        fRoot = Math.sqrt(fTrace + 1.0);
        out[3] = 0.5 * fRoot;
        fRoot = 0.5 / fRoot;
        out[0] = (m[5] - m[7]) * fRoot;
        out[1] = (m[6] - m[2]) * fRoot;
        out[2] = (m[1] - m[3]) * fRoot;
    } else {
        let i = 0;
        if (m[4] > m[0]) i = 1;
        if (m[8] > m[i * 3 + i]) i = 2;
        const j = (i + 1) % 3;
        const k = (i + 2) % 3;
        fRoot = Math.sqrt(m[i * 3 + i] - m[j * 3 + j] - m[k * 3 + k] + 1.0);
        out[i] = 0.5 * fRoot;
        fRoot = 0.5 / fRoot;
        out[3] = (m[j * 3 + k] - m[k * 3 + j]) * fRoot;
        out[j] = (m[j * 3 + i] + m[i * 3 + j]) * fRoot;
        out[k] = (m[k * 3 + i] + m[i * 3 + k]) * fRoot;
    }
    return out;
}
export function fromMat4(out, m) {
    const m3 = mat3.create();
    mat3.fromMat4(m3, m);
    return fromMat3(out, m3);
}
export function fromEuler(out, euler) {
    const x = euler[0];
    const y = euler[1];
    const z = euler[2];
    const order = euler[3] || 'xyz';
    const cos = Math.cos;
    const sin = Math.sin;
    const c1 = cos(x / 2);
    const c2 = cos(y / 2);
    const c3 = cos(z / 2);
    const s1 = sin(x / 2);
    const s2 = sin(y / 2);
    const s3 = sin(z / 2);
    switch(order){
        case 'xyz':
            out[0] = s1 * c2 * c3 + c1 * s2 * s3;
            out[1] = c1 * s2 * c3 - s1 * c2 * s3;
            out[2] = c1 * c2 * s3 + s1 * s2 * c3;
            out[3] = c1 * c2 * c3 - s1 * s2 * s3;
            break;
        case 'yxz':
            out[0] = s1 * c2 * c3 + c1 * s2 * s3;
            out[1] = c1 * s2 * c3 - s1 * c2 * s3;
            out[2] = c1 * c2 * s3 - s1 * s2 * c3;
            out[3] = c1 * c2 * c3 + s1 * s2 * s3;
            break;
        case 'zxy':
            out[0] = s1 * c2 * c3 - c1 * s2 * s3;
            out[1] = c1 * s2 * c3 + s1 * c2 * s3;
            out[2] = c1 * c2 * s3 + s1 * s2 * c3;
            out[3] = c1 * c2 * c3 - s1 * s2 * s3;
            break;
        case 'zyx':
            out[0] = s1 * c2 * c3 - c1 * s2 * s3;
            out[1] = c1 * s2 * c3 + s1 * c2 * s3;
            out[2] = c1 * c2 * s3 - s1 * s2 * c3;
            out[3] = c1 * c2 * c3 + s1 * s2 * s3;
            break;
        case 'yzx':
            out[0] = s1 * c2 * c3 + c1 * s2 * s3;
            out[1] = c1 * s2 * c3 + s1 * c2 * s3;
            out[2] = c1 * c2 * s3 - s1 * s2 * c3;
            out[3] = c1 * c2 * c3 - s1 * s2 * s3;
            break;
        case 'xzy':
            out[0] = s1 * c2 * c3 - c1 * s2 * s3;
            out[1] = c1 * s2 * c3 - s1 * c2 * s3;
            out[2] = c1 * c2 * s3 + s1 * s2 * c3;
            out[3] = c1 * c2 * c3 + s1 * s2 * s3;
            break;
        default:
            console.warn(`fromEuler() encountered an unknown order: ${order}`);
    }
    return out;
}
const _fromDegrees_euler = [
    0,
    0,
    0,
    'xyz'
];
export function fromDegrees(out, x, y, z, order) {
    _fromDegrees_euler[0] = x * Math.PI / 180;
    _fromDegrees_euler[1] = y * Math.PI / 180;
    _fromDegrees_euler[2] = z * Math.PI / 180;
    _fromDegrees_euler[3] = order;
    return fromEuler(out, _fromDegrees_euler);
}
export function str(a) {
    return `quat(${a[0]}, ${a[1]}, ${a[2]}, ${a[3]})`;
}
export const clone = vec4.clone;
export const fromValues = vec4.fromValues;
export const copy = vec4.copy;
export const set = vec4.set;
export const add = vec4.add;
export const scale = vec4.scale;
export const dot = vec4.dot;
export const lerp = vec4.lerp;
export const length = vec4.length;
export const len = length;
export const squaredLength = vec4.squaredLength;
export const sqrLen = squaredLength;
export const mul = multiply;
export const normalize = vec4.normalize;
export const exactEquals = vec4.exactEquals;
export function equals(a, b) {
    return Math.abs(vec4.dot(a, b)) >= 1 - EPSILON;
}
export const rotationTo = (()=>{
    const tmpvec3 = vec3.create();
    const xUnitVec3 = vec3.fromValues(1, 0, 0);
    const yUnitVec3 = vec3.fromValues(0, 1, 0);
    return (out, a, b)=>{
        const dot = vec3.dot(a, b);
        if (dot < -0.999999) {
            vec3.cross(tmpvec3, xUnitVec3, a);
            if (vec3.length(tmpvec3) < 0.000001) vec3.cross(tmpvec3, yUnitVec3, a);
            vec3.normalize(tmpvec3, tmpvec3);
            setAxisAngle(out, tmpvec3, Math.PI);
            return out;
        }
        if (dot > 0.999999) {
            out[0] = 0;
            out[1] = 0;
            out[2] = 0;
            out[3] = 1;
            return out;
        }
        vec3.cross(tmpvec3, a, b);
        out[0] = tmpvec3[0];
        out[1] = tmpvec3[1];
        out[2] = tmpvec3[2];
        out[3] = 1 + dot;
        return normalize(out, out);
    };
})();
export const sqlerp = (()=>{
    const temp1 = create();
    const temp2 = create();
    return (out, a, b, c, d, t)=>{
        slerp(temp1, a, d, t);
        slerp(temp2, b, c, t);
        slerp(out, temp1, temp2, 2 * t * (1 - t));
        return out;
    };
})();
export const setAxes = (()=>{
    const matr = mat3.create();
    return (out, view, right, up)=>{
        matr[0] = right[0];
        matr[3] = right[1];
        matr[6] = right[2];
        matr[1] = up[0];
        matr[4] = up[1];
        matr[7] = up[2];
        matr[2] = -view[0];
        matr[5] = -view[1];
        matr[8] = -view[2];
        return normalize(out, fromMat3(out, matr));
    };
})();
