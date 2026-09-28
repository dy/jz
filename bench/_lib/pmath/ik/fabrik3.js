import { mat3, quat, vec3 } from '../core/index.js';
export var JointType = /*#__PURE__*/ function(JointType) {
    JointType[JointType["BALL"] = 0] = "BALL";
    JointType[JointType["GLOBAL_HINGE"] = 1] = "GLOBAL_HINGE";
    JointType[JointType["LOCAL_HINGE"] = 2] = "LOCAL_HINGE";
    return JointType;
}({});
export var BaseboneConstraintType = /*#__PURE__*/ function(BaseboneConstraintType) {
    BaseboneConstraintType[BaseboneConstraintType["NONE"] = 0] = "NONE";
    BaseboneConstraintType[BaseboneConstraintType["GLOBAL_ROTOR"] = 1] = "GLOBAL_ROTOR";
    BaseboneConstraintType[BaseboneConstraintType["LOCAL_ROTOR"] = 2] = "LOCAL_ROTOR";
    BaseboneConstraintType[BaseboneConstraintType["GLOBAL_HINGE"] = 3] = "GLOBAL_HINGE";
    BaseboneConstraintType[BaseboneConstraintType["LOCAL_HINGE"] = 4] = "LOCAL_HINGE";
    return BaseboneConstraintType;
}({});
export var BoneConnectionPoint = /*#__PURE__*/ function(BoneConnectionPoint) {
    BoneConnectionPoint[BoneConnectionPoint["START"] = 0] = "START";
    BoneConnectionPoint[BoneConnectionPoint["END"] = 1] = "END";
    return BoneConnectionPoint;
}({});
const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_SOLVE_DISTANCE_THRESHOLD = 0.01;
const DEFAULT_MIN_ITERATION_CHANGE = 1e-4;
const DEGENERATE_SQUARED_LENGTH = 1e-24;
function setUnitAxis(out, axis) {
    if (!hasDirection(vec3.squaredLength(axis))) return out;
    return vec3.normalize(out, axis);
}
function hasDirection(squaredLength) {
    if (Number.isNaN(squaredLength)) return false;
    return squaredLength >= DEGENERATE_SQUARED_LENGTH;
}
export function createJoint3() {
    return {
        type: 0,
        rotor: Math.PI,
        clockwise: Math.PI,
        anticlockwise: Math.PI,
        rotationAxis: [
            0,
            0,
            1
        ],
        referenceAxis: [
            1,
            0,
            0
        ]
    };
}
export function createChain3() {
    return {
        bones: [],
        length: 0,
        base: [
            0,
            0,
            0
        ],
        fixedBase: true,
        baseboneConstraintType: 0,
        baseboneAxis: [
            0,
            1,
            0
        ],
        baseboneReferenceAxis: [
            1,
            0,
            0
        ],
        baseboneWorldAxis: [
            0,
            1,
            0
        ],
        baseboneWorldReferenceAxis: [
            1,
            0,
            0
        ],
        baseboneRotor: Math.PI,
        baseboneClockwise: Math.PI,
        baseboneAnticlockwise: Math.PI,
        embeddedTarget: [
            0,
            0,
            0
        ],
        useEmbeddedTarget: false,
        maxIterations: DEFAULT_MAX_ITERATIONS,
        solveDistanceThreshold: DEFAULT_SOLVE_DISTANCE_THRESHOLD,
        minIterationChange: DEFAULT_MIN_ITERATION_CHANGE,
        solveDistance: Number.POSITIVE_INFINITY,
        bestSolution: []
    };
}
export function addBone(chain, start, end, joint = createJoint3()) {
    const bone = {
        start: [
            start[0],
            start[1],
            start[2]
        ],
        end: [
            end[0],
            end[1],
            end[2]
        ],
        length: vec3.distance(start, end),
        joint
    };
    if (chain.bones.length === 0) {
        chain.base[0] = start[0];
        chain.base[1] = start[1];
        chain.base[2] = start[2];
    }
    chain.bones.push(bone);
    chain.length += bone.length;
    chain.bestSolution.push(0, 0, 0, 0, 0, 0);
    return bone;
}
export function addConsecutiveBone(chain, direction, length, joint = createJoint3()) {
    const previous = chain.bones[chain.bones.length - 1];
    _addConsecutive_end[0] = previous.end[0] + direction[0] * length;
    _addConsecutive_end[1] = previous.end[1] + direction[1] * length;
    _addConsecutive_end[2] = previous.end[2] + direction[2] * length;
    return addBone(chain, previous.end, _addConsecutive_end, joint);
}
const _addConsecutive_end = [
    0,
    0,
    0
];
export function addBoneAtBase(chain, direction, length, joint = createJoint3()) {
    const first = chain.bones[0];
    first.joint = joint;
    const bone = {
        start: [
            first.start[0] - direction[0] * length,
            first.start[1] - direction[1] * length,
            first.start[2] - direction[2] * length
        ],
        end: [
            first.start[0],
            first.start[1],
            first.start[2]
        ],
        length,
        joint: createJoint3()
    };
    chain.bones.unshift(bone);
    chain.length += length;
    chain.base[0] = bone.start[0];
    chain.base[1] = bone.start[1];
    chain.base[2] = bone.start[2];
    chain.bestSolution.push(0, 0, 0, 0, 0, 0);
    return bone;
}
export function setBallJoint(joint, rotor) {
    joint.type = 0;
    joint.rotor = clampAngle(rotor);
    return joint;
}
export function setHingeJoint(joint, type, rotationAxis, clockwise, anticlockwise, referenceAxis) {
    joint.type = type;
    joint.clockwise = clampAngle(clockwise);
    joint.anticlockwise = clampAngle(anticlockwise);
    setUnitAxis(joint.rotationAxis, rotationAxis);
    orthonormalize(joint.referenceAxis, referenceAxis, joint.rotationAxis);
    return joint;
}
export function setBaseboneRotorConstraint(chain, type, axis, rotor) {
    chain.baseboneConstraintType = type;
    chain.baseboneRotor = clampAngle(rotor);
    setUnitAxis(chain.baseboneAxis, axis);
    vec3.copy(chain.baseboneWorldAxis, chain.baseboneAxis);
    return chain;
}
export function setBaseboneHingeConstraint(chain, type, rotationAxis, clockwise, anticlockwise, referenceAxis) {
    chain.baseboneConstraintType = type;
    chain.baseboneClockwise = clampAngle(clockwise);
    chain.baseboneAnticlockwise = clampAngle(anticlockwise);
    setUnitAxis(chain.baseboneAxis, rotationAxis);
    orthonormalize(chain.baseboneReferenceAxis, referenceAxis, chain.baseboneAxis);
    vec3.copy(chain.baseboneWorldAxis, chain.baseboneAxis);
    vec3.copy(chain.baseboneWorldReferenceAxis, chain.baseboneReferenceAxis);
    return chain;
}
export function setBaseLocation(chain, base) {
    chain.base[0] = base[0];
    chain.base[1] = base[1];
    chain.base[2] = base[2];
    return chain;
}
export function straighten(chain, direction) {
    const bones = chain.bones;
    let x = chain.base[0];
    let y = chain.base[1];
    let z = chain.base[2];
    for(let i = 0; i < bones.length; i++){
        const bone = bones[i];
        bone.start[0] = x;
        bone.start[1] = y;
        bone.start[2] = z;
        x += direction[0] * bone.length;
        y += direction[1] * bone.length;
        z += direction[2] * bone.length;
        bone.end[0] = x;
        bone.end[1] = y;
        bone.end[2] = z;
    }
    return chain;
}
export function getEffector(out, chain) {
    const count = chain.bones.length;
    return vec3.copy(out, count === 0 ? chain.base : chain.bones[count - 1].end);
}
export function getBoneDirection(out, chain, index) {
    const bone = chain.bones[index];
    vec3.subtract(out, bone.end, bone.start);
    return normalizeOr(out, UP);
}
export function getBoneRotation(out, chain, index, up) {
    getBoneDirection(_boneRotation_direction, chain, index);
    return quat.rotationTo(out, up, _boneRotation_direction);
}
const _boneRotation_direction = [
    0,
    0,
    0
];
export function isReachable(chain, target) {
    return vec3.squaredDistance(chain.base, target) <= chain.length * chain.length;
}
export function forward(chain, target) {
    const bones = chain.bones;
    const count = bones.length;
    if (count === 0) return chain;
    if (!Number.isFinite(target[0]) || !Number.isFinite(target[1]) || !Number.isFinite(target[2])) return chain;
    const effector = bones[count - 1];
    effector.end[0] = target[0];
    effector.end[1] = target[1];
    effector.end[2] = target[2];
    let hasReference = false;
    for(let i = count - 1; i >= 0; i--){
        const bone = bones[i];
        const start = bone.start;
        const end = bone.end;
        let dx = start[0] - end[0];
        let dy = start[1] - end[1];
        let dz = start[2] - end[2];
        const squaredLength = dx * dx + dy * dy + dz * dz;
        if (!hasDirection(squaredLength)) {
            dx = hasReference ? _pass_reference[0] : UP[0];
            dy = hasReference ? _pass_reference[1] : UP[1];
            dz = hasReference ? _pass_reference[2] : UP[2];
        } else {
            const inverseLength = 1 / Math.sqrt(squaredLength);
            dx *= inverseLength;
            dy *= inverseLength;
            dz *= inverseLength;
        }
        constrainForward(chain, i, dx, dy, dz, hasReference);
        dx = _pass_direction[0];
        dy = _pass_direction[1];
        dz = _pass_direction[2];
        const x = end[0] + dx * bone.length;
        const y = end[1] + dy * bone.length;
        const z = end[2] + dz * bone.length;
        start[0] = x;
        start[1] = y;
        start[2] = z;
        if (i > 0) {
            const previousEnd = bones[i - 1].end;
            previousEnd[0] = x;
            previousEnd[1] = y;
            previousEnd[2] = z;
        }
        _pass_reference[0] = dx;
        _pass_reference[1] = dy;
        _pass_reference[2] = dz;
        hasReference = true;
    }
    return chain;
}
export function backward(chain, base) {
    const bones = chain.bones;
    const count = bones.length;
    if (count === 0) return chain;
    if (!Number.isFinite(base[0]) || !Number.isFinite(base[1]) || !Number.isFinite(base[2])) return chain;
    if (chain.fixedBase) {
        const start = bones[0].start;
        start[0] = base[0];
        start[1] = base[1];
        start[2] = base[2];
    }
    let hasReference = false;
    for(let i = 0; i < count; i++){
        const bone = bones[i];
        const start = bone.start;
        const end = bone.end;
        let dx = end[0] - start[0];
        let dy = end[1] - start[1];
        let dz = end[2] - start[2];
        const squaredLength = dx * dx + dy * dy + dz * dz;
        if (!hasDirection(squaredLength)) {
            dx = hasReference ? _pass_reference[0] : UP[0];
            dy = hasReference ? _pass_reference[1] : UP[1];
            dz = hasReference ? _pass_reference[2] : UP[2];
        } else {
            const inverseLength = 1 / Math.sqrt(squaredLength);
            dx *= inverseLength;
            dy *= inverseLength;
            dz *= inverseLength;
        }
        constrainBackward(chain, i, dx, dy, dz, hasReference);
        dx = _pass_direction[0];
        dy = _pass_direction[1];
        dz = _pass_direction[2];
        if (i === 0 && !chain.fixedBase) {
            start[0] = end[0] - dx * bone.length;
            start[1] = end[1] - dy * bone.length;
            start[2] = end[2] - dz * bone.length;
        }
        const x = start[0] + dx * bone.length;
        const y = start[1] + dy * bone.length;
        const z = start[2] + dz * bone.length;
        end[0] = x;
        end[1] = y;
        end[2] = z;
        if (i < count - 1) {
            const nextStart = bones[i + 1].start;
            nextStart[0] = x;
            nextStart[1] = y;
            nextStart[2] = z;
        }
        _pass_reference[0] = dx;
        _pass_reference[1] = dy;
        _pass_reference[2] = dz;
        hasReference = true;
    }
    return chain;
}
export function iterate(chain, target) {
    if (chain.bones.length === 0) return Number.POSITIVE_INFINITY;
    forward(chain, target);
    backward(chain, chain.base);
    return vec3.distance(chain.bones[chain.bones.length - 1].end, target);
}
export function solve(chain, target) {
    const count = chain.bones.length;
    if (count === 0) {
        chain.solveDistance = Number.POSITIVE_INFINITY;
        return chain.solveDistance;
    }
    if (chain.bestSolution.length < count * 6) {
        chain.bestSolution.length = count * 6;
        chain.bestSolution.fill(0);
    }
    let best = Number.POSITIVE_INFINITY;
    let previous = Number.POSITIVE_INFINITY;
    for(let i = 0; i < chain.maxIterations; i++){
        const distance = iterate(chain, target);
        if (distance < best) {
            best = distance;
            saveSolution(chain);
            if (distance <= chain.solveDistanceThreshold) break;
        } else if (Math.abs(distance - previous) < chain.minIterationChange) {
            break;
        }
        previous = distance;
    }
    if (best !== Number.POSITIVE_INFINITY) {
        restoreSolution(chain);
    }
    chain.solveDistance = best;
    return best;
}
export function createStructure3() {
    return {
        chains: [],
        connections: []
    };
}
export function addChain(structure, chain) {
    structure.chains.push(chain);
    structure.connections.push({
        hostChain: -1,
        hostBone: 0,
        point: 1
    });
    return structure.chains.length - 1;
}
export function connectChain(structure, chain, hostChain, hostBone, point) {
    structure.chains.push(chain);
    structure.connections.push({
        hostChain,
        hostBone,
        point
    });
    return structure.chains.length - 1;
}
export function solveStructure(structure, target) {
    const chains = structure.chains;
    for(let i = 0; i < chains.length; i++){
        const chain = chains[i];
        const connection = structure.connections[i];
        if (connection.hostChain >= 0) {
            const host = chains[connection.hostChain];
            const hostBone = host.bones[connection.hostBone];
            setBaseLocation(chain, connection.point === 0 ? hostBone.start : hostBone.end);
            chain.fixedBase = true;
            const type = chain.baseboneConstraintType;
            if (type === 2 || type === 4) {
                getBoneDirection(_structure_direction, host, connection.hostBone);
                basisFromDirection(_structure_basis, _structure_direction);
                vec3.transformMat3(chain.baseboneWorldAxis, chain.baseboneAxis, _structure_basis);
                vec3.normalize(chain.baseboneWorldAxis, chain.baseboneWorldAxis);
                if (type === 4) {
                    vec3.transformMat3(chain.baseboneWorldReferenceAxis, chain.baseboneReferenceAxis, _structure_basis);
                    orthonormalize(chain.baseboneWorldReferenceAxis, chain.baseboneWorldReferenceAxis, chain.baseboneWorldAxis);
                }
            }
        }
        solve(chain, chain.useEmbeddedTarget ? chain.embeddedTarget : target);
    }
}
const _structure_direction = [
    0,
    0,
    0
];
const _structure_basis = mat3.create();
const UP = [
    0,
    1,
    0
];
const _pass_reference = [
    0,
    0,
    0
];
const _pass_direction = [
    0,
    0,
    0
];
const _constrain_axis = [
    0,
    0,
    0
];
const _constrain_reference = [
    0,
    0,
    0
];
const _constrain_basis = mat3.create();
function clampAngle(radians) {
    return radians < 0 ? 0 : radians > Math.PI ? Math.PI : radians;
}
function orthonormalize(out, a, axis) {
    vec3.scaleAndAdd(out, a, axis, -vec3.dot(a, axis));
    if (!hasDirection(vec3.squaredLength(out))) {
        return vec3.perpendicular(out, axis);
    }
    return vec3.normalize(out, out);
}
function normalizeOr(out, fallback) {
    if (!hasDirection(vec3.squaredLength(out))) {
        return vec3.copy(out, fallback);
    }
    return vec3.normalize(out, out);
}
function projectOntoHinge(out, x, y, z, axis, referenceAxis) {
    const d = x * axis[0] + y * axis[1] + z * axis[2];
    out[0] = x - axis[0] * d;
    out[1] = y - axis[1] * d;
    out[2] = z - axis[2] * d;
    if (!hasDirection(vec3.squaredLength(out))) {
        return vec3.copy(out, referenceAxis);
    }
    return vec3.normalize(out, out);
}
function rotateAboutAxis(out, a, axis, radians) {
    const ax = a[0];
    const ay = a[1];
    const az = a[2];
    const kx = axis[0];
    const ky = axis[1];
    const kz = axis[2];
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    const d = (kx * ax + ky * ay + kz * az) * (1 - c);
    out[0] = ax * c + (ky * az - kz * ay) * s + kx * d;
    out[1] = ay * c + (kz * ax - kx * az) * s + ky * d;
    out[2] = az * c + (kx * ay - ky * ax) * s + kz * d;
    return out;
}
function constrainHinge(x, y, z, axis, referenceAxis, clockwise, anticlockwise) {
    projectOntoHinge(_pass_direction, x, y, z, axis, referenceAxis);
    if (clockwise >= Math.PI && anticlockwise >= Math.PI) return;
    const signed = vec3.signedAngle(referenceAxis, _pass_direction, axis);
    if (signed > anticlockwise) {
        rotateAboutAxis(_pass_direction, referenceAxis, axis, anticlockwise);
    } else if (signed < -clockwise) {
        rotateAboutAxis(_pass_direction, referenceAxis, axis, -clockwise);
    }
}
function basisFromDirection(out, direction) {
    const x = direction[0];
    const y = direction[1];
    const z = direction[2];
    if (z < -0.9999999) {
        out[0] = 0;
        out[1] = -1;
        out[2] = 0;
        out[3] = -1;
        out[4] = 0;
        out[5] = 0;
        out[6] = x;
        out[7] = y;
        out[8] = z;
        return out;
    }
    const a = 1 / (1 + z);
    const b = -x * y * a;
    out[0] = 1 - x * x * a;
    out[1] = b;
    out[2] = -x;
    out[3] = b;
    out[4] = 1 - y * y * a;
    out[5] = -y;
    out[6] = x;
    out[7] = y;
    out[8] = z;
    return out;
}
function resolveLocalHinge(chain, index, joint) {
    getBoneDirection(_constrain_axis, chain, index - 1);
    basisFromDirection(_constrain_basis, _constrain_axis);
    vec3.transformMat3(_constrain_axis, joint.rotationAxis, _constrain_basis);
    vec3.normalize(_constrain_axis, _constrain_axis);
    vec3.transformMat3(_constrain_reference, joint.referenceAxis, _constrain_basis);
    orthonormalize(_constrain_reference, _constrain_reference, _constrain_axis);
}
function constrainForward(chain, index, x, y, z, hasReference) {
    _pass_direction[0] = x;
    _pass_direction[1] = y;
    _pass_direction[2] = z;
    if (index === 0) {
        const type = chain.baseboneConstraintType;
        if (type === 3 || type === 4) {
            projectOntoHinge(_pass_direction, x, y, z, chain.baseboneWorldAxis, chain.baseboneWorldReferenceAxis);
            return;
        }
    } else {
        const joint = chain.bones[index].joint;
        if (joint.type === 1) {
            projectOntoHinge(_pass_direction, x, y, z, joint.rotationAxis, joint.referenceAxis);
            return;
        }
        if (joint.type === 2) {
            resolveLocalHinge(chain, index, joint);
            projectOntoHinge(_pass_direction, x, y, z, _constrain_axis, _constrain_reference);
            return;
        }
    }
    if (!hasReference) return;
    const outer = chain.bones[index + 1].joint;
    if (outer.type !== 0 || outer.rotor >= Math.PI) return;
    _pass_direction[0] = x;
    _pass_direction[1] = y;
    _pass_direction[2] = z;
    vec3.rotateTowards(_pass_direction, _pass_reference, _pass_direction, outer.rotor);
}
function constrainBackward(chain, index, x, y, z, hasReference) {
    _pass_direction[0] = x;
    _pass_direction[1] = y;
    _pass_direction[2] = z;
    if (index === 0) {
        switch(chain.baseboneConstraintType){
            case 1:
            case 2:
                {
                    if (chain.baseboneRotor >= Math.PI) return;
                    vec3.rotateTowards(_pass_direction, chain.baseboneWorldAxis, _pass_direction, chain.baseboneRotor);
                    return;
                }
            case 3:
            case 4:
                {
                    constrainHinge(x, y, z, chain.baseboneWorldAxis, chain.baseboneWorldReferenceAxis, chain.baseboneClockwise, chain.baseboneAnticlockwise);
                    return;
                }
            default:
                return;
        }
    }
    const joint = chain.bones[index].joint;
    switch(joint.type){
        case 0:
            {
                if (!hasReference || joint.rotor >= Math.PI) return;
                vec3.rotateTowards(_pass_direction, _pass_reference, _pass_direction, joint.rotor);
                return;
            }
        case 1:
            {
                constrainHinge(x, y, z, joint.rotationAxis, joint.referenceAxis, joint.clockwise, joint.anticlockwise);
                return;
            }
        case 2:
            {
                resolveLocalHinge(chain, index, joint);
                constrainHinge(x, y, z, _constrain_axis, _constrain_reference, joint.clockwise, joint.anticlockwise);
                return;
            }
        default:
            return;
    }
}
function saveSolution(chain) {
    const bones = chain.bones;
    const solution = chain.bestSolution;
    for(let i = 0; i < bones.length; i++){
        const bone = bones[i];
        const offset = i * 6;
        solution[offset] = bone.start[0];
        solution[offset + 1] = bone.start[1];
        solution[offset + 2] = bone.start[2];
        solution[offset + 3] = bone.end[0];
        solution[offset + 4] = bone.end[1];
        solution[offset + 5] = bone.end[2];
    }
}
function restoreSolution(chain) {
    const bones = chain.bones;
    const solution = chain.bestSolution;
    for(let i = 0; i < bones.length; i++){
        const bone = bones[i];
        const offset = i * 6;
        bone.start[0] = solution[offset];
        bone.start[1] = solution[offset + 1];
        bone.start[2] = solution[offset + 2];
        bone.end[0] = solution[offset + 3];
        bone.end[1] = solution[offset + 4];
        bone.end[2] = solution[offset + 5];
    }
}
