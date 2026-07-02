// shapes.go — a per-variant measure summed over records of 8 heterogeneous
// shapes, in data-shuffled order. The canonical shape-polymorphism kernel
// (JSON rows, AST nodes, ECS entities, event streams). Go's idiomatic answer
// to heterogeneous records is a kind-tagged flat record + branch — the static
// reference for what the dynamic-shape JS source costs. Pure 32-bit integer
// fields, so the sum is bit-identical across every engine and native target.
//
// Reports: median ms across N_RUNS, throughput in records/µs, FNV-1a checksum
// over the per-pass sums.
package main

import (
	"fmt"
	"time"
)

const (
	n       = 1 << 14 // records
	nShapes = 8       // distinct record shapes
	nIters  = 48      // record-stream passes per kernel run
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

// Kind-tagged record; payload fields map positionally per variant:
//
//	0 point  a=x  b=y            1 circle a=r
//	2 rect   a=w  b=h            3 line   a=x0 b=y0 c=x1 d=y1
//	4 tri    a b c               5 prism  a=w  b=h  c=d
//	6 arc    a=r  b=s            7 poly   a=n  b=s
type rec struct{ k, a, b, c, d int32 }

// Deterministic heterogeneous record stream — XorShift32 picks each record's
// variant and integer fields (masked small, so every product stays exact i32).
func initRows(rows []rec) {
	s := int32(0x1234abcd)
	for i := 0; i < n; i++ {
		s ^= s << 13
		s ^= int32(uint32(s) >> 17)
		s ^= s << 5
		u := uint32(s)
		k := s & (nShapes - 1)
		a, b, c := int32((u>>3)&1023), int32((u>>13)&1023), int32((u>>23)&511)
		r := rec{k: k}
		if k == 0 {
			r.a, r.b = a, b
		} else if k == 1 {
			r.a = a
		} else if k == 2 {
			r.a, r.b = a, b
		} else if k == 3 {
			r.a, r.b, r.c, r.d = a, b, c, (a^b)&511
		} else if k == 4 {
			r.a, r.b, r.c = a, b, c
		} else if k == 5 {
			r.a, r.b, r.c = a, b, c
		} else if k == 6 {
			r.a, r.b = a, b
		} else {
			r.a, r.b = c, b
		}
		rows[i] = r
	}
}

// One measure per variant — mirrors shapes.js measure() exactly.
func measure(o *rec) int32 {
	k := o.k
	if k == 0 {
		return o.a + o.b
	} else if k == 1 {
		return o.a * (o.a * 3)
	} else if k == 2 {
		return o.a * o.b
	} else if k == 3 {
		dx, dy := o.c-o.a, o.d-o.b
		if dx < 0 {
			dx = -dx
		}
		if dy < 0 {
			dy = -dy
		}
		return dx + dy
	} else if k == 4 {
		return o.a + o.b + o.c
	} else if k == 5 {
		return o.a*o.b - o.c
	} else if k == 6 {
		return o.a*o.b + o.a
	}
	return o.a * (o.b * o.b)
}

func runKernel(rows []rec) uint32 {
	h := uint32(0x811c9dc5)
	for it := 0; it < nIters; it++ {
		sum := int32(it)
		for i := 0; i < n; i++ {
			sum = int32(uint32(sum) + uint32(measure(&rows[i])))
		}
		h = mix(h, uint32(sum))
	}
	return h
}

func main() {
	rows := make([]rec, n)
	initRows(rows)

	var cs uint32
	for i := 0; i < nWarmup; i++ {
		cs = runKernel(rows)
	}

	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs = runKernel(rows)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, n*nIters, nShapes, nRuns)
}
