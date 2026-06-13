// dotprod.go — multiply-accumulate (dot-product) reductions: the fundamental
// DSP/numeric kernel (correlation, energy, projection, FIR tap-sum). The
// accumulator `s += a[i]*b[i]` is a latency-bound dependency chain — exactly
// where multi-accumulator vectorization (independent partial sums combined at
// the end) earns its keep.
package main

import (
	"fmt"
	"time"
)

const (
	n       = 8192
	nIters  = 200
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

func initData(a, b []float64) {
	for i := 0; i < n; i++ {
		a[i] = float64(i%13) - 6
		b[i] = float64((i*7)%11) - 5
	}
}

func dot(a, b []float64) float64 {
	var s float64
	for i := 0; i < n; i++ {
		s += a[i] * b[i]
	}
	return s
}

func runKernel(a, b []float64) uint32 {
	h := uint32(0x811c9dc5)
	for i := 0; i < nIters; i++ {
		h = mix(h, uint32(int32(dot(a, b))))
	}
	return h
}

func main() {
	a := make([]float64, n)
	b := make([]float64, n)
	initData(a, b)

	var cs uint32
	for i := 0; i < nWarmup; i++ {
		cs = runKernel(a, b)
	}
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs = runKernel(a, b)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, n*nIters, 2, nRuns)
}
