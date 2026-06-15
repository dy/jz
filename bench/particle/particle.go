// particle.go — fixed-timestep particle integrator. Bit-identical to particle.js.
// On arm64 Go auto-fuses `a + b*c` to FMADDD (no flag to disable); the integration
// then rounds differently in the last ulp → reported as `fma` parity, not DIFF.
package main

import (
	"encoding/binary"
	"fmt"
	"math"
	"time"
)

const (
	N        = 1 << 16
	STEPS    = 256
	DT       = 0.015625
	G        = -9.8
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

func seedState(px, py, vx, vy []float64) {
	s := uint32(0x1234abcd)
	r := func() float64 {
		s ^= s << 13
		s ^= s >> 17
		s ^= s << 5
		return float64(s)/4294967296.0*2.0 - 1.0
	}
	for i := 0; i < N; i++ {
		px[i] = r()
		py[i] = r()
		vx[i] = r()
		vy[i] = r()
	}
}

func step(px, py, vx, vy []float64) {
	for i := 0; i < N; i++ {
		nvy := vy[i] + G*DT
		px[i] = px[i] + vx[i]*DT
		py[i] = py[i] + nvy*DT
		vy[i] = nvy
	}
}

func run(px, py, vx, vy []float64) {
	for f := 0; f < STEPS; f++ {
		step(px, py, vx, vy)
	}
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

var _ = binary.LittleEndian

func main() {
	px := make([]float64, N)
	py := make([]float64, N)
	vx := make([]float64, N)
	vy := make([]float64, N)

	for i := 0; i < N_WARMUP; i++ {
		seedState(px, py, vx, vy)
		run(px, py, vx, vy)
	}

	samples := make([]float64, N_RUNS)
	for i := 0; i < N_RUNS; i++ {
		seedState(px, py, vx, vy)
		t0 := time.Now()
		run(px, py, vx, vy)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}

	cs := checksumF64(py) ^ checksumF64(px)
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, N*STEPS, STEPS, N_RUNS)
}
