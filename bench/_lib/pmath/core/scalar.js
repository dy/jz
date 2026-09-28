export const EPSILON = 0.000001;
export function round(a) {
    if (a >= 0) return Math.round(a);
    return a % 0.5 === 0 ? Math.floor(a) : Math.round(a);
}
export function equals(a, b, epsilon = EPSILON) {
    return Math.abs(a - b) <= epsilon * Math.max(1.0, Math.abs(a), Math.abs(b));
}
export function fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
}
export function lerp(v0, v1, t) {
    return v0 * (1 - t) + v1 * t;
}
export function lagrange(v0, v1, v2, t) {
    return 2 * (t - 1) * (t - 0.5) * v0 - 4 * (t - 1) * t * v1 + 2 * (t - 0.5) * t * v2;
}
export function binomial(n, k) {
    if (k < 0 || k > n) return 0;
    const j = Math.min(k, n - k);
    let coeff = 1;
    for(let i = 0; i < j; i++){
        coeff = coeff * (n - i) / (i + 1);
    }
    return Math.round(coeff);
}
export const clamp = (value, min, max)=>{
    return Math.max(min, Math.min(max, value));
};
export function repeat(t, length) {
    return clamp(t - Math.floor(t / length) * length, 0, length);
}
export function remap(number, inLow, inHigh, outLow, outHigh) {
    const scale = (number - inLow) / (inHigh - inLow);
    return outLow + scale * (outHigh - outLow);
}
export function remapClamp(value, inLow, inHigh, outLow, outHigh) {
    const scale = (value - inLow) / (inHigh - inLow);
    const remapped = outLow + scale * (outHigh - outLow);
    return Math.max(outLow, Math.min(outHigh, remapped));
}
