// levenshtein.go — Levenshtein edit distance via the rolling-row dynamic program.
// The canonical sequence-alignment / fuzzy-match kernel (spell-check, diff,
// bioinformatics, search): a 2-D DP whose every cell is min(delete, insert,
// substitute) over integers, with a diagonal data dependency that no target can
// vectorize — a branch- and min-reduction-heavy access pattern distinct from the
// suite's other loops. Pure 32-bit integer, so the distance is bit-identical
// across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Uint8Array/Int32Array, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in DP-cells/µs, FNV-1a checksum
// over the per-iteration distances.
package main

import (
	"fmt"
	"time"
)

const (
	lA      = 512
	lB      = 512
	alpha   = 8
	nIters  = 8
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

func fill(out []uint8, n int, seed uint32) {
	s := seed
	for i := 0; i < n; i++ {
		s ^= s << 13
		s ^= s >> 17
		s ^= s << 5
		out[i] = uint8(s % alpha)
	}
}

func levenshtein(a, b []uint8, prev []int32) int32 {
	for j := 0; j <= lB; j++ {
		prev[j] = int32(j)
	}
	for i := 1; i <= lA; i++ {
		diag := prev[0]
		prev[0] = int32(i)
		ai := a[i-1]
		for j := 1; j <= lB; j++ {
			up := prev[j]
			var cost int32
			if ai != b[j-1] {
				cost = 1
			}
			sub := diag + cost
			m := up + 1
			ins := prev[j-1] + 1
			if ins < m {
				m = ins
			}
			if sub < m {
				m = sub
			}
			diag = up
			prev[j] = m
		}
	}
	return prev[lB]
}

func runKernel(a, b []uint8, prev []int32) uint32 {
	h := uint32(0x811c9dc5)
	for it := 0; it < nIters; it++ {
		j := it % lA
		a[j] = (a[j] + 1) % alpha
		h = mix(h, uint32(levenshtein(a, b, prev)))
	}
	return h
}

func main() {
	a := make([]uint8, lA)
	b := make([]uint8, lB)
	prev := make([]int32, lB+1)
	fill(a, lA, 0x1234abcd)
	fill(b, lB, 0x9e3779b9)

	var cs uint32
	for i := 0; i < nWarmup; i++ {
		cs = runKernel(a, b, prev)
	}

	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs = runKernel(a, b, prev)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, lA*lB*nIters, 2, nRuns)
}
