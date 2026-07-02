// wordcount.go — token-frequency counting into a string-keyed hash map, over a
// skewed synthetic word stream. The canonical associative text kernel (word
// counts, tag/label histograms, group-by aggregation). Go's idiomatic answer
// is map[string]int32 — the static reference for what the dynamic-keyed JS
// object costs. Counts are exact integers, so the probed totals are
// bit-identical across every engine and native target.
//
// Reports: median ms across N_RUNS, throughput in tokens/µs, FNV-1a checksum
// over the probed counts.
package main

import (
	"fmt"
	"strconv"
	"time"
)

const (
	nWords  = 512     // distinct words in the vocabulary
	n       = 1 << 14 // tokens per pass
	nProbes = 64      // fixed lookups folded into the checksum
	nIters  = 16      // passes per kernel run
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

// Deterministic vocabulary — 512 words of 3–8 lowercase chars from XorShift32,
// identical per target.
func buildWords() []string {
	words := make([]string, nWords)
	s := int32(0x1234abcd)
	for i := 0; i < nWords; i++ {
		s ^= s << 13
		s ^= int32(uint32(s) >> 17)
		s ^= s << 5
		length := 3 + int((uint32(s)>>8)%6)
		buf := make([]byte, length)
		x := s
		for j := 0; j < length; j++ {
			x = int32(uint32(x)*0x9e3779b1 + uint32(j))
			buf[j] = byte(97 + (uint32(x)>>16)%26)
		}
		words[i] = string(buf)
	}
	return words
}

// Skewed token stream — half the traffic hits 16 hot words (Zipf-ish),
// the rest spreads over the whole vocabulary.
func fillTokens(toks []int32) {
	s := int32(0x2545f491)
	for i := 0; i < n; i++ {
		s ^= s << 13
		s ^= int32(uint32(s) >> 17)
		s ^= s << 5
		if s&8 == 0 {
			toks[i] = int32((uint32(s) >> 4) & 15)
		} else {
			toks[i] = int32((uint32(s) >> 4) & (nWords - 1))
		}
	}
}

func runKernel(words []string, toks []int32, probes []string) uint32 {
	h := uint32(0x811c9dc5)
	for it := 0; it < nIters; it++ {
		counts := make(map[string]int32)
		for _, t := range toks {
			counts[words[t]]++
		}
		for _, p := range probes {
			h = mix(h, uint32(counts[p]))
		}
	}
	return h
}

func main() {
	words := buildWords()
	toks := make([]int32, n)
	fillTokens(toks)
	// Probe every 8th word plus 8 absent keys — a missing count reads 0.
	probes := make([]string, 0, nProbes)
	for j := 0; j < nProbes-8; j++ {
		probes = append(probes, words[(j*8)&(nWords-1)])
	}
	for j := 0; j < 8; j++ {
		probes = append(probes, "zz"+strconv.Itoa(j))
	}

	var cs uint32
	for i := 0; i < nWarmup; i++ {
		cs = runKernel(words, toks, probes)
	}

	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs = runKernel(words, toks, probes)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, n*nIters, nWords, nRuns)
}
