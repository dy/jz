// .map() building objects via a SEPARATE named function (not an inline literal),
// source array marshaled from the host: decodes to raw pointers [1104,1128]
// instead of [{v:10},{v:20}]. Inline `s => ({v: s})` works.
// Live instance: digital-filter/core/matched-z.js.
function mk(s) {
	return { v: s }
}
export function f(arr) {
	return arr.map(s => mk(s))
}
