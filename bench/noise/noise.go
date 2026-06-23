// noise.go — 2-D Perlin gradient noise summed over several octaves (fractal
// Brownian motion), the canonical procedural-generation kernel (terrain heights,
// textures, clouds, displacement). A permutation-table hash feeds gradient dot
// products blended by a quintic smoothstep — integer table lookups interleaved
// with loop-carried f64 interpolation, an ALU/memory mix distinct from the
// suite's other loops.
//
// Transcendental-free (+,-,*; no trig/pow), and the sample coordinates stay
// non-negative so Math.floor never straddles zero, so the field is bit-identical
// across engines and native targets. Go's arm64 auto-FMA of the lerp chains gives
// the documented `fma` parity class, like fft/synth.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Float64Array/Int32Array,
// Math.floor, no class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in samples/µs, FNV-1a checksum over
// the generated field.
package main

import (
	"fmt"
	"math"
	"time"
)

const (
	w       = 256
	h       = 256
	oct     = 5
	nRuns   = 21
	nWarmup = 5
)

func mix(hh, x uint32) uint32 { return (hh ^ x) * 0x01000193 }

func checksumF64(out []float64) uint32 {
	hh := uint32(0x811c9dc5)
	stride := 128
	for i := 0; i < len(out); i += stride {
		hh = mix(hh, uint32(math.Float64bits(out[i])))
	}
	return hh
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

func buildPerm(perm []int32) {
	for i := 0; i < 256; i++ {
		perm[i] = int32(i)
	}
	s := int32(0x1234abcd)
	for i := 255; i > 0; i-- {
		s ^= s << 13
		s ^= int32(uint32(s) >> 17)
		s ^= s << 5
		j := int(uint32(s) % uint32(i+1))
		perm[i], perm[j] = perm[j], perm[i]
	}
	for i := 0; i < 256; i++ {
		perm[256+i] = perm[i]
	}
}

func fade(t float64) float64 {
	return t * t * t * (t*(t*6.0-15.0) + 10.0)
}

func lerp(a, b, t float64) float64 {
	return a + t*(b-a)
}

func grad(hash int32, x, y float64) float64 {
	hh := hash & 3
	var u float64
	if hh&1 == 0 {
		u = x
	} else {
		u = -x
	}
	var v float64
	if hh&2 == 0 {
		v = y
	} else {
		v = -y
	}
	return u + v
}

func perlin(perm []int32, x, y float64) float64 {
	xi := math.Floor(x)
	yi := math.Floor(y)
	xf := x - xi
	yf := y - yi
	X := int32(xi) & 255
	Y := int32(yi) & 255
	u := fade(xf)
	v := fade(yf)
	aa := perm[perm[X]+Y]
	ab := perm[perm[X]+Y+1]
	ba := perm[perm[X+1]+Y]
	bb := perm[perm[X+1]+Y+1]
	x1 := lerp(grad(aa, xf, yf), grad(ba, xf-1.0, yf), u)
	x2 := lerp(grad(ab, xf, yf-1.0), grad(bb, xf-1.0, yf-1.0), u)
	return lerp(x1, x2, v)
}

func fbm(perm []int32, x, y float64) float64 {
	sum := 0.0
	amp := 0.5
	freq := 1.0
	for o := 0; o < oct; o++ {
		sum = sum + amp*perlin(perm, x*freq, y*freq)
		freq = freq * 2.0
		amp = amp * 0.5
	}
	return sum
}

func render(perm []int32, field []float64) {
	for py := 0; py < h; py++ {
		y := float64(py) * 0.03125
		for px := 0; px < w; px++ {
			x := float64(px) * 0.03125
			field[py*w+px] = fbm(perm, x, y)
		}
	}
}

func main() {
	perm := make([]int32, 512)
	buildPerm(perm)
	field := make([]float64, w*h)

	for i := 0; i < nWarmup; i++ {
		render(perm, field)
	}

	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		render(perm, field)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), checksumF64(field), w*h, oct, nRuns)
}
