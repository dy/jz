// @audio/encode-wav 1.5.1, reduced by delta debugging with two oracles: jz still rejects it
// ("Binding 'rf64' can be both Boolean and Number"), and V8 still runs it (flush() returns a
// header starting "RIFF"). Hand-written smaller forms of `a && b && n` compile, so the
// surrounding closure is part of the trigger.
export default async function wav(opts) {
	let { sampleRate, bitDepth = 16, stream } = opts
	let nch = 0
	let chunks = []
	let sent = false, exact = null, known = null
	return { encode, flush, free, head }
	function encode(ch) {
	}
	function declared() {
	}
	function header(data) {
		let x = 0, junk = known == null ? 36 : 0
		let h = new Uint8Array(12 + junk + 24 + x + 8), dv = new DataView(h.buffer)
		let ch = nch || opts.channels || 1, pad = data & 1, fixed = data !== 0xFFFFFFFF
		let riff = fixed ? h.length - 8 + data + pad : 0xFFFFFFFF
		let rf64 = fixed && riff > 0xFFFFFFFF && junk
		dv.setUint32(0, rf64 ? 0x52463634 : 0x52494646)       // "RF64" | "RIFF"
		if (junk) {
		}
		let off = 36 + junk
		dv.setUint32(off + 4, rf64 || data > 0xFFFFFFFF ? 0xFFFFFFFF : data, true)
		return h
	}
	function fmtChunk(dv, o, ch) {
	}
	function head() { return exact }
	function flush() {
		if (stream) {
			let h = sent ? null : (sent = true, header(declared()))
			let out = new Uint8Array(h.length + 1); out.set(h); return out
		}
		for (let i = 0; i < chunks.length; i++) {
		}
	}
	function free() {
	}
}
