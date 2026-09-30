// gainclass.go — Go port of the unchanged JavaScript workload.
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

const nSamples = 65536
const nNodes = 8

type Gain struct {
	buf  []float64
	gain float64
}

func (g *Gain) process(input []float64) []float64 {
	for i := range g.buf {
		g.buf[i] = input[i] * g.gain
	}
	return g.buf
}
func render(input []float64, nodes []*Gain) []float64 {
	x := input
	for _, g := range nodes {
		x = g.process(x)
	}
	return x
}
func main() {
	input := make([]float64, nSamples)
	s := uint32(0x1234abcd)
	for i := range input {
		input[i] = float64(next(&s))/4294967296.0*2 - 1
	}
	nodes := make([]*Gain, nNodes)
	for k := range nodes {
		nodes[k] = &Gain{make([]float64, nSamples), 0.9 + float64(k)*0.01}
	}
	for i := 0; i < nWarmup; i++ {
		render(input, nodes)
	}
	samples := make([]float64, nRuns)
	out := input
	for i := range samples {
		t := time.Now()
		out = render(input, nodes)
		samples[i] = float64(time.Since(t).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n", medianUs(samples), checksum(out), nSamples, nNodes, nRuns)
}
