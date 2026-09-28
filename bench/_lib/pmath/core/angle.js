const TAU = Math.PI * 2;
export const DEGREES_TO_RADIANS = Math.PI / 180;
export const RADIANS_TO_DEGREES = 180 / Math.PI;
export function degreesToRadians(degrees) {
    return degrees * DEGREES_TO_RADIANS;
}
export function radiansToDegrees(radians) {
    return radians * RADIANS_TO_DEGREES;
}
export function wrapAngle(a) {
    return a - TAU * Math.floor((a + Math.PI) / TAU);
}
export function deltaAngle(current, target) {
    const diff = target - current;
    const delta = diff - TAU * Math.floor(diff / TAU);
    return delta > Math.PI ? delta - TAU : delta;
}
