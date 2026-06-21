package main

import (
	"fmt"
	"time"
)

const (
	n       = 131072
	sr      = 44100
	hdr     = 44
	bytes_  = hdr + n*2
	nIters  = 16
	nRuns   = 21
	nWarmup = 5
)

func mix(h, x uint32) uint32 { return (h ^ x) * 0x01000193 }

func checksumU8(out []byte) uint32 {
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

func mkSamples(s []float64) {
	x := int32(0x1234abcd)
	for i := 0; i < n; i++ {
		x ^= x << 13
		x ^= int32(uint32(x) >> 17)
		x ^= x << 5
		s[i] = ((float64(uint32(x)) / 4294967296.0) * 2.0 - 1.0) * 1.2
	}
}

func writeU32(b []byte, off int, v uint32) {
	b[off] = byte(v & 0xff)
	b[off+1] = byte((v >> 8) & 0xff)
	b[off+2] = byte((v >> 16) & 0xff)
	b[off+3] = byte((v >> 24) & 0xff)
}

func writeU16(b []byte, off int, v uint32) {
	b[off] = byte(v & 0xff)
	b[off+1] = byte((v >> 8) & 0xff)
}

func encode(s []float64, count int, out []byte) {
	dataBytes := uint32(count * 2)
	out[0] = 82; out[1] = 73; out[2] = 70; out[3] = 70
	writeU32(out, 4, 36+dataBytes)
	out[8] = 87; out[9] = 65; out[10] = 86; out[11] = 69
	out[12] = 102; out[13] = 109; out[14] = 116; out[15] = 32
	writeU32(out, 16, 16)
	writeU16(out, 20, 1)
	writeU16(out, 22, 1)
	writeU32(out, 24, sr)
	writeU32(out, 28, sr*2)
	writeU16(out, 32, 2)
	writeU16(out, 34, 16)
	out[36] = 100; out[37] = 97; out[38] = 116; out[39] = 97
	writeU32(out, 40, dataBytes)
	op := hdr
	for i := 0; i < count; i++ {
		v := s[i] * 32767.0
		if v > 32767.0 {
			v = 32767.0
		} else if v < -32768.0 {
			v = -32768.0
		}
		u := uint32(int32(v) & 0xffff)
		out[op] = byte(u & 0xff)
		out[op+1] = byte((u >> 8) & 0xff)
		op += 2
	}
}

func runKernel(s []float64, out []byte) uint32 {
	h := uint32(0)
	for it := 0; it < nIters; it++ {
		encode(s, n, out)
		h = mix(h, checksumU8(out))
		j := it % n
		s[j] = -s[j]
	}
	return h
}

func main() {
	s := make([]float64, n)
	out := make([]byte, bytes_)
	mkSamples(s)
	cs := uint32(0)
	for i := 0; i < nWarmup; i++ {
		cs = runKernel(s, out)
	}
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs = runKernel(s, out)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, n*nIters, 1, nRuns)
}
