// The public surface of three.js's math classes, one export per group of
// methods. Each export takes no argument and answers a number or a string
// that every call of the group feeds, so one wrong method shows. Compiled by
// jz and run by Node from this same file (test/three.js). An export whose
// name ends in `_t` reaches a transcendental function (sin, cos, acos, atan2,
// pow, exp), where jz and libm agree to the last digits but not in them.
import { Vector2 } from 'three/src/math/Vector2.js'
import { Vector3 } from 'three/src/math/Vector3.js'
import { Vector4 } from 'three/src/math/Vector4.js'
import { Quaternion } from 'three/src/math/Quaternion.js'
import { Euler } from 'three/src/math/Euler.js'
import { Matrix2 } from 'three/src/math/Matrix2.js'
import { Matrix3 } from 'three/src/math/Matrix3.js'
import { Matrix4 } from 'three/src/math/Matrix4.js'
import { Box2 } from 'three/src/math/Box2.js'
import { Box3 } from 'three/src/math/Box3.js'
import { Sphere } from 'three/src/math/Sphere.js'
import { Plane } from 'three/src/math/Plane.js'
import { Ray } from 'three/src/math/Ray.js'
import { Line3 } from 'three/src/math/Line3.js'
import { Triangle } from 'three/src/math/Triangle.js'
import { Frustum } from 'three/src/math/Frustum.js'
import { Color } from 'three/src/math/Color.js'
import { Spherical } from 'three/src/math/Spherical.js'
import { Cylindrical } from 'three/src/math/Cylindrical.js'
import { SphericalHarmonics3 } from 'three/src/math/SphericalHarmonics3.js'
import { LinearInterpolant } from 'three/src/math/interpolants/LinearInterpolant.js'
import { DiscreteInterpolant } from 'three/src/math/interpolants/DiscreteInterpolant.js'
import { CubicInterpolant } from 'three/src/math/interpolants/CubicInterpolant.js'
import { QuaternionLinearInterpolant } from 'three/src/math/interpolants/QuaternionLinearInterpolant.js'
import * as MathUtils from 'three/src/math/MathUtils.js'

const s2 = v => v.x + v.y * 3
const s3 = v => v.x + v.y * 3 + v.z * 7
const s4 = v => v.x + v.y * 3 + v.z * 7 + v.w * 11
const sm = (m, n) => { let s = 0; for (let i = 0; i < n; i++) s += m.elements[i] * (i + 1); return s }
const b = x => x ? 1 : 0
const V2 = (x, y) => new Vector2(x, y), V3 = (x, y, z) => new Vector3(x, y, z), V4 = (x, y, z, w) => new Vector4(x, y, z, w)
const M4 = () => new Matrix4().set(2, 0.5, -1, 3, 0.25, 1.5, 0.75, -2, -0.5, 1, 3, 0.5, 0, 0, 0, 1)
const M3 = () => new Matrix3().set(2, 0.5, -1, 0.25, 1.5, 0.75, -0.5, 1, 3)
const Q = () => new Quaternion(0.18257418583505536, 0.3651483716701107, 0.5477225575051661, 0.7302967433402214)

// ---- Vector2
export const v2_arith = () => { const a = V2(1.5, -2), c = V2(-4, 0.5)
  return s2(a.clone().add(c)) + s2(a.clone().addScalar(3)) * 2 + s2(V2().addVectors(a, c)) * 3 + s2(a.clone().addScaledVector(c, 0.25)) * 5
    + s2(a.clone().sub(c)) * 7 + s2(a.clone().subScalar(1)) * 11 + s2(V2().subVectors(a, c)) * 13 + s2(a.clone().multiply(c)) * 17
    + s2(a.clone().multiplyScalar(-2)) * 19 + s2(a.clone().divide(c)) * 23 + s2(a.clone().divideScalar(3)) * 29 + s2(a.clone().negate()) * 31 }
export const v2_bounds = () => { const a = V2(1.5, -2.25), lo = V2(-1, -1), hi = V2(1, 1)
  return s2(a.clone().min(hi)) + s2(a.clone().max(lo)) * 2 + s2(a.clone().clamp(lo, hi)) * 3 + s2(a.clone().clampScalar(-0.5, 0.5)) * 5
    + s2(a.clone().clampLength(0.5, 2)) * 7 + s2(a.clone().floor()) * 11 + s2(a.clone().ceil()) * 13 + s2(a.clone().round()) * 17 + s2(a.clone().roundToZero()) * 19 }
export const v2_products = () => { const a = V2(3, -4), c = V2(-1, 2)
  return a.dot(c) + a.cross(c) * 2 + a.lengthSq() * 3 + a.length() * 5 + a.manhattanLength() * 7 + s2(a.clone().normalize()) * 11 + a.distanceTo(c) * 13
    + a.distanceToSquared(c) * 17 + a.manhattanDistanceTo(c) * 19 + s2(a.clone().setLength(2)) * 23 + s2(a.clone().lerp(c, 0.25)) * 29
    + s2(V2().lerpVectors(a, c, 0.75)) * 31 + b(a.equals(V2(3, -4))) * 37 + b(a.equals(c)) * 41 }
export const v2_access = () => { const a = V2().set(1, 2).setX(5).setY(7).setComponent(0, 9), arr = a.toArray(), c = V2().fromArray([0, 0, 3, 4], 2)
  a.width = a.width + 1; a.height = a.height * 2
  return s2(a) + a.getComponent(1) * 3 + arr[0] * 5 + arr.length * 7 + s2(c) * 11 + s2(V2().setScalar(2.5)) * 13 + s2(V2().copy(a)) * 17 + [...a].length * 19 }
export const v2_angle_t = () => s2(V2(1, 2).rotateAround(V2(0.5, -0.5), 0.7)) + V2(1, 2).angle() * 3 + V2(1, 2).angleTo(V2(-3, 0.5)) * 5

// ---- Vector3
export const v3_arith = () => { const a = V3(1.5, -2, 3), c = V3(-4, 0.5, 0.25)
  return s3(a.clone().add(c)) + s3(a.clone().addScalar(3)) * 2 + s3(V3().addVectors(a, c)) * 3 + s3(a.clone().addScaledVector(c, 0.25)) * 5
    + s3(a.clone().sub(c)) * 7 + s3(a.clone().subScalar(1)) * 11 + s3(V3().subVectors(a, c)) * 13 + s3(a.clone().multiply(c)) * 17
    + s3(a.clone().multiplyScalar(-2)) * 19 + s3(V3().multiplyVectors(a, c)) * 23 + s3(a.clone().divide(c)) * 29 + s3(a.clone().divideScalar(3)) * 31 + s3(a.clone().negate()) * 37 }
export const v3_bounds = () => { const a = V3(1.5, -2.25, 0.75), lo = V3(-1, -1, -1), hi = V3(1, 1, 1)
  return s3(a.clone().min(hi)) + s3(a.clone().max(lo)) * 2 + s3(a.clone().clamp(lo, hi)) * 3 + s3(a.clone().clampScalar(-0.5, 0.5)) * 5
    + s3(a.clone().clampLength(0.5, 2)) * 7 + s3(a.clone().floor()) * 11 + s3(a.clone().ceil()) * 13 + s3(a.clone().round()) * 17 + s3(a.clone().roundToZero()) * 19 }
export const v3_products = () => { const a = V3(3, -4, 12), c = V3(-1, 2, 0.5)
  return a.dot(c) + s3(a.clone().cross(c)) * 2 + s3(V3().crossVectors(a, c)) * 3 + a.lengthSq() * 5 + a.length() * 7 + a.manhattanLength() * 11
    + s3(a.clone().normalize()) * 13 + a.distanceTo(c) * 17 + a.distanceToSquared(c) * 19 + a.manhattanDistanceTo(c) * 23 + s3(a.clone().setLength(2)) * 29
    + s3(a.clone().lerp(c, 0.25)) * 31 + s3(V3().lerpVectors(a, c, 0.75)) * 37 + s3(a.clone().projectOnVector(c)) * 41 + s3(a.clone().projectOnPlane(c.clone().normalize())) * 43
    + s3(a.clone().reflect(c.clone().normalize())) * 47 + b(a.equals(V3(3, -4, 12))) * 53 + b(a.equals(c)) * 59 }
export const v3_matrix = () => { const a = V3(1.5, -2, 3), m = M4()
  return s3(a.clone().applyMatrix3(M3())) + s3(a.clone().applyMatrix4(m)) * 2 + s3(a.clone().applyQuaternion(Q())) * 3 + s3(a.clone().applyNormalMatrix(M3())) * 5
    + s3(a.clone().transformDirection(m)) * 7 + s3(V3().setFromMatrixPosition(m)) * 11 + s3(V3().setFromMatrixScale(m)) * 13 + s3(V3().setFromMatrixColumn(m, 2)) * 17
    + s3(V3().setFromMatrix3Column(M3(), 1)) * 19 + s3(V3().setFromEuler(new Euler(0.1, 0.2, 0.3))) * 23 + s3(V3().setFromColor(new Color(0.25, 0.5, 0.75))) * 29 }
export const v3_access = () => { const a = V3().set(1, 2, 3).setX(5).setY(7).setZ(9).setComponent(2, 11), arr = a.toArray([0, 0, 0, 0], 1), c = V3().fromArray(new Float32Array([0, 1.5, 2.5, 3.5]), 1)
  return s3(a) + a.getComponent(1) * 3 + arr[3] * 5 + arr.length * 7 + s3(c) * 11 + s3(V3().setScalar(2.5)) * 13 + s3(V3().copy(a)) * 17 + [...a].length * 19 + b(a.isVector3) * 23 + b(c.isVector2) * 29 }
export const v3_angle_t = () => s3(V3(1, 2, 3).applyEuler(new Euler(0.1, 0.2, 0.3, 'ZYX'))) + s3(V3(1, 2, 3).applyAxisAngle(V3(0, 1, 0), 0.7)) * 3 + V3(1, 2, 3).angleTo(V3(-3, 0.5, 1)) * 5
  + s3(V3().setFromSphericalCoords(2, 0.4, 0.9)) * 7 + s3(V3().setFromCylindricalCoords(2, 0.4, 0.9)) * 11 + s3(V3().setFromSpherical(new Spherical(1.5, 0.3, 0.2))) * 13
  + s3(V3().setFromCylindrical(new Cylindrical(1.5, 0.3, 0.2))) * 17

// ---- Vector4
export const v4_arith = () => { const a = V4(1.5, -2, 3, 0.5), c = V4(-4, 0.5, 0.25, 2)
  return s4(a.clone().add(c)) + s4(a.clone().addScalar(3)) * 2 + s4(V4().addVectors(a, c)) * 3 + s4(a.clone().addScaledVector(c, 0.25)) * 5 + s4(a.clone().sub(c)) * 7
    + s4(a.clone().subScalar(1)) * 11 + s4(V4().subVectors(a, c)) * 13 + s4(a.clone().multiply(c)) * 17 + s4(a.clone().multiplyScalar(-2)) * 19 + s4(a.clone().divide(c)) * 23
    + s4(a.clone().divideScalar(3)) * 29 + s4(a.clone().negate()) * 31 + s4(a.clone().applyMatrix4(M4())) * 37 }
export const v4_bounds = () => { const a = V4(1.5, -2.25, 0.75, -0.125), lo = V4(-1, -1, -1, -1), hi = V4(1, 1, 1, 1)
  return s4(a.clone().min(hi)) + s4(a.clone().max(lo)) * 2 + s4(a.clone().clamp(lo, hi)) * 3 + s4(a.clone().clampScalar(-0.5, 0.5)) * 5 + s4(a.clone().clampLength(0.5, 2)) * 7
    + s4(a.clone().floor()) * 11 + s4(a.clone().ceil()) * 13 + s4(a.clone().round()) * 17 + s4(a.clone().roundToZero()) * 19 }
export const v4_products = () => { const a = V4(3, -4, 12, 1), c = V4(-1, 2, 0.5, 4)
  return a.dot(c) + a.lengthSq() * 3 + a.length() * 5 + a.manhattanLength() * 7 + s4(a.clone().normalize()) * 11 + s4(a.clone().setLength(2)) * 13 + s4(a.clone().lerp(c, 0.25)) * 17
    + s4(V4().lerpVectors(a, c, 0.75)) * 19 + b(a.equals(V4(3, -4, 12, 1))) * 23 + s4(V4().setFromMatrixPosition(M4())) * 29 + s4(V4().fromArray([1, 2, 3, 4, 5], 1)) * 31
    + a.toArray()[3] * 37 + a.getComponent(2) * 41 + s4(V4().set(1, 2, 3, 4).setW(9).setComponent(0, 7)) * 43 }
export const v4_angle_t = () => s4(V4().setAxisAngleFromQuaternion(Q())) + s4(V4().setAxisAngleFromRotationMatrix(new Matrix4().makeRotationFromQuaternion(Q()))) * 3

// ---- Quaternion
export const quat_algebra = () => { const a = Q(), c = new Quaternion(-0.5, 0.5, 0.5, 0.5)
  return s4(a.clone().multiply(c)) + s4(a.clone().premultiply(c)) * 2 + s4(new Quaternion().multiplyQuaternions(a, c)) * 3 + s4(a.clone().invert()) * 5 + s4(a.clone().conjugate()) * 7
    + a.dot(c) * 11 + a.lengthSq() * 13 + a.length() * 17 + s4(new Quaternion(1, 2, 3, 4).normalize()) * 19 + s4(new Quaternion().identity()) * 23 + b(a.equals(Q())) * 29
    + s4(new Quaternion().fromArray([0, 0.5, 0.5, 0.5, 0.5], 1)) * 31 + a.toArray([0, 0, 0, 0, 0], 1)[4] * 37 + s4(new Quaternion().copy(a)) * 41 + s4(new Quaternion().set(1, 2, 3, 4)) * 43
    + s4(new Quaternion().setFromRotationMatrix(M4())) * 47 + s4(new Quaternion().setFromUnitVectors(V3(1, 0, 0), V3(0, 0.6, 0.8))) * 53 }
export const quat_flat = () => { const dst = [0, 0, 0, 0, 0], a = [0, 0.5, 0.5, 0.5, 0.5], c = [0.18257418583505536, 0.3651483716701107, 0.5477225575051661, 0.7302967433402214]
  Quaternion.multiplyQuaternionsFlat(dst, 1, a, 1, c, 0)
  return dst[1] + dst[2] * 3 + dst[3] * 7 + dst[4] * 11 }
export const quat_observed = () => { const q = new Quaternion(); let n = 0
  q._onChange(() => { n++ })
  q.x = 1; q.y = 2; q.set(1, 2, 3, 4); q.normalize(); q.copy(Q()); q.identity()
  return n * 100 + s4(q) }
export const quat_angle_t = () => { const a = Q(), c = new Quaternion(-0.5, 0.5, 0.5, 0.5), dst = [0, 0, 0, 0]
  Quaternion.slerpFlat(dst, 0, a.toArray(), 0, c.toArray(), 0, 0.3)
  return s4(new Quaternion().setFromEuler(new Euler(0.1, 0.2, 0.3, 'YXZ'))) + s4(new Quaternion().setFromAxisAngle(V3(0, 0.6, 0.8), 1.1)) * 3 + a.angleTo(c) * 5
    + s4(a.clone().rotateTowards(c, 0.2)) * 7 + s4(a.clone().slerp(c, 0.3)) * 11 + s4(new Quaternion().slerpQuaternions(a, c, 0.6)) * 13 + (dst[0] + dst[1] * 3 + dst[2] * 7 + dst[3] * 11) * 17 }

// ---- Euler
export const euler_access = () => { const e = new Euler(0.1, 0.2, 0.3), a = e.toArray(), f = new Euler().fromArray([0.5, 0.25, 0.125, 'ZXY'])
  e.x = 1; e.y = e.y + 1; e.order = 'YZX'
  return e.x + e.y * 3 + e.z * 7 + e.order + a.length + a[3] + f.x + f.order + b(e.equals(f)) + b(new Euler().copy(f).equals(f)) + new Euler().set(1, 2, 3).order + new Euler().set(1, 2, 3, 'XZY').order + e.clone().order }
export const euler_angle_t = () => { let s = 0, k = 1
  for (const order of ['XYZ', 'YXZ', 'ZXY', 'ZYX', 'YZX', 'XZY']) {
    const e = new Euler().setFromQuaternion(Q(), order), f = new Euler().setFromRotationMatrix(M4(), order), g = new Euler(0.1, 0.2, 0.3, order).reorder('ZYX')
    s += (e.x + e.y * 3 + e.z * 7 + f.x * 11 + f.y * 13 + f.z * 17 + g.x * 19 + g.y * 23 + g.z * 29) * k; k += 2 }
  return s }

// ---- Matrix2 / Matrix3
export const m2_all = () => sm(new Matrix2(1, 2, 3, 4), 4) + sm(new Matrix2().identity(), 4) * 3 + sm(new Matrix2().fromArray([0, 5, 6, 7, 8], 1), 4) * 7 + sm(new Matrix2().set(9, 8, 7, 6), 4) * 11 + b(new Matrix2().isMatrix2) * 13
export const m3_algebra = () => { const a = M3(), c = new Matrix3().set(1, 2, 3, 0, 1, 4, 5, 6, 0), x = V3(), y = V3(), z = V3(), arr = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  a.extractBasis(x, y, z); a.transposeIntoArray(arr)
  return sm(a.clone().multiply(c), 9) + sm(a.clone().premultiply(c), 9) * 2 + sm(new Matrix3().multiplyMatrices(a, c), 9) * 3 + sm(a.clone().multiplyScalar(0.5), 9) * 5 + a.determinant() * 7
    + sm(a.clone().invert(), 9) * 11 + sm(a.clone().transpose(), 9) * 13 + sm(new Matrix3().getNormalMatrix(M4()), 9) * 17 + (s3(x) + s3(y) * 2 + s3(z) * 3) * 19 + arr[3] * 23
    + sm(new Matrix3().setFromMatrix4(M4()), 9) * 29 + sm(new Matrix3().identity(), 9) * 31 + sm(new Matrix3().copy(c), 9) * 37 + b(a.equals(M3())) * 41 + sm(new Matrix3().fromArray(c.toArray()), 9) * 43
    + sm(a.clone().scale(2, 3), 9) * 47 + sm(a.clone().translate(2, 3), 9) * 53 + sm(new Matrix3().makeTranslation(2, 3), 9) * 59 + sm(new Matrix3().makeTranslation(V2(4, 5)), 9) * 61
    + sm(new Matrix3().makeScale(2, 3), 9) * 67 + sm(new Matrix3(1, 2, 3, 4, 5, 6, 7, 8, 9), 9) * 71 }
export const m3_angle_t = () => sm(M3().rotate(0.4), 9) + sm(new Matrix3().makeRotation(0.4), 9) * 3 + sm(new Matrix3().setUvTransform(0.1, 0.2, 2, 3, 0.4, 0.5, 0.5), 9) * 7

// ---- Matrix4
export const m4_algebra = () => { const a = M4(), c = new Matrix4().set(1, 2, 3, 4, 0, 1, 4, 2, 5, 6, 0, 1, 0, 0, 0, 1), x = V3(), y = V3(), z = V3()
  a.extractBasis(x, y, z)
  return sm(a.clone().multiply(c), 16) + sm(a.clone().premultiply(c), 16) * 2 + sm(new Matrix4().multiplyMatrices(a, c), 16) * 3 + sm(a.clone().multiplyScalar(0.5), 16) * 5 + a.determinant() * 7
    + sm(a.clone().invert(), 16) * 11 + sm(a.clone().transpose(), 16) * 13 + (s3(x) + s3(y) * 2 + s3(z) * 3) * 17 + sm(new Matrix4().makeBasis(x, y, z), 16) * 19 + sm(new Matrix4().extractRotation(a), 16) * 23
    + sm(new Matrix4().copyPosition(a), 16) * 29 + sm(a.clone().setPosition(V3(1, 2, 3)), 16) * 31 + sm(a.clone().setPosition(4, 5, 6), 16) * 37 + sm(a.clone().scale(V3(2, 3, 4)), 16) * 41
    + a.getMaxScaleOnAxis() * 43 + sm(new Matrix4().copy(c), 16) * 47 + b(a.equals(M4())) * 53 + sm(new Matrix4().fromArray(c.toArray()), 16) * 59 + sm(new Matrix4().identity(), 16) * 61 + sm(a.clone(), 16) * 67
    + sm(new Matrix4().setFromMatrix3(M3()), 16) * 71 }
export const m4_make = () => { const p = V3(), q = new Quaternion(), s = V3()
  new Matrix4().compose(V3(1, 2, 3), Q(), V3(2, 3, 4)).decompose(p, q, s)
  return sm(new Matrix4().makeTranslation(1, 2, 3), 16) + sm(new Matrix4().makeTranslation(V3(4, 5, 6)), 16) * 2 + sm(new Matrix4().makeScale(2, 3, 4), 16) * 3 + sm(new Matrix4().makeShear(1, 2, 3, 4, 5, 6), 16) * 5
    + sm(new Matrix4().compose(V3(1, 2, 3), Q(), V3(2, 3, 4)), 16) * 7 + (s3(p) + s4(q) * 2 + s3(s) * 3) * 11 + sm(new Matrix4().makePerspective(-1, 1, 1, -1, 1, 100), 16) * 13
    + sm(new Matrix4().makeOrthographic(-1, 1, 1, -1, 1, 100), 16) * 17 + sm(new Matrix4().lookAt(V3(3, 10, 50), V3(0, 0, 0), V3(0, 1, 0)), 16) * 19 + sm(new Matrix4().makeRotationFromQuaternion(Q()), 16) * 23 }
export const m4_angle_t = () => sm(new Matrix4().makeRotationX(0.4), 16) + sm(new Matrix4().makeRotationY(0.4), 16) * 3 + sm(new Matrix4().makeRotationZ(0.4), 16) * 5 + sm(new Matrix4().makeRotationAxis(V3(0, 0.6, 0.8), 0.4), 16) * 7
  + sm(new Matrix4().makeRotationFromEuler(new Euler(0.1, 0.2, 0.3, 'ZXY')), 16) * 11

// ---- Box2 / Box3
export const box2_all = () => { const a = new Box2(V2(-1, -2), V2(3, 4)), c = new Box2().setFromPoints([V2(0, 0), V2(5, 1), V2(-2, 3)]), t = V2()
  return s2(a.getCenter(t)) + s2(a.getSize(t)) * 2 + s2(c.min) * 3 + s2(c.max) * 5 + b(a.isEmpty()) * 7 + b(new Box2().isEmpty()) * 11 + b(a.containsPoint(V2(1, 1))) * 13 + b(a.containsBox(c)) * 17
    + b(a.intersectsBox(c)) * 19 + s2(a.getParameter(V2(1, 1), t)) * 23 + s2(a.clampPoint(V2(9, -9), t)) * 29 + a.distanceToPoint(V2(9, -9)) * 31 + s2(a.clone().intersect(c).max) * 37
    + s2(a.clone().union(c).min) * 41 + s2(a.clone().translate(V2(1, 1)).min) * 43 + s2(a.clone().expandByPoint(V2(9, 9)).max) * 47 + s2(a.clone().expandByVector(V2(1, 2)).max) * 53
    + s2(a.clone().expandByScalar(2).min) * 59 + s2(new Box2().setFromCenterAndSize(V2(1, 1), V2(4, 6)).max) * 61 + b(a.equals(new Box2().copy(a))) * 67 + b(a.clone().makeEmpty().isEmpty()) * 71 }
export const box3_all = () => { const a = new Box3(V3(-1, -2, -3), V3(3, 4, 5)), c = new Box3().setFromPoints([V3(0, 0, 0), V3(5, 1, -1), V3(-2, 3, 2)]), t = V3(), sph = new Sphere()
  return s3(a.getCenter(t)) + s3(a.getSize(t)) * 2 + s3(c.min) * 3 + s3(c.max) * 5 + b(a.isEmpty()) * 7 + b(new Box3().isEmpty()) * 11 + b(a.containsPoint(V3(1, 1, 1))) * 13 + b(a.containsBox(c)) * 17
    + b(a.intersectsBox(c)) * 19 + s3(a.getParameter(V3(1, 1, 1), t)) * 23 + s3(a.clampPoint(V3(9, -9, 0), t)) * 29 + a.distanceToPoint(V3(9, -9, 0)) * 31 + s3(a.clone().intersect(c).max) * 37
    + s3(a.clone().union(c).min) * 41 + s3(a.clone().translate(V3(1, 1, 1)).min) * 43 + s3(a.clone().expandByPoint(V3(9, 9, 9)).max) * 47 + s3(a.clone().expandByVector(V3(1, 2, 3)).max) * 53
    + s3(a.clone().expandByScalar(2).min) * 59 + s3(new Box3().setFromCenterAndSize(V3(1, 1, 1), V3(4, 6, 8)).max) * 61 + b(a.equals(new Box3().copy(a))) * 67 + b(a.clone().makeEmpty().isEmpty()) * 71
    + b(a.intersectsSphere(new Sphere(V3(5, 5, 5), 2))) * 73 + b(a.intersectsSphere(new Sphere(V3(5, 5, 5), 1))) * 79 + b(a.intersectsPlane(new Plane(V3(0, 1, 0), -1))) * 83 + b(a.intersectsPlane(new Plane(V3(0, 1, 0), -9))) * 89
    + b(a.intersectsTriangle(new Triangle(V3(0, 0, 0), V3(9, 0, 0), V3(0, 9, 0)))) * 97 + b(a.intersectsTriangle(new Triangle(V3(9, 9, 9), V3(19, 9, 9), V3(9, 19, 9)))) * 101
    + (s3(a.getBoundingSphere(sph).center) + sph.radius) * 103 + s3(new Box3().setFromArray([1, 2, 3, -4, 5, 6, 7, -8, 9]).min) * 107 + s3(a.clone().applyMatrix4(M4()).max) * 109 + s3(new Box3().set(V3(1, 2, 3), V3(4, 5, 6)).max) * 113 }

// ---- Sphere / Plane / Ray / Line3 / Triangle / Frustum
export const sphere_all = () => { const a = new Sphere(V3(1, 2, 3), 4), t = V3(), bx = new Box3()
  return b(a.isEmpty()) + b(new Sphere().isEmpty()) * 2 + b(a.containsPoint(V3(2, 3, 4))) * 3 + a.distanceToPoint(V3(9, 9, 9)) * 5 + b(a.intersectsSphere(new Sphere(V3(8, 2, 3), 3))) * 7
    + b(a.intersectsBox(new Box3(V3(4, 4, 4), V3(9, 9, 9)))) * 11 + b(a.intersectsPlane(new Plane(V3(0, 1, 0), -5))) * 13 + s3(a.clampPoint(V3(9, 9, 9), t)) * 17 + s3(a.getBoundingBox(bx).max) * 19
    + (s3(a.clone().applyMatrix4(M4()).center) + a.clone().applyMatrix4(M4()).radius) * 23 + s3(a.clone().translate(V3(1, 1, 1)).center) * 29 + a.clone().expandByPoint(V3(9, 9, 9)).radius * 31
    + a.clone().union(new Sphere(V3(-5, 0, 0), 2)).radius * 37 + b(a.equals(new Sphere().copy(a))) * 41 + new Sphere().setFromPoints([V3(0, 0, 0), V3(5, 1, -1), V3(-2, 3, 2)]).radius * 43
    + new Sphere().setFromPoints([V3(0, 0, 0), V3(5, 1, -1)], V3(1, 1, 1)).radius * 47 + new Sphere().set(V3(1, 1, 1), 3).radius * 53 + b(a.clone().makeEmpty().isEmpty()) * 59 }
export const plane_all = () => { const p = new Plane(V3(0, 0.6, 0.8), -2), t = V3(), line = new Line3(V3(0, -5, -5), V3(0, 5, 5)), sp = (q) => s3(q.normal) + q.constant * 11
  return sp(new Plane().set(V3(1, 0, 0), 3)) + sp(new Plane().setComponents(1, 2, 3, 4)) * 2 + sp(new Plane().setFromNormalAndCoplanarPoint(V3(0, 1, 0), V3(1, 2, 3))) * 3
    + sp(new Plane().setFromCoplanarPoints(V3(0, 0, 0), V3(1, 0, 0), V3(0, 1, 1))) * 5 + sp(new Plane().setComponents(1, 2, 3, 4).normalize()) * 7 + sp(p.clone().negate()) * 11 + p.distanceToPoint(V3(1, 2, 3)) * 13
    + p.distanceToSphere(new Sphere(V3(1, 2, 3), 1)) * 17 + s3(p.projectPoint(V3(1, 2, 3), t)) * 19 + s3(p.intersectLine(line, t)) * 23 + b(p.intersectsLine(line)) * 29
    + b(p.intersectsBox(new Box3(V3(-1, -1, -1), V3(3, 4, 5)))) * 31 + b(p.intersectsSphere(new Sphere(V3(0, 0, 0), 1))) * 37 + s3(p.coplanarPoint(t)) * 41 + sp(p.clone().applyMatrix4(M4())) * 43
    + sp(p.clone().translate(V3(1, 1, 1))) * 47 + b(p.equals(new Plane().copy(p))) * 53 }
export const ray_all = () => { const r = new Ray(V3(0, 0, -10), V3(0, 0.6, 0.8)), t = V3(), a = V3(), c = V3(), sr = (q) => s3(q.origin) + s3(q.direction) * 13
  const seg = r.distanceSqToSegment(V3(-3, 1, 0), V3(3, 2, 1), a, c), hit = r.intersectTriangle(V3(-5, -5, 0), V3(5, -5, 0), V3(0, 9, 0), false, t)
  return s3(r.at(2.5, t)) + sr(r.clone().lookAt(V3(1, 2, 3))) * 2 + sr(r.clone().recast(2)) * 3 + s3(r.closestPointToPoint(V3(1, 2, 3), t)) * 5 + r.distanceToPoint(V3(1, 2, 3)) * 7 + r.distanceSqToPoint(V3(1, 2, 3)) * 11
    + (seg + s3(a) + s3(c)) * 13 + b(r.intersectsSphere(new Sphere(V3(0, 6, -2), 2))) * 17 + s3(r.intersectSphere(new Sphere(V3(0, 6, -2), 2), t) ?? V3(-1, -1, -1)) * 19
    + r.distanceToPlane(new Plane(V3(0, 0, 1), -3)) * 23 + s3(r.intersectPlane(new Plane(V3(0, 0, 1), -3), t)) * 29 + b(r.intersectsPlane(new Plane(V3(0, 0, 1), -3))) * 31
    + b(r.intersectsBox(new Box3(V3(-1, 5, -3), V3(1, 8, 0)))) * 37 + s3(r.intersectBox(new Box3(V3(-1, 5, -3), V3(1, 8, 0)), t) ?? V3(-1, -1, -1)) * 41 + b(hit !== null) * 43 + s3(t) * 47
    + b(r.intersectTriangle(V3(-5, -5, 0), V3(0, 9, 0), V3(5, -5, 0), true, t) === null) * 53 + sr(r.clone().applyMatrix4(M4())) * 59 + b(r.equals(new Ray().copy(r))) * 61 + sr(new Ray().set(V3(1, 2, 3), V3(0, 1, 0))) * 67 }
export const line3_all = () => { const l = new Line3(V3(0, -5, -5), V3(3, 5, 5)), t = V3()
  return s3(l.getCenter(t)) + s3(l.delta(t)) * 2 + l.distanceSq() * 3 + l.distance() * 5 + s3(l.at(0.25, t)) * 7 + l.closestPointToPointParameter(V3(1, 2, 3), true) * 11 + l.closestPointToPointParameter(V3(9, 9, 99), false) * 13
    + s3(l.closestPointToPoint(V3(1, 2, 3), true, t)) * 17 + s3(l.clone().applyMatrix4(M4()).end) * 19 + b(l.equals(new Line3().copy(l))) * 23 + s3(new Line3().set(V3(1, 2, 3), V3(4, 5, 6)).end) * 29 }
export const triangle_all = () => { const a = V3(-5, -5, 0), c = V3(5, -5, 1), d = V3(0, 9, 2), tri = new Triangle(a, c, d), t = V3(), pl = new Plane(), p = V3(1, 1, 0.5)
  const uv = V2(); tri.getInterpolation(p, V2(0, 0), V2(1, 0), V2(0.5, 1), uv)
  return s3(Triangle.getNormal(a, c, d, t)) + s3(Triangle.getBarycoord(p, a, c, d, t) ?? V3()) * 2 + b(Triangle.containsPoint(p, a, c, d)) * 3 + b(Triangle.isFrontFacing(a, c, d, V3(0, 0, -1))) * 5 + tri.getArea() * 7
    + s3(tri.getMidpoint(t)) * 11 + s3(tri.getNormal(t)) * 13 + (s3(tri.getPlane(pl).normal) + pl.constant) * 17 + s3(tri.getBarycoord(p, t) ?? V3()) * 19 + s2(uv) * 23 + b(tri.containsPoint(p)) * 29
    + b(tri.isFrontFacing(V3(0, 0, 1))) * 31 + b(tri.intersectsBox(new Box3(V3(-1, -1, -1), V3(1, 1, 1)))) * 37 + s3(tri.closestPointToPoint(V3(9, 9, 9), t)) * 41 + s3(tri.closestPointToPoint(V3(0, 0, 5), t)) * 43
    + b(tri.equals(new Triangle().copy(tri))) * 47 + s3(new Triangle().setFromPointsAndIndices([a, c, d, p], 1, 2, 3).a) * 53 + s3(tri.clone().set(d, a, c).b) * 59 }
export const frustum_all = () => { const f = new Frustum().setFromProjectionMatrix(new Matrix4().makePerspective(-1, 1, 1, -1, 1, 100)); let s = 0
  for (let i = 0; i < 6; i++) s += (s3(f.planes[i].normal) + f.planes[i].constant * 5) * (i + 1)
  return s + b(f.intersectsSphere(new Sphere(V3(0, 0, -50), 1))) * 3 + b(f.intersectsSphere(new Sphere(V3(0, 0, 500), 1))) * 5 + b(f.containsPoint(V3(0, 0, -50))) * 7 + b(f.containsPoint(V3(0, 0, 500))) * 11
    + b(f.intersectsBox(new Box3(V3(-1, -1, -60), V3(1, 1, -50)))) * 13 + b(f.intersectsBox(new Box3(V3(900, 900, 900), V3(901, 901, 901)))) * 17 + b(new Frustum().copy(f).clone().containsPoint(V3(0, 0, -2))) * 19 }

// ---- Color
export const color_linear = () => { const a = new Color(0.25, 0.5, 0.75), c = new Color(0.5, 0.125, 1), sc = (q) => q.r + q.g * 3 + q.b * 7
  return sc(a.clone().add(c)) + sc(new Color().addColors(a, c)) * 2 + sc(a.clone().addScalar(0.125)) * 3 + sc(a.clone().sub(c)) * 5 + sc(a.clone().multiply(c)) * 7 + sc(a.clone().multiplyScalar(0.5)) * 11
    + sc(a.clone().lerp(c, 0.25)) * 13 + sc(new Color().lerpColors(a, c, 0.75)) * 17 + b(a.equals(new Color().copy(a))) * 19 + sc(new Color().fromArray([0, 0.5, 0.25, 0.125], 1)) * 23 + a.toArray([0, 0, 0, 0], 1)[3] * 29
    + sc(new Color().setScalar(0.5)) * 31 + sc(new Color().setRGB(0.1, 0.2, 0.3, 'srgb-linear')) * 37 + sc(new Color().set(a)) * 41 + sc(new Color().setFromVector3(V3(0.1, 0.2, 0.3))) * 43 + sc(a.clone().applyMatrix3(M3())) * 47 + b(a.isColor) * 53 }
export const color_text_t = () => { const sc = (q) => q.r + q.g * 3 + q.b * 7, hsl = { h: 0, s: 0, l: 0 }, rgb = new Color()
  new Color(0.25, 0.5, 0.75).getHSL(hsl); new Color(0.25, 0.5, 0.75).getRGB(rgb)
  return sc(new Color(0xff8040)) + sc(new Color('#1a2b3c')) * 2 + sc(new Color('rgb(10, 20, 30)')) * 3 + sc(new Color('hsl(120, 50%, 25%)')) * 5 + sc(new Color('skyblue')) * 7 + sc(new Color().setHex(0x336699)) * 11
    + sc(new Color().setHSL(0.6, 0.5, 0.4)) * 13 + sc(new Color().setStyle('#abc')) * 17 + sc(new Color().setColorName('tomato')) * 19 + new Color(0.25, 0.5, 0.75).getHex() * 23 + (hsl.h + hsl.s * 3 + hsl.l * 7) * 29
    + sc(rgb) * 31 + sc(new Color(0.25, 0.5, 0.75).offsetHSL(0.1, 0.05, -0.05)) * 37 + sc(new Color(0.25, 0.5, 0.75).lerpHSL(new Color(0.5, 0.125, 1), 0.4)) * 41 + sc(new Color(0.25, 0.5, 0.75).convertSRGBToLinear()) * 43
    + sc(new Color(0.25, 0.5, 0.75).convertLinearToSRGB()) * 47 + sc(new Color().copySRGBToLinear(new Color(0.25, 0.5, 0.75))) * 53 + sc(new Color().copyLinearToSRGB(new Color(0.25, 0.5, 0.75))) * 59 }
export const color_strings_t = () => new Color(0.25, 0.5, 0.75).getHexString() + ' ' + new Color('#1a2b3c').getStyle() + ' ' + new Color(0xff8040).getHexString()

// ---- Spherical / Cylindrical / SphericalHarmonics3
export const spherical_t = () => { const ss = (q) => q.radius + q.phi * 3 + q.theta * 7, sc = (q) => q.radius + q.theta * 3 + q.y * 7
  return ss(new Spherical(2, 0.4, 0.9)) + ss(new Spherical().set(1, 0, 0).makeSafe()) * 2 + ss(new Spherical().setFromVector3(V3(1, 2, 3))) * 3 + ss(new Spherical().setFromCartesianCoords(-1, 0.5, 2)) * 5
    + ss(new Spherical().copy(new Spherical(2, 0.4, 0.9)).clone()) * 7 + sc(new Cylindrical(2, 0.4, 0.9)) * 11 + sc(new Cylindrical().setFromVector3(V3(1, 2, 3))) * 13 + sc(new Cylindrical().setFromCartesianCoords(-1, 0.5, 2)) * 17
    + sc(new Cylindrical().set(1, 2, 3).clone()) * 19 }
export const sh3_all = () => { const a = new SphericalHarmonics3(), c = new SphericalHarmonics3(), t = V3(), basis = [0, 0, 0, 0, 0, 0, 0, 0, 0], arr = []
  for (let i = 0; i < 9; i++) { a.coefficients[i].set(i, i * 0.5, -i); c.coefficients[i].set(1, i, 0.25) }
  SphericalHarmonics3.getBasisAt(V3(0, 0.6, 0.8), basis); a.toArray(arr)
  let s = 0; for (let i = 0; i < 9; i++) s += basis[i] * (i + 1)
  return s3(a.getAt(V3(0, 0.6, 0.8), t)) + s3(a.getIrradianceAt(V3(0, 0.6, 0.8), t)) * 2 + s3(a.clone().add(c).coefficients[4]) * 3 + s3(a.clone().addScaledSH(c, 0.5).coefficients[5]) * 5 + s3(a.clone().scale(2).coefficients[6]) * 7
    + s3(a.clone().lerp(c, 0.25).coefficients[7]) * 11 + b(a.equals(new SphericalHarmonics3().copy(a))) * 13 + s * 17 + arr.length * 19 + arr[26] * 23 + s3(new SphericalHarmonics3().fromArray(arr).coefficients[8]) * 29
    + s3(a.clone().zero().coefficients[3]) * 31 + s3(new SphericalHarmonics3().set(c.coefficients).coefficients[2]) * 37 }

// ---- MathUtils
export const mathutils_exact = () => MathUtils.clamp(5, -1, 3) + MathUtils.clamp(-5, -1, 3) * 2 + MathUtils.euclideanModulo(-7, 3) * 3 + MathUtils.mapLinear(0.25, 0, 1, 10, 20) * 5 + MathUtils.inverseLerp(10, 20, 12.5) * 7
  + MathUtils.lerp(10, 20, 0.3) * 11 + MathUtils.pingpong(7.5, 2) * 13 + MathUtils.smoothstep(0.3, 0, 1) * 17 + MathUtils.smootherstep(0.3, 0, 1) * 19 + MathUtils.degToRad(90) * 23 + MathUtils.radToDeg(1) * 29
  + b(MathUtils.isPowerOfTwo(64)) * 31 + b(MathUtils.isPowerOfTwo(65)) * 37 + MathUtils.seededRandom(7) * 41 + MathUtils.seededRandom() * 43
  + MathUtils.denormalize(100, new Uint8Array(1)) * 47 + MathUtils.denormalize(-100, new Int16Array(1)) * 53 + MathUtils.denormalize(0.5, new Float32Array(1)) * 59
  + MathUtils.normalize(0.5, new Uint16Array(1)) * 61 + MathUtils.normalize(-0.5, new Int8Array(1)) * 67 + MathUtils.normalize(0.5, new Float32Array(1)) * 71
export const mathutils_t = () => { const q = new Quaternion(); MathUtils.setQuaternionFromProperEuler(q, 0.1, 0.2, 0.3, 'ZYZ')
  return MathUtils.damp(1, 5, 2, 0.016) + MathUtils.ceilPowerOfTwo(100) * 3 + MathUtils.floorPowerOfTwo(100) * 5 + s4(q) * 7 }
export const mathutils_uuid = () => { const u = MathUtils.generateUUID(); return u.length * 100 + u.split('-').length * 10 + b(u === u.toLowerCase()) }

// ---- Interpolants
export const interpolants = () => { const times = new Float32Array([0, 1, 2, 4]), vals = new Float32Array([0, 10, 1, 20, 4, 40, 9, 80]), sum = (r) => r[0] + r[1] * 3
  const lin = new LinearInterpolant(times, vals, 2), dis = new DiscreteInterpolant(times, vals, 2), cub = new CubicInterpolant(times, vals, 2), out = new Float64Array(2), own = new LinearInterpolant(times, vals, 2, out)
  let s = 0, k = 1
  for (const t of [0.5, 1.5, 3, 0, 4, -1, 9, 2.25]) { s += (sum(lin.evaluate(t)) + sum(dis.evaluate(t)) * 3 + sum(cub.evaluate(t)) * 7) * k; k += 2 }
  own.evaluate(3)
  return s + sum(out) * 101 + b(lin.resultBuffer instanceof Float32Array) * 103 + lin.resultBuffer.length * 107 }
export const interpolants_t = () => { const times = new Float32Array([0, 1, 2]), a = Q().toArray(), c = new Quaternion(-0.5, 0.5, 0.5, 0.5).toArray(), vals = new Float32Array([...a, ...c, ...a])
  const q = new QuaternionLinearInterpolant(times, vals, 4); let s = 0, k = 1
  for (const t of [0.25, 0.5, 1.75]) { const r = q.evaluate(t); s += (r[0] + r[1] * 3 + r[2] * 7 + r[3] * 11) * k; k += 2 }
  return s }

// ---- Object3D's wiring: rotation and quaternion keep each other in step through `_onChange`
export const object3d_sync_t = () => { const rotation = new Euler(), quaternion = new Quaternion()
  function onRotationChange() { quaternion.setFromEuler(rotation, false) }
  function onQuaternionChange() { rotation.setFromQuaternion(quaternion, undefined, false) }
  rotation._onChange(onRotationChange); quaternion._onChange(onQuaternionChange)
  rotation.x = 1; const a = s4(quaternion)
  quaternion.set(0, 0.6, 0, 0.8); const c = rotation.x + rotation.y * 3 + rotation.z * 7
  rotation.set(0.1, 0.2, 0.3, 'ZYX')
  return a + c * 5 + s4(quaternion) * 7 }
