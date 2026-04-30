package main

import (
	"fmt"
	"time"
)

const (
	n       = 65536
	nRounds = 128
	nRuns   = 21
	nWarmup = 5
)

func mix(h, x uint32) uint32 { return (h ^ x) * 0x01000193 }

func checksumU32(out []uint32) uint32 {
	h := uint32(0x811c9dc5)
	for i := 0; i < len(out); i += 128 {
		h = mix(h, out[i])
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

func initState(state []uint32) {
	s := uint32(0x1234abcd)
	for i := range state {
		s ^= s << 13
		s ^= s >> 17
		s ^= s << 5
		state[i] = s
	}
}

func runKernel(state []uint32) {
	for r := 0; r < nRounds; r++ {
		for i, x := range state {
			x ^= x << 7
			x ^= x >> 9
			x = x*1103515245 + 12345
			state[i] = x ^ (x >> 16)
		}
	}
}

func main() {
	state := make([]uint32, n)
	initState(state)
	for i := 0; i < nWarmup; i++ {
		initState(state)
		runKernel(state)
	}
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		initState(state)
		t0 := time.Now()
		runKernel(state)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), checksumU32(state), n*nRounds, 3, nRuns)
}
