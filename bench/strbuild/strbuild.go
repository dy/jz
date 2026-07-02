// strbuild.go — per-record string formatting: render each integer record as a
// CSV-ish line (`id,name,value\n`), fold its chars, discard. The canonical
// serialization inner loop (loggers, exporters, code generators, row writers).
// Go builds each line with strconv.Itoa + concat — the idiomatic mirror of the
// JS per-row string temporaries. Pure ASCII and integer data, so the folded
// chars are bit-identical across every engine and native target.
//
// Reports: median ms across N_RUNS, throughput in rows/µs, FNV-1a checksum
// over every formatted line's characters.
package main

import (
	"fmt"
	"strconv"
	"time"
)

const (
	n       = 4096 // rows per pass
	nIters  = 4    // passes per kernel run
	nRuns   = 21
	nWarmup = 5
)

var names = [16]string{"alpha", "bravo", "carol", "delta", "echo", "fox", "golf", "hotel",
	"india", "jazz", "kilo", "lima", "mike", "nova", "oscar", "papa"}

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

// Deterministic row stream — XorShift32, identical per target; low bits pick
// the name, the rest is the (signed) value column.
func fill(code, vals []int32) {
	s := int32(0x1234abcd)
	for i := 0; i < n; i++ {
		s ^= s << 13
		s ^= int32(uint32(s) >> 17)
		s ^= s << 5
		code[i] = s & 15
		vals[i] = s >> 4
	}
}

func runKernel(code, vals []int32) uint32 {
	h := uint32(0x811c9dc5)
	for it := 0; it < nIters; it++ {
		for i := 0; i < n; i++ {
			line := strconv.Itoa(i) + "," + names[code[i]] + "," + strconv.Itoa(int(vals[i]+int32(it))) + "\n"
			for j := 0; j < len(line); j++ {
				h = mix(h, uint32(line[j]))
			}
		}
	}
	return h
}

func main() {
	code := make([]int32, n)
	vals := make([]int32, n)
	fill(code, vals)

	var cs uint32
	for i := 0; i < nWarmup; i++ {
		cs = runKernel(code, vals)
	}

	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs = runKernel(code, vals)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, n*nIters, 3, nRuns)
}
