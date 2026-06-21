package main

import (
	"fmt"
	"time"
)

const (
	n       = 16384
	nIters  = 700
	nRuns   = 21
	nWarmup = 5
)

const c1 uint32 = 0xcc9e2d51
const c2 uint32 = 0x1b873593

func mix(h, x uint32) uint32 { return (h ^ x) * 0x01000193 }

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

func initBuf(buf []byte) {
	x := int32(0x12345678)
	for i := range buf {
		x = x*1103515245 + 12345
		buf[i] = byte((uint32(x) >> 16) & 0xff)
	}
}

func murmur3(buf []byte, bLen int, seed uint32) uint32 {
	h := int32(seed)
	for i := 0; i+4 <= bLen; i += 4 {
		k := int32(uint32(buf[i]) | uint32(buf[i+1])<<8 | uint32(buf[i+2])<<16 | uint32(buf[i+3])<<24)
		k = int32(uint32(k) * c1)
		k = int32(uint32(k)<<15 | uint32(k)>>17)
		k = int32(uint32(k) * c2)
		h ^= k
		h = int32(uint32(h)<<13 | uint32(h)>>19)
		h = int32(uint32(h)*5 + 0xe6546b64)
	}
	h ^= int32(bLen)
	uh := uint32(h)
	uh ^= uh >> 16
	uh *= 0x85ebca6b
	uh ^= uh >> 13
	uh *= 0xc2b2ae35
	uh ^= uh >> 16
	return uh
}

func runKernel(buf []byte) uint32 {
	h := uint32(0)
	for it := 0; it < nIters; it++ {
		mr := murmur3(buf, n, 0x9747b28c)
		h = mix(h, mr)
		j := it % n
		buf[j] = (buf[j] + 1) & 0xff
	}
	return h
}

func main() {
	buf := make([]byte, n)
	initBuf(buf)
	cs := uint32(0)
	for i := 0; i < nWarmup; i++ {
		cs = runKernel(buf)
	}
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs = runKernel(buf)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, n*nIters, 1, nRuns)
}
