export function create(seed) {
    return {
        a: seed
    };
}
export function next(state) {
    state.a = state.a + 0x6d2b79f5 | 0;
    let t = state.a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return (t ^ t >>> 14) >>> 0;
}
export function sample(state) {
    return next(state) / 4294967296;
}
export function seed() {
    return Math.random() * 2 ** 32 >>> 0;
}
