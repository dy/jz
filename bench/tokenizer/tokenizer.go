package main

import (
	"fmt"
	"strings"
	"time"
)

const (
	base    = "let alpha_12 = beta + 12345; if (alpha_12 >= 99) { total = total + alpha_12; }\n"
	nRepeat = 512
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

func isAlpha(c byte) bool {
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_'
}

func scan(src string) uint32 {
	h := uint32(0x811c9dc5)
	number := uint32(0)
	inNumber := false
	inIdent := false
	tokens := uint32(0)
	for i := 0; i < len(src); i++ {
		c := src[i]
		if c >= '0' && c <= '9' {
			number = number*10 + uint32(c-'0')
			inNumber = true
		} else {
			if inNumber {
				h = mix(h, number)
				tokens++
				number = 0
				inNumber = false
			}
			if isAlpha(c) {
				if !inIdent {
					h = mix(h, uint32(c))
					tokens++
				}
				inIdent = true
			} else {
				if c > 32 {
					h = mix(h, uint32(c))
					tokens++
				}
				inIdent = false
			}
		}
	}
	if inNumber {
		h = mix(h, number)
		tokens++
	}
	return mix(h, tokens)
}

func main() {
	src := strings.Repeat(base, nRepeat)
	cs := uint32(0)
	for i := 0; i < nWarmup; i++ {
		cs = scan(src)
	}
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs = scan(src)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, len(src), 5, nRuns)
}
