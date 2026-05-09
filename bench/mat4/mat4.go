package main

import (
	"fmt"
	"math"
	"time"
)

const (
	nIters  = 200000
	nRuns   = 21
	nWarmup = 5
)

func mix(h, x uint32) uint32 { return (h ^ x) * 0x01000193 }

func checksumF64(out []float64) uint32 {
	h := uint32(0x811c9dc5)
	for i := 0; i < len(out)*2; i += 256 {
		bits := math.Float64bits(out[i/2])
		if i&1 == 0 {
			h = mix(h, uint32(bits))
		} else {
			h = mix(h, uint32(bits>>32))
		}
	}
	return h
}

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

func initMat(a, b []float64) {
	for i := 0; i < 16; i++ {
		a[i] = float64(i+1) * 0.125
		b[i] = float64(16-i) * 0.0625
	}
}

func multiplyMany(a, b, out []float64, iters int) {
	for n := 0; n < iters; n++ {
		for r := 0; r < 4; r++ {
			for c := 0; c < 4; c++ {
				s := 0.0
				for k := 0; k < 4; k++ {
					s += a[r*4+k] * b[k*4+c]
				}
				out[r*4+c] = s + float64(n)*0.0000001
			}
		}
		t := a[0]
		a[0] = out[15]
		a[5] = t + out[10]*0.000001
		b[0] += out[0] * 0.00000000001
		b[5] -= out[5] * 0.00000000001
	}
}

func main() {
	a := make([]float64, 16)
	b := make([]float64, 16)
	out := make([]float64, 16)
	initMat(a, b)
	for i := 0; i < nWarmup; i++ {
		multiplyMany(a, b, out, nIters)
	}
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		initMat(a, b)
		t0 := time.Now()
		multiplyMany(a, b, out, nIters)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), checksumF64(out), nIters*16, 4, nRuns)
}
