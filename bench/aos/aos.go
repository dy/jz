package main

import (
	"fmt"
	"math"
	"time"
)

const (
	n       = 16384
	nIters  = 64
	nRuns   = 21
	nWarmup = 5
)

type Row struct {
	x float64
	y float64
	z float64
}

func mix(h, x uint32) uint32 { return (h ^ x) * 0x01000193 }

func checksumF64(out []float64) uint32 {
	h := uint32(0x811c9dc5)
	for i := 0; i < len(out)*2; i += 256 {
		bits := math.Float64bits(out[i/2])
		if i&1 == 0 {
			h = mix(h, uint32(bits))
		} else {
			h = mix(h, uint32(bits>>32))
		}
	}
	return h
}

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

func initRows(rows []Row) {
	for i := range rows {
		rows[i] = Row{
			x: float64(i) * 0.5,
			y: float64(i) + 1,
			z: float64((i & 7) - 3),
		}
	}
}

func runKernel(rows []Row, xs, ys, zs []float64) {
	for r := 0; r < nIters; r++ {
		rf := float64(r)
		for i, p := range rows {
			xs[i] = p.x + p.y*0.25 + rf
			ys[i] = p.y - p.z*0.5
			zs[i] = p.z + p.x*0.125
		}
	}
}

func main() {
	rows := make([]Row, n)
	xs := make([]float64, n)
	ys := make([]float64, n)
	zs := make([]float64, n)
	samples := make([]float64, nRuns)
	initRows(rows)
	for i := 0; i < nWarmup; i++ {
		runKernel(rows, xs, ys, zs)
	}
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		runKernel(rows, xs, ys, zs)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	cs := checksumF64(xs) ^ checksumF64(ys) ^ checksumF64(zs)
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, n*nIters, 3, nRuns)
}
