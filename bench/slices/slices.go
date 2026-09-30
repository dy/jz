// slices.go — Go port of the unchanged JavaScript workload.
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

const n = 1 << 18
const nb = 4096
const nIters = 3

func buildWorld(input, bus []float64, inOff, busOff, length []int32) {
	s := uint32(0x2f6e2b1)
	for i := range input {
		input[i] = float64(next(&s))/4294967296.0*2 - 1
	}
	for i := range bus {
		bus[i] = 0
	}
	for b := 0; b < nb; b++ {
		l := 64 + int(next(&s)%257)
		length[b] = int32(l)
		inOff[b] = int32(next(&s) % uint32(n-l))
		busOff[b] = int32(next(&s) % uint32(n-l))
	}
}
func runPass(input, bus []float64, inOff, busOff, length []int32, gain float64) {
	for b := 0; b < nb; b++ {
		io, bo, l := inOff[b], busOff[b], length[b]
		sm := 0.0
		for i := int32(0); i < l; i++ {
			sm = sm*0.995 + input[io+i]*0.005
			bus[bo+i] = bus[bo+i] + sm*gain
		}
	}
}
func runKernel(input, bus []float64, inOff, busOff, length []int32) {
	for it := 0; it < nIters; it++ {
		runPass(input, bus, inOff, busOff, length, 0.25+float64(it)*0.125)
	}
}
func main() {
	input, bus := make([]float64, n), make([]float64, n)
	inOff, busOff, length := make([]int32, nb), make([]int32, nb), make([]int32, nb)
	buildWorld(input, bus, inOff, busOff, length)
	for i := 0; i < nWarmup; i++ {
		runKernel(input, bus, inOff, busOff, length)
	}
	samples := make([]float64, nRuns)
	for i := range samples {
		t := time.Now()
		runKernel(input, bus, inOff, busOff, length)
		samples[i] = float64(time.Since(t).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n", medianUs(samples), checksum(bus), nb*nIters, nIters, nRuns)
}
