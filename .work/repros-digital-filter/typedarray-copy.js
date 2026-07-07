// `new Float64Array(data)` must COPY (TypedArray(typedArray) constructor);
// jz aliases the same storage: returns 999, node returns 1.
// Live instance: digital-filter/smooth/{median,savitzky-golay}.js.
export default function f (data) {
	let copy = new Float64Array(data)
	data[0] = 999
	return copy[0]
}
