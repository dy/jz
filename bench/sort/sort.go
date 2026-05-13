package main

import (
	"fmt"
	"math"
	"time"
)

const (
	n       = 8192
	nIters  = 24
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

func checksumF64(xs []float64) uint32 {
	h := uint32(0x811c9dc5)
	for i := 0; i < len(xs)*2; i += 256 {
		b := math.Float64bits(xs[i>>1])
		var x uint32
		if i&1 == 0 {
			x = uint32(b)
		} else {
			x = uint32(b >> 32)
		}
		h = mix(h, x)
	}
	return h
}

func fill(xs []float64) {
	s := uint32(0x9e3779b9)
	for i := range xs {
		s ^= s << 13
		s ^= s >> 17
		s ^= s << 5
		xs[i] = float64(s) / 4294967296.0
	}
}

func heapsort(a []float64) {
	for root := (len(a) >> 1) - 1; root >= 0; root-- {
		i := root
		child := 2*i + 1
		for child < len(a) {
			if child+1 < len(a) && a[child] < a[child+1] {
				child++
			}
			if a[i] >= a[child] {
				break
			}
			a[i], a[child] = a[child], a[i]
			i = child
			child = 2*i + 1
		}
	}
	for end := len(a) - 1; end > 0; end-- {
		a[0], a[end] = a[end], a[0]
		i := 0
		child := 1
		for child < end {
			if child+1 < end && a[child] < a[child+1] {
				child++
			}
			if a[i] >= a[child] {
				break
			}
			a[i], a[child] = a[child], a[i]
			i = child
			child = 2*i + 1
		}
	}
}

func runKernel(a, src []float64) {
	for it := 0; it < nIters; it++ {
		f := float64(it)
		for i := range a {
			a[i] = src[i] + f
		}
		heapsort(a)
	}
}

func main() {
	src := make([]float64, n)
	a := make([]float64, n)
	fill(src)
	for i := 0; i < nWarmup; i++ {
		runKernel(a, src)
	}
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		runKernel(a, src)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), checksumF64(a), n*nIters, 2, nRuns)
}
