package main

import (
	"fmt"
	"time"
)

const (
	n       = 24576
	encLen  = (n / 3) * 4
	nIters  = 64
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

func buildEnc(enc []byte) {
	i := 0
	for c := 65; c <= 90; c++ {
		enc[i] = byte(c)
		i++
	}
	for c := 97; c <= 122; c++ {
		enc[i] = byte(c)
		i++
	}
	for c := 48; c <= 57; c++ {
		enc[i] = byte(c)
		i++
	}
	enc[i] = 43
	i++
	enc[i] = 47
}

func buildDec(enc, dec []byte) {
	for i := 0; i < 256; i++ {
		dec[i] = 0
	}
	for i := 0; i < 64; i++ {
		dec[enc[i]] = byte(i)
	}
}

func initBuf(buf []byte) {
	x := int32(0x12345678)
	for i := range buf {
		x = int32(uint32(x)*1103515245) + 12345
		buf[i] = byte((uint32(x) >> 16) & 0xff)
	}
}

func checksumU8(xs []byte) uint32 {
	h := uint32(0x811c9dc5)
	for _, b := range xs {
		h = (h ^ uint32(b)) * 0x01000193
	}
	return h
}

func encode(src []byte, enc []byte, out []byte) int {
	op := 0
	for i := 0; i+3 <= n; i += 3 {
		a, b, c := src[i], src[i+1], src[i+2]
		out[op] = enc[a>>2]
		out[op+1] = enc[((a&3)<<4)|(b>>4)]
		out[op+2] = enc[((b&15)<<2)|(c>>6)]
		out[op+3] = enc[c&63]
		op += 4
	}
	return op
}

func decode(src []byte, dec []byte, out []byte) int {
	op := 0
	for i := 0; i+4 <= encLen; i += 4 {
		a := dec[src[i]]
		b := dec[src[i+1]]
		c := dec[src[i+2]]
		d := dec[src[i+3]]
		out[op] = byte(((uint32(a) << 2) | (uint32(b) >> 4)) & 0xff)
		out[op+1] = byte(((uint32(b)&15)<<4 | (uint32(c) >> 2)) & 0xff)
		out[op+2] = byte(((uint32(c)&3)<<6 | uint32(d)) & 0xff)
		op += 3
	}
	return op
}

func runKernel(src []byte, enc, dec []byte, b64, back []byte) uint32 {
	h := uint32(0)
	for it := 0; it < nIters; it++ {
		encode(src, enc, b64)
		decode(b64, dec, back)
		ok := uint32(1)
		for i := 0; i < n; i++ {
			if back[i] != src[i] {
				ok = 0
			}
		}
		csB64 := checksumU8(b64)
		h = mix(mix(h, csB64), ok)
		j := it % n
		src[j] = (src[j] + 1) & 0xff
	}
	return h
}

func main() {
	src := make([]byte, n)
	enc := make([]byte, 64)
	dec := make([]byte, 256)
	b64 := make([]byte, encLen)
	back := make([]byte, n)
	buildEnc(enc)
	buildDec(enc, dec)
	initBuf(src)
	cs := uint32(0)
	for i := 0; i < nWarmup; i++ {
		cs = runKernel(src, enc, dec, b64, back)
	}
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs = runKernel(src, enc, dec, b64, back)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, n*nIters, 1, nRuns)
}
