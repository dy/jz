// jz sin/cos kernel diverges from libm at ~1e-9 absolute (~30-bit accuracy).
// Filter-design math amplifies it: biquad lowpass b0 = (1-cosw)/2 / a0 suffers
// catastrophic cancellation for small w — measured ~1.3e-6 RELATIVE error at
// fc=1000, fs=44100 vs node. High-Q / low-fc pole placement is sensitive to this.
export function sin1() { return Math.sin(1) }        // node: 0.8414709848078965
export function b0(fc, fs) {                          // node: 0.004603935028493071 at (1000, 44100)
	let w = 2 * Math.PI * fc / fs
	let cosw = Math.cos(w), alpha = Math.sin(w) / (2 * 0.707)
	return ((1 - cosw) / 2) / (1 + alpha)
}
