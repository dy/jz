import * as quat from './quat.js';
import { clamp, EPSILON } from './scalar.js';
const DEG2RAD = Math.PI / 180;
export function create() {
    return [
        0,
        0,
        0,
        'xyz'
    ];
}
export function fromValues(x, y, z, order) {
    return [
        x,
        y,
        z,
        order
    ];
}
export function set(out, x, y, z, order) {
    out[0] = x;
    out[1] = y;
    out[2] = z;
    out[3] = order;
    return out;
}
export function fromDegrees(out, x, y, z, order) {
    out[0] = x * DEG2RAD;
    out[1] = y * DEG2RAD;
    out[2] = z * DEG2RAD;
    out[3] = order;
    return out;
}
export function fromRotationMat4(out, rotationMatrix, order = out[3] || 'xyz') {
    return fromRotationMatrixValues(out, rotationMatrix[0], rotationMatrix[4], rotationMatrix[8], rotationMatrix[1], rotationMatrix[5], rotationMatrix[9], rotationMatrix[2], rotationMatrix[6], rotationMatrix[10], order);
}
function fromRotationMatrixValues(out, m11, m12, m13, m21, m22, m23, m31, m32, m33, order) {
    switch(order){
        case 'xyz':
            out[1] = Math.asin(clamp(m13, -1, 1));
            if (Math.abs(m13) < 0.9999999) {
                out[0] = Math.atan2(-m23, m33);
                out[2] = Math.atan2(-m12, m11);
            } else {
                out[0] = Math.atan2(m32, m22);
                out[2] = 0;
            }
            break;
        case 'yxz':
            out[0] = Math.asin(-clamp(m23, -1, 1));
            if (Math.abs(m23) < 0.9999999) {
                out[1] = Math.atan2(m13, m33);
                out[2] = Math.atan2(m21, m22);
            } else {
                out[1] = Math.atan2(-m31, m11);
                out[2] = 0;
            }
            break;
        case 'zxy':
            out[0] = Math.asin(clamp(m32, -1, 1));
            if (Math.abs(m32) < 0.9999999) {
                out[1] = Math.atan2(-m31, m33);
                out[2] = Math.atan2(-m12, m22);
            } else {
                out[1] = 0;
                out[2] = Math.atan2(m21, m11);
            }
            break;
        case 'zyx':
            out[1] = Math.asin(-clamp(m31, -1, 1));
            if (Math.abs(m31) < 0.9999999) {
                out[0] = Math.atan2(m32, m33);
                out[2] = Math.atan2(m21, m11);
            } else {
                out[0] = 0;
                out[2] = Math.atan2(-m12, m22);
            }
            break;
        case 'yzx':
            out[2] = Math.asin(clamp(m21, -1, 1));
            if (Math.abs(m21) < 0.9999999) {
                out[0] = Math.atan2(-m23, m22);
                out[1] = Math.atan2(-m31, m11);
            } else {
                out[0] = 0;
                out[1] = Math.atan2(m13, m33);
            }
            break;
        case 'xzy':
            out[2] = Math.asin(-clamp(m12, -1, 1));
            if (Math.abs(m12) < 0.9999999) {
                out[0] = Math.atan2(m32, m22);
                out[1] = Math.atan2(m13, m11);
            } else {
                out[0] = Math.atan2(-m23, m33);
                out[1] = 0;
            }
            break;
        default:
            console.warn(`encountered an unknown order: ${order}`);
    }
    out[3] = order;
    return out;
}
export function exactEquals(a, b) {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}
export function equals(a, b) {
    const a0 = a[0];
    const a1 = a[1];
    const a2 = a[2];
    const b0 = b[0];
    const b1 = b[1];
    const b2 = b[2];
    return Math.abs(a0 - b0) <= EPSILON * Math.max(1.0, Math.abs(a0), Math.abs(b0)) && Math.abs(a1 - b1) <= EPSILON * Math.max(1.0, Math.abs(a1), Math.abs(b1)) && Math.abs(a2 - b2) <= EPSILON * Math.max(1.0, Math.abs(a2), Math.abs(b2)) && a[3] === b[3];
}
export function fromQuat(out, q, order) {
    const x = q[0];
    const y = q[1];
    const z = q[2];
    const w = q[3];
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const yx = y * x2;
    const yy = y * y2;
    const zx = z * x2;
    const zy = z * y2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    return fromRotationMatrixValues(out, 1 - yy - zz, yx - wz, zx + wy, yx + wz, 1 - xx - zz, zy - wx, zx - wy, zy + wx, 1 - xx - yy, order);
}
const _reorderQuaternion = quat.create();
export function reorder(out, a, order) {
    quat.fromEuler(_reorderQuaternion, a);
    fromQuat(out, _reorderQuaternion, order);
    return out;
}
