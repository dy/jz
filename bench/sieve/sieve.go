// sieve.go — Sieve of Eratosthenes over a byte array up to LIMIT. The canonical
// number-theory / enumeration kernel: for each prime, a strided inner loop writes
// a composite flag at i², i²+i, i²+2i, … The access pattern is pure strided
// scatter guarded by an outer branch (skip already-composite i), a memory profile
// distinct from the suite's dense contiguous loops. Pure integer, so the sieved
// bitmap is bit-identical across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Uint8Array, no class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in numbers/µs, FNV-1a checksum over
// the composite bitmap.
package main

import (
	"fmt"
	"time"
)

const (
	limit   = 1 << 20 // sieve [0, ~1M)
	nIters  = 6       // sieves per kernel run
	nRuns   = 21
	nWarmup = 5
)

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

func sieve(comp []byte) {
	for i := 0; i < limit; i++ {
		comp[i] = 0
	}
	comp[0] = 1
	comp[1] = 1
	for i := 2; i*i < limit; i++ {
		if comp[i] == 0 {
			for j := i * i; j < limit; j += i {
				comp[j] = 1
			}
		}
	}
}

func runKernel(comp []byte) {
	for it := 0; it < nIters; it++ {
		sieve(comp)
	}
}

func checksumU8(comp []byte) uint32 {
	h := uint32(0x811c9dc5)
	for i := 0; i < len(comp); i++ {
		h = (h ^ uint32(comp[i])) * 0x01000193
	}
	return h
}

func main() {
	comp := make([]byte, limit)
	for i := 0; i < nWarmup; i++ {
		runKernel(comp)
	}
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		runKernel(comp)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	cs := checksumU8(comp)
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, limit*nIters, 1, nRuns)
}
