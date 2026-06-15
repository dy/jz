// alpha.go — alpha compositing (constant-opacity blend). Bit-identical to alpha.js.
package main

import (
	"fmt"
	"time"
)

const (
	W        = 512
	H        = 512
	N        = W * H * 4
	A        = 160
	IA       = 255 - A
	N_RUNS   = 21
	N_WARMUP = 5
)

func mix(h, x uint32) uint32 { return (h ^ x) * 0x01000193 }

func checksumU8(out []uint8) uint32 {
	h := uint32(0x811c9dc5)
	for _, b := range out {
		h = mix(h, uint32(b))
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

func mkImage(out []uint8, seed uint32) {
	s := seed
	for i := range out {
		s ^= s << 13
		s ^= s >> 17
		s ^= s << 5
		out[i] = uint8(s & 255)
	}
}

func blend(src, dst, out []uint8) {
	for i := 0; i < N; i++ {
		out[i] = uint8((int(src[i])*A + int(dst[i])*IA + 127) >> 8)
	}
}

func main() {
	src := make([]uint8, N)
	dst := make([]uint8, N)
	out := make([]uint8, N)
	mkImage(src, 0x1234abcd)
	mkImage(dst, 0x7e1f93b5)

	for i := 0; i < N_WARMUP; i++ {
		blend(src, dst, out)
	}
	samples := make([]float64, N_RUNS)
	for i := 0; i < N_RUNS; i++ {
		t0 := time.Now()
		blend(src, dst, out)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), checksumU8(out), N, 1, N_RUNS)
}
