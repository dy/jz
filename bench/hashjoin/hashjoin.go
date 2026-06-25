// hashjoin.go — probe-dominated relational hash join (build a hash table on a small
// "build" relation, then stream a large "probe" relation through it and sum matched
// payloads). The kernel at the heart of every database and dataframe engine. Pure
// 32-bit integer — the matched-payload sum is bit-identical across every engine and
// native target.
//
// Reports: median ms across N_RUNS, throughput in probes/µs, FNV-1a checksum over
// the per-pass match sums.
package main

import (
	"fmt"
	"time"
)

const (
	cap_    = 1 << 14
	mask    = cap_ - 1
	build_  = cap_ >> 1
	probe_  = 1 << 16
	empty   = -1
	nIters  = 24
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

func fill(out []int32, seed int32) {
	s := seed
	for i := 0; i < len(out); i++ {
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

func probe(keys, vals []int32, k int32) int32 {
	h := hash(k)
	for keys[h] != empty {
		if keys[h] == k {
			return vals[h]
		}
		h = (h + 1) & mask
	}
	return 0
}

func runKernel(keys, vals, build, probes []int32) uint32 {
	h := int32(-2128831035) // 0x811c9dc5 | 0 as signed i32
	for it := 0; it < nIters; it++ {
		for i := 0; i < cap_; i++ {
			keys[i] = empty
		}
		for i := 0; i < build_; i++ {
			insert(keys, vals, build[i], int32(int32(build[i])+int32(it)))
		}
		var sum int32 = 0
		for i := 0; i < probe_; i++ {
			sum = int32(uint32(sum) + uint32(probe(keys, vals, probes[i])))
		}
		h = mix(h, sum)
	}
	return uint32(h)
}

func main() {
	keys := make([]int32, cap_)
	vals := make([]int32, cap_)
	build := make([]int32, build_)
	probes := make([]int32, probe_)
	fill(build, int32(0x1234abcd))
	var pseed uint32 = 0x9e3779b9 // runtime conv wraps to signed; const conv would overflow int32
	fill(probes, int32(pseed))
	for i := 0; i < probe_; i += 2 {
		probes[i] = build[(i>>1)&(build_-1)]
	}

	var cs uint32
	for i := 0; i < nWarmup; i++ {
		cs = runKernel(keys, vals, build, probes)
	}
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs = runKernel(keys, vals, build, probes)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, probe_*nIters, 2, nRuns)
}
