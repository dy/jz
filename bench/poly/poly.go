package main

import (
	"fmt"
	"time"
)

const (
	n       = 8192
	nIters  = 80
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

func initData(f64 []float64, i32 []int32) {
	for i := 0; i < n; i++ {
		f64[i] = float64(i%251) * 0.25
		i32[i] = int32((i * 17) & 1023)
	}
}

func sumF64(xs []float64) float64 {
	var s float64
	for _, x := range xs {
		s += x
	}
	return s
}

func sumI32(xs []int32) int32 {
	var s int32
	for _, x := range xs {
		s += x
	}
	return s
}

func runKernel(f64 []float64, i32 []int32) uint32 {
	h := uint32(0x811c9dc5)
	for i := 0; i < nIters; i++ {
		h = mix(h, uint32(sumF64(f64)))
		h = mix(h, uint32(sumI32(i32)))
	}
	return h
}

func main() {
	f64 := make([]float64, n)
	i32 := make([]int32, n)
	initData(f64, i32)

	var cs uint32
	for i := 0; i < nWarmup; i++ {
		cs = runKernel(f64, i32)
	}
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs = runKernel(f64, i32)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, n*nIters*2, 2, nRuns)
}
