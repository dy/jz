// heat.go — 2-D heat diffusion (explicit-Euler 5-point Laplacian). Bit-identical to
// heat.js. On arm64 Go auto-fuses `c + K*lap` to FMADDD (no flag to disable); the
// field then rounds differently in the last ulp → reported as `fma` parity, not DIFF.
package main

import (
	"fmt"
	"math"
	"time"
)

const (
	W        = 258
	H        = 258
	STEPS    = 100
	K        = 0.125
	N_RUNS   = 21
	N_WARMUP = 5
)

func mix(h, x uint32) uint32 { return (h ^ x) * 0x01000193 }

func checksumF64(out []float64) uint32 {
	h := uint32(0x811c9dc5)
	for i := 0; i < len(out)*2; i += 256 {
		bits := math.Float64bits(out[i/2])
		var w uint32
		if i&1 == 0 {
			w = uint32(bits)
		} else {
			w = uint32(bits >> 32)
		}
		h = mix(h, w)
	}
	return h
}

func medianUs(samples []float64) uint64 {
	for i := 1; i < len(samples); i++ {
		v := samples[i]
		j := i - 1
		for j >= 0 && samples[j] > v {
			samples[j+1] = samples[j]
			j--
		}
		samples[j+1] = v
	}
	return uint64(samples[(len(samples)-1)>>1] * 1000.0)
}

// Deterministic integer field 0..255 (XorShift32), identical per target.
func seed(a []float64) {
	s := uint32(0x1234abcd)
	for i := range a {
		s ^= s << 13
		s ^= s >> 17
		s ^= s << 5
		a[i] = float64(s & 255)
	}
}

// One diffusion sweep over the interior: dst = src + K·(∇²src). Border stays fixed.
func step(src, dst []float64) {
	for y := 1; y < H-1; y++ {
		row := y * W
		for x := 1; x < W-1; x++ {
			c := row + x
			dst[c] = src[c] + K*(src[c-1]+src[c+1]+src[c-W]+src[c+W]-4*src[c])
		}
	}
}

func run(a, b []float64) {
	for s := 0; s < STEPS; s += 2 {
		step(a, b)
		step(b, a)
	}
}

func main() {
	a := make([]float64, W*H)
	b := make([]float64, W*H)
	for i := 0; i < N_WARMUP; i++ {
		seed(a)
		seed(b)
		run(a, b)
	}
	samples := make([]float64, N_RUNS)
	for i := 0; i < N_RUNS; i++ {
		seed(a)
		seed(b)
		t0 := time.Now()
		run(a, b)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), checksumF64(a), (W-2)*(H-2)*STEPS, 6, N_RUNS)
}
