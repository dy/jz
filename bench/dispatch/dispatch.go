// dispatch.go — data-driven dispatch through a table of first-class functions:
// an unpredictable opcode stream picks one of 8 tiny integer operators at a
// single call site. The canonical dynamic-dispatch kernel (virtual/interface
// calls, strategy tables, event pipelines, effect chains): every step is an
// indirect call through a data-selected function value. Pure 32-bit integer,
// so the fold result is bit-identical across every engine and native target.
//
// Reports: median ms across N_RUNS, throughput in calls/µs, FNV-1a checksum
// over the per-pass fold results.
package main

import (
	"fmt"
	"time"
)

const (
	n       = 1 << 14 // opcode stream length
	nOps    = 8       // distinct operators in the table
	nIters  = 48      // stream passes per kernel run
	nRuns   = 21
	nWarmup = 5
)

func mix(h, x uint32) uint32 { return (h ^ x) * 0x01000193 }

func medianUs(samples []float64) int {
	for i := 1; i < len(samples); i++ {
		v := samples[i]
		j := i - 1
		for j >= 0 && samples[j] > v {
			samples[j+1] = samples[j]
			j--
		}
		samples[j+1] = v
	}
	return int(samples[(len(samples)-1)>>1] * 1000)
}

// The operator table — 8 functions with one shared signature, selected per
// element by data. Semantics mirror dispatch.js exactly (JS i32 ops).
var ops = [nOps]func(int32, int32) int32{
	func(x, k int32) int32 { return int32(uint32(x) + uint32(k)) },
	func(x, k int32) int32 { return x ^ k },
	func(x, k int32) int32 { return int32(uint32(x) * uint32(k|1)) },
	func(x, k int32) int32 { return int32(uint32(k) - uint32(x)) },
	func(x, k int32) int32 { return x ^ int32(uint32(x)>>7) ^ k },
	func(x, k int32) int32 { return int32(uint32(x)<<5 - uint32(x) + uint32(k)) },
	func(x, k int32) int32 { return int32((uint32(x)<<13 | uint32(x)>>19) ^ uint32(k)) },
	func(x, k int32) int32 { return (x & k) ^ int32(uint32(x)>>11) },
}

// Deterministic unpredictable opcode/operand stream — XorShift32, identical
// per target; low 3 bits pick the operator, the rest is the operand.
func fill(code, ks []int32) {
	s := int32(0x1234abcd)
	for i := 0; i < n; i++ {
		s ^= s << 13
		s ^= int32(uint32(s) >> 17)
		s ^= s << 5
		code[i] = s & (nOps - 1)
		ks[i] = s >> 3
	}
}

func runKernel(code, ks []int32) uint32 {
	h := uint32(0x811c9dc5)
	for it := 0; it < nIters; it++ {
		x := int32(0x2545f491 + uint32(it))
		for i := 0; i < n; i++ {
			x = ops[code[i]](x, ks[i])
		}
		h = mix(h, uint32(x))
	}
	return h
}

func main() {
	code := make([]int32, n)
	ks := make([]int32, n)
	fill(code, ks)

	var cs uint32
	for i := 0; i < nWarmup; i++ {
		cs = runKernel(code, ks)
	}

	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs = runKernel(code, ks)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, n*nIters, nOps, nRuns)
}
