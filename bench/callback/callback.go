package main

import (
	"fmt"
	"time"
)

const (
	n       = 4096
	nIters  = 128
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

func runKernel(a []float64, scale float64) uint32 {
	h := uint32(0x811c9dc5)
	b := make([]float64, len(a))
	for i := 0; i < nIters; i++ {
		iLocal := float64(i)
		for k := range a {
			b[k] = a[k]*scale + iLocal
		}
		for j := 0; j < len(a); j += 64 {
			h = mix(h, uint32(int32(b[j])))
		}
	}
	return h
}

func main() {
	a := make([]float64, n)
	for i := range a {
		a[i] = float64(i%97 - 48)
	}

	var cs uint32
	for i := 0; i < nWarmup; i++ {
		cs = runKernel(a, 2.0)
	}

	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs = runKernel(a, 2.0)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, n*nIters, 1, nRuns)
}
