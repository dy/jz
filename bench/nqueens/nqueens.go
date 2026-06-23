// nqueens.go — bitmask N-Queens solver, counting all solutions for a range of
// board sizes. The canonical backtracking / constraint-search kernel (the shape
// behind SAT solvers, puzzle search, combinatorial enumeration): deep recursion
// with a per-node branch over the available-columns bitmask, no array state. It
// stresses call/recursion codegen and branch prediction — a profile the suite's
// flat loops do not. Pure 32-bit integer, so the solution counts are
// bit-identical across every engine and native target.
//
// The board sizes are drawn from a runtime XorShift32 array rather than a literal
// loop bound: with literal sizes the whole recursion is a compile-time constant
// that clang/zig fold away (0 µs), making the native lane meaningless. Sourcing
// the size from runtime data is bit-identical across targets but forces every
// engine to actually run the search.
//
// Reports: median ms across N_RUNS, throughput in solutions/µs, FNV-1a checksum
// over the per-query solution counts.
package main

import (
	"fmt"
	"time"
)

const (
	nMin    = 8
	nSpan   = 4
	nQ      = 20
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

// fillSizes fills out with deterministic board sizes via XorShift32.
// Mirrors the JS: s = 0x1234abcd | 0 (int32), then XorShift32 steps,
// out[q] = NMIN + (s >>> 0) % NSPAN where s >>> 0 is the uint32 view.
func fillSizes(out []int32) {
	s := int32(0x1234abcd)
	for q := 0; q < nQ; q++ {
		s ^= s << 13
		s ^= int32(uint32(s) >> 17)
		s ^= s << 5
		out[q] = int32(nMin) + int32(uint32(s)%nSpan)
	}
}

// solve counts all placements that complete the board.
// cols/d1/d2 are occupied-column and the two diagonal masks;
// avail isolates the legal squares of the current row,
// b = avail & -avail walks them lowest-bit first.
func solve(all, cols, d1, d2 int32) int32 {
	if cols == all {
		return 1
	}
	var cnt int32
	avail := all & ^(cols | d1 | d2)
	for avail != 0 {
		b := avail & (-avail)
		avail = avail - b
		cnt = cnt + solve(all, cols|b, (d1|b)<<1, (d2|b)>>1)
	}
	return cnt
}

func countN(n int32) int32 {
	return solve((1<<n)-1, 0, 0, 0)
}

func runKernel(sizes []int32) uint32 {
	h := int32(-2128831035) // 0x811c9dc5 as int32 (2166136261 - 2^32)
	for q := 0; q < nQ; q++ {
		x := countN(sizes[q])
		h = int32(uint32(h^x) * 0x01000193)
	}
	return uint32(h)
}

func main() {
	sizes := make([]int32, nQ)
	fillSizes(sizes)

	var total int32
	for q := 0; q < nQ; q++ {
		total += countN(sizes[q])
	}

	var cs uint32
	for i := 0; i < nWarmup; i++ {
		cs = runKernel(sizes)
	}
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs = runKernel(sizes)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, total, nMin+nSpan-1, nRuns)
}
