// dict.go — open-addressing hash table (build + probe) with linear probing. The
// canonical associative-container kernel (symbol tables, dedup, joins, counting):
// a multiply-shift hash scatters keys across a power-of-two slot array, and every
// insert/lookup walks a probe chain of branchy comparisons. It stresses
// scatter writes, dependent-load gather, and unpredictable branches — the
// hash-table shape no other case in the suite covers. Pure 32-bit integer, so the
// looked-up values are bit-identical across every engine and native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Int32Array, Math.imul, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in ops/µs, FNV-1a checksum over
// the probe results.
package main

import (
	"fmt"
	"time"
)

const (
	cap_    = 1 << 14
	mask    = cap_ - 1
	nkeys   = cap_ >> 1
	empty   = -1
	nIters  = 60
	nRuns   = 21
	nWarmup = 5
)

func mix(h, x int32) int32 { return int32(uint32(h^x) * 0x01000193) }

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

func fill(out []int32) {
	s := int32(0x1234abcd)
	for i := 0; i < nkeys; i++ {
		s ^= s << 13
		s ^= int32(uint32(s) >> 17)
		s ^= s << 5
		out[i] = int32(uint32(s) & 0x7fffffff)
	}
}

func hash(k int32) int32 {
	return int32(uint32(int32(uint32(k)*0x9e3779b1)) & mask)
}

func insert(keys, vals []int32, k, v int32) {
	h := hash(k)
	for keys[h] != empty {
		if keys[h] == k {
			vals[h] = v
			return
		}
		h = (h + 1) & mask
	}
	keys[h] = k
	vals[h] = v
}

func lookup(keys, vals []int32, k int32) int32 {
	h := hash(k)
	for keys[h] != empty {
		if keys[h] == k {
			return vals[h]
		}
		h = (h + 1) & mask
	}
	return -1
}

func runKernel(keys, vals, src []int32) uint32 {
	h := int32(-2128831035) // 0x811c9dc5 | 0 as signed i32
	for it := 0; it < nIters; it++ {
		for i := 0; i < cap_; i++ {
			keys[i] = empty
		}
		for i := 0; i < nkeys; i++ {
			insert(keys, vals, src[i], int32(int32(src[i])+int32(it)))
		}
		for i := 0; i < nkeys; i++ {
			v := lookup(keys, vals, src[(i*7)&(nkeys-1)])
			h = mix(h, v)
		}
	}
	return uint32(h)
}

func main() {
	keys := make([]int32, cap_)
	vals := make([]int32, cap_)
	src := make([]int32, nkeys)
	fill(src)

	var cs uint32
	for i := 0; i < nWarmup; i++ {
		cs = runKernel(keys, vals, src)
	}
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs = runKernel(keys, vals, src)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, nkeys*nIters, 2, nRuns)
}
