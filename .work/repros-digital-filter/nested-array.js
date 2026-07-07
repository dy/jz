// Nested arrays (Array of Float64Array rows) written onto a host-marshaled
// object param read back undefined; node returns 400 for {order:4, delta:100}.
// Live instance: digital-filter/adaptive/rls.js (P covariance matrix on params).
export default function f (params) {
	let N = params.order
	params.P = new Array(N)
	for (let i = 0; i < N; i++) {
		params.P[i] = new Float64Array(N)
		params.P[i][i] = params.delta
	}
	let P = params.P
	let sum = 0
	for (let i = 0; i < N; i++) sum += P[i][i]
	return sum
}
