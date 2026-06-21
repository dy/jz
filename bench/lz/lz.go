package main

import (
	"fmt"
	"time"
)

const (
	n        = 4096
	window   = 1024
	minMatch = 3
	maxMatch = 18
	cap_     = n*2 + 64
	nIters   = 5
	nRuns    = 21
	nWarmup  = 5
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

func initBuf(buf []byte) {
	x := int32(0x12345678)
	for i := 0; i < n; i++ {
		x = x*1103515245 + 12345
		if i > 64 && (x&0x70) == 0 {
			back := 1 + int(uint32(x)>>8&63)
			buf[i] = buf[i-back]
		} else {
			buf[i] = byte(uint32(x) >> 16 & 0xff)
		}
	}
}

func compress(src []byte, nn int, out []byte) int {
	op, ip := 0, 0
	for ip < nn {
		ctrlPos := op
		op++
		ctrl := byte(0)
		for b := 0; b < 8 && ip < nn; b++ {
			start := ip - window
			if start < 0 {
				start = 0
			}
			maxLen := nn - ip
			if maxLen > maxMatch {
				maxLen = maxMatch
			}
			bestLen, bestDist := 0, 0
			for j := ip - 1; j >= start; j-- {
				l := 0
				for l < maxLen && src[j+l] == src[ip+l] {
					l++
				}
				if l > bestLen {
					bestLen = l
					bestDist = ip - j
					if l >= maxLen {
						break
					}
				}
			}
			if bestLen >= minMatch {
				ctrl |= byte(1 << b)
				code := uint32((bestDist-1)<<4) | uint32(bestLen-minMatch)
				out[op] = byte(code >> 8 & 0xff)
				out[op+1] = byte(code & 0xff)
				op += 2
				ip += bestLen
			} else {
				out[op] = src[ip]
				op++
				ip++
			}
		}
		out[ctrlPos] = ctrl
	}
	return op
}

func inflate(inp []byte, clen int, dst []byte) int {
	ip, op := 0, 0
	for ip < clen {
		ctrl := inp[ip]
		ip++
		for b := 0; b < 8 && ip < clen; b++ {
			if ctrl&byte(1<<b) != 0 {
				code := uint32(inp[ip])<<8 | uint32(inp[ip+1])
				ip += 2
				dist := int(code>>4) + 1
				l := int(code&0x0f) + minMatch
				for k := 0; k < l; k++ {
					dst[op] = dst[op-dist]
					op++
				}
			} else {
				dst[op] = inp[ip]
				op++
				ip++
			}
		}
	}
	return op
}

func runKernel(src []byte, comp []byte, dec []byte) uint32 {
	h := uint32(0)
	for it := 0; it < nIters; it++ {
		clen := compress(src, n, comp)
		dlen := inflate(comp, clen, dec)
		ok := uint32(0)
		if dlen == n {
			ok = 1
		}
		for i := 0; i < n; i++ {
			if dec[i] != src[i] {
				ok = 0
			}
		}
		h = mix(h, uint32(clen))
		for i := 0; i < clen; i++ {
			h = mix(h, uint32(comp[i]))
		}
		h = mix(h, ok)
		j := it % n
		src[j] = (src[j] + 1) & 0xff
	}
	return h
}

func main() {
	src := make([]byte, n)
	comp := make([]byte, cap_)
	dec := make([]byte, n)
	initBuf(src)
	cs := uint32(0)
	for i := 0; i < nWarmup; i++ {
		cs = runKernel(src, comp, dec)
	}
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs = runKernel(src, comp, dec)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, n*nIters, 1, nRuns)
}
