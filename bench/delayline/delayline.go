// delayline.go — Go port of the unchanged JavaScript workload.
package main

import (
	"fmt"
	"math"
	"time"
)

const nRuns = 21
const nWarmup = 5

func next(s *uint32) uint32  { *s ^= *s << 13; *s ^= *s >> 17; *s ^= *s << 5; return *s }
func mix(h, x uint32) uint32 { return (h ^ x) * 0x01000193 }
func checksum(out []float64) uint32 {
	h := uint32(0x811c9dc5)
	for i := 0; i < len(out)*2; i += 256 {
		h = mix(h, uint32(math.Float64bits(out[i/2])>>uint((i&1)*32)))
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
	return uint64(samples[(len(samples)-1)>>1] * 1000)
}

const n = 1 << 17
const rb = 1 << 14
const mask = rb - 1
const nIters = 4

func runPass(input, out, ring []float64, fb float64, lfoStep uint32) {
	for i := range ring {
		ring[i] = 0
	}
	head, lfo := uint32(0), uint32(0)
	for i := 0; i < n; i++ {
		lfo += lfoStep
		raw := lfo & 0x1ffff
		tri := raw
		if raw >= 0x10000 {
			tri = 0x20000 - raw
		}
		dq := uint32(96*65536) + tri*2000
		dInt := dq / 65536
		dFrac := float64(dq-dInt*65536) / 65536.0
		i0, i1 := (head-dInt)&mask, (head-dInt-1)&mask
		tap := ring[i0] + (ring[i1]-ring[i0])*dFrac
		y := input[i] + tap*fb
		ring[head&mask] = y
		head++
		out[i] = y
	}
}
func runKernel(input, out, ring []float64) {
	for it := 0; it < nIters; it++ {
		runPass(input, out, ring, 0.6+float64(it)*0.05, 977+uint32(it)*131)
	}
}
func main() {
	input, out, ring := make([]float64, n), make([]float64, n), make([]float64, rb)
	s := uint32(0x3c91e57)
	for i := range input {
		input[i] = float64(next(&s))/4294967296.0*2 - 1
	}
	for i := 0; i < nWarmup; i++ {
		runKernel(input, out, ring)
	}
	samples := make([]float64, nRuns)
	for i := range samples {
		t := time.Now()
		runKernel(input, out, ring)
		samples[i] = float64(time.Since(t).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n", medianUs(samples), checksum(out), n*nIters, nIters, nRuns)
}
