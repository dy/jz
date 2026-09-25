// resample.go — the same four-point Hermite interpolation as resample.js.
// Native arm64 Go fuses multiply-adds; its verified alternate checksum is
// classified as fma. Go-Wasm matches the strict f64 reference exactly.
package main

import (
	"fmt"
	"math"
	"time"
)

const (
	N        = 1 << 16
	STEP_UP  = 0.7317314443021356
	STEP_DN  = 1.3186248722190522
	M_UP     = 89000
	M_DN     = 49000
	N_ITERS  = 5
	N_RUNS   = 21
	N_WARMUP = 5
)

func buildInput(input []float64) {
	s := uint32(0x6d2f4b1)
	for i := range input {
		s ^= s << 13
		s ^= s >> 17
		s ^= s << 5
		input[i] = (float64(s)/4294967296.0)*2.0 - 1.0
	}
}

func resamplePass(input, out []float64, m int, step float64) {
	phase := 1.0
	for k := 0; k < m; k++ {
		idx := int(phase)
		f := phase - float64(idx)
		x0, x1, x2, x3 := input[idx-1], input[idx], input[idx+1], input[idx+2]
		c0 := x1
		c1 := 0.5 * (x2 - x0)
		c2 := x0 - 2.5*x1 + 2.0*x2 - 0.5*x3
		c3 := 0.5*(x3-x0) + 1.5*(x1-x2)
		out[k] = ((c3*f+c2)*f+c1)*f + c0
		phase += step
	}
}

func runKernel(input, up, dn []float64) {
	for it := 0; it < N_ITERS; it++ {
		resamplePass(input, up, M_UP, STEP_UP)
		resamplePass(up, dn, M_DN, STEP_DN)
	}
}

func checksumF64(out []float64) uint32 {
	h := uint32(0x811c9dc5)
	for i := 0; i < len(out)*2; i += 256 {
		word := uint32(math.Float64bits(out[i/2]) >> uint((i&1)*32))
		h = (h ^ word) * 0x01000193
	}
	return h
}

func medianUs(samples []float64) uint64 {
	for i := 1; i < len(samples); i++ {
		v, j := samples[i], i-1
		for j >= 0 && samples[j] > v {
			samples[j+1] = samples[j]
			j--
		}
		samples[j+1] = v
	}
	return uint64(samples[(len(samples)-1)>>1] * 1000.0)
}

func main() {
	input, up, dn := make([]float64, N), make([]float64, M_UP), make([]float64, M_DN)
	buildInput(input)
	for i := 0; i < N_WARMUP; i++ {
		runKernel(input, up, dn)
	}

	samples := make([]float64, N_RUNS)
	for i := range samples {
		t0 := time.Now()
		runKernel(input, up, dn)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), checksumF64(up)^checksumF64(dn), (M_UP+M_DN)*N_ITERS, 2, N_RUNS)
}
