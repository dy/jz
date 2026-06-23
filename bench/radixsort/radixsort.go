// radixsort.go — least-significant-digit radix sort (4 × 8-bit counting passes)
// over a u32 key array. The canonical non-comparison integer sort (databases,
// GPU/CPU key sorting, particle binning): histogram → prefix-sum → scatter,
// ping-ponging between two buffers. Its gather/scatter memory pattern is distinct
// from the suite's compare-swap heapsort, and it is pure 32-bit integer
// throughout, so the sorted output is bit-identical across every engine and
// native target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Uint32Array/Int32Array, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in keys/µs, FNV-1a checksum over
// the sorted key array.
package main

import (
	"fmt"
	"time"
)

const (
	n       = 1 << 14 // 16384 keys
	radix   = 256     // 8-bit digit
	passes  = 4       // 32-bit keys / 8-bit digits
	nIters  = 40      // sorts per kernel run
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

func checksumU32(out []uint32) uint32 {
	h := uint32(0x811c9dc5)
	stride := 128
	for i := 0; i < len(out); i += stride {
		h = mix(h, out[i])
	}
	return h
}

// Deterministic u32 keys — XorShift32, identical per target.
func fill(out []uint32) {
	s := uint32(0x1234abcd)
	for i := 0; i < n; i++ {
		s ^= s << 13
		s ^= s >> 17
		s ^= s << 5
		out[i] = s
	}
}

// LSD radix sort: 4 stable counting-sort passes over 8-bit digits, ping-ponging
// a → b. passes is even, so the sorted result lands back in src.
func radixSort(src, tmp []uint32, count []int32) {
	a, b := src, tmp
	for shift := uint(0); shift < 32; shift += 8 {
		for i := 0; i < radix; i++ {
			count[i] = 0
		}
		for i := 0; i < n; i++ {
			count[(a[i]>>shift)&0xff]++
		}
		var sum int32
		for i := 0; i < radix; i++ {
			c := count[i]
			count[i] = sum
			sum += c
		}
		for i := 0; i < n; i++ {
			d := (a[i] >> shift) & 0xff
			b[count[d]] = a[i]
			count[d]++
		}
		a, b = b, a
	}
}

func runKernel(a, base, tmp []uint32, count []int32) {
	for it := uint32(0); it < nIters; it++ {
		for i := 0; i < n; i++ {
			a[i] = base[i] + it
		}
		radixSort(a, tmp, count)
	}
}

func main() {
	base := make([]uint32, n)
	a := make([]uint32, n)
	tmp := make([]uint32, n)
	count := make([]int32, radix)
	fill(base)

	for i := 0; i < nWarmup; i++ {
		runKernel(a, base, tmp, count)
	}

	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		runKernel(a, base, tmp, count)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), checksumU32(a), n*nIters, passes, nRuns)
}
