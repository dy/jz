package main

import (
	"fmt"
	"time"
)

const (
	w        = 256
	h        = 256
	maxIter  = 256
	nRuns    = 21
	nWarmup  = 5
	x0       = -2.0
	x1       = 0.5
	y0       = -1.25
	y1       = 1.25
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

func checksumU32(xs []uint32) uint32 {
	h := uint32(0x811c9dc5)
	for i := 0; i < len(xs); i += 128 {
		h = mix(h, xs[i])
	}
	return h
}

func render(out []uint32) {
	dx := (x1 - x0) / float64(w)
	dy := (y1 - y0) / float64(h)
	for py := 0; py < h; py++ {
		cy := y0 + float64(py)*dy
		for px := 0; px < w; px++ {
			cx := x0 + float64(px)*dx
			var zx, zy float64
			i := 0
			for i < maxIter {
				x2 := zx * zx
				y2 := zy * zy
				if x2+y2 > 4.0 {
					break
				}
				zy = 2*zx*zy + cy
				zx = x2 - y2 + cx
				i++
			}
			out[py*w+px] = uint32(i)
		}
	}
}

func main() {
	out := make([]uint32, w*h)

	for i := 0; i < nWarmup; i++ {
		render(out)
	}
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		render(out)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), checksumU32(out), w*h, maxIter, nRuns)
}
