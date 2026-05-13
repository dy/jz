package main

import (
	"fmt"
	"time"
)

const (
	n       = 16384
	nIters  = 220
	nRuns   = 21
	nWarmup = 5
)

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

func buildTable(table []uint32) {
	for n := uint32(0); n < 256; n++ {
		c := n
		for k := 0; k < 8; k++ {
			if c&1 != 0 {
				c = 0xedb88320 ^ (c >> 1)
			} else {
				c >>= 1
			}
		}
		table[n] = c
	}
}

func initBuf(buf []byte) {
	x := uint32(0x12345678)
	for i := range buf {
		x = x*1103515245 + 12345
		buf[i] = byte((x >> 16) & 0xff)
	}
}

func crc32Kernel(buf []byte, table []uint32) uint32 {
	c := uint32(0xffffffff)
	for _, b := range buf {
		c = table[(c^uint32(b))&0xff] ^ (c >> 8)
	}
	return c ^ 0xffffffff
}

func runKernel(buf []byte, table []uint32) uint32 {
	h := uint32(0)
	for it := 0; it < nIters; it++ {
		h = mix(h, crc32Kernel(buf, table))
		j := it % n
		buf[j] = (buf[j] + 1) & 0xff
	}
	return h
}

func main() {
	buf := make([]byte, n)
	table := make([]uint32, 256)
	buildTable(table)
	initBuf(buf)
	cs := uint32(0)
	for i := 0; i < nWarmup; i++ {
		cs = runKernel(buf, table)
	}
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs = runKernel(buf, table)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, n*nIters, 1, nRuns)
}
