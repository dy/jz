package main

import (
	"fmt"
	"time"
)

const (
	n       = 1 << 21
	nRuns   = 21
	nWarmup = 5
)

func mix(h, x uint32) uint32 { return (h ^ x) * 0x01000193 }

func checksumU8(out []uint8) uint32 {
	h := uint32(0x811c9dc5)
	for _, b := range out {
		h = mix(h, uint32(b))
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

// Go binds *, <<, >>, & at the same (highest) precedence, unlike C/JS — so the
// voice groupings are parenthesized explicitly to match the JS source's meaning.
func sample(t uint32) uint32 {
	v1 := ((t * 5) & (t >> 7)) | ((t * 3) & (t >> 10))
	v2 := t * (((t >> 12) | (t >> 8)) & (63 & (t >> 4)))
	return (v1 + v2) & 255
}

func render(buf []uint8) {
	for t := range buf {
		buf[t] = uint8(sample(uint32(t)))
	}
}

func main() {
	buf := make([]uint8, n)
	for i := 0; i < nWarmup; i++ {
		render(buf)
	}
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		render(buf)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), checksumU8(buf), n, 1, nRuns)
}
