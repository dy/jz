// trace.go — Go port of the unchanged JavaScript workload.
package main

import (
	"fmt"
	"math"
	"time"
)

const nRuns = 21
const nWarmup = 5

func next(s *uint32) uint32  { *s ^= *s << 13; *s ^= *s >> 17; *s ^= *s << 5; return *s }
func mix(h, x uint32) uint32 { return (h ^ x) * 0x01000193 }
func checksum(out []float64) uint32 {
	h := uint32(0x811c9dc5)
	for i := 0; i < len(out)*2; i += 256 {
		h = mix(h, uint32(math.Float64bits(out[i/2])>>uint((i&1)*32)))
	}
	return h
}
func medianUs(samples []float64) uint64 {
	for i := 1; i < len(samples); i++ {
		v, j := samples[i], i-1
		for j >= 0 && samples[j] > v {
			samples[j+1] = samples[j]
			j--
		}
		samples[j+1] = v
	}
	return uint64(samples[(len(samples)-1)>>1] * 1000)
}

const w = 512
const h = 512
const nIters = 4
const maxCodes = 1 << 18

func buildBitmap(b []uint8) {
	s := uint32(0x51ce7a3)
	for i := range b {
		b[i] = 0
	}
	for c := 0; c < 42; c++ {
		cx, cy, r := 44+int(next(&s)%(w-88)), 44+int(next(&s)%(h-88)), 8+int(next(&s)%33)
		fill := uint8(1)
		if c%5 == 4 {
			fill = 0
		}
		for y := cy - r; y <= cy+r; y++ {
			dy := y - cy
			for x := cx - r; x <= cx+r; x++ {
				dx := x - cx
				if dx*dx+dy*dy <= r*r {
					b[y*w+x] = fill
				}
			}
		}
	}
}
func traceLoop(bmp, visited, codes []uint8, nc, sx, sy int) int {
	x, y, dir := sx, sy, 3
	for steps := 0; steps < maxCodes; steps++ {
		inside := x >= 0 && x < w && y >= 0 && y < h && bmp[y*w+x] == 1
		if inside {
			visited[y*w+x] = 1
			dir = (dir + 3) & 3
		} else {
			dir = (dir + 1) & 3
		}
		if nc < maxCodes {
			codes[nc] = uint8(dir)
			nc++
		}
		if dir == 0 {
			x++
		} else if dir == 1 {
			y++
		} else if dir == 2 {
			x--
		} else {
			y--
		}
		if x == sx && y == sy && dir == 3 {
			break
		}
	}
	return nc
}
func traceAll(bmp, visited, codes []uint8) uint32 {
	nc := 0
	hash := uint32(0)
	for i := range visited {
		visited[i] = 0
	}
	for y := 1; y < h-1; y++ {
		for x := 1; x < w-1; x++ {
			if bmp[y*w+x] == 1 && bmp[y*w+x-1] == 0 && visited[y*w+x] == 0 {
				start := nc
				nc = traceLoop(bmp, visited, codes, nc, x, y)
				hash = mix(hash, uint32(nc-start))
			}
		}
	}
	return mix(hash, uint32(nc))
}
func runKernel(bmp, visited, codes []uint8) uint32 {
	hash := uint32(0)
	for it := 0; it < nIters; it++ {
		hash = mix(hash, traceAll(bmp, visited, codes))
	}
	return hash
}
func main() {
	bmp, visited, codes := make([]uint8, w*h), make([]uint8, w*h), make([]uint8, maxCodes)
	buildBitmap(bmp)
	acc := uint32(0)
	for i := 0; i < nWarmup; i++ {
		acc = mix(acc, runKernel(bmp, visited, codes))
	}
	samples := make([]float64, nRuns)
	for i := range samples {
		t := time.Now()
		acc = mix(acc, runKernel(bmp, visited, codes))
		samples[i] = float64(time.Since(t).Nanoseconds()) / 1e6
	}
	hash := mix(0x811c9dc5, acc)
	for i := 0; i < maxCodes; i += 64 {
		hash = mix(hash, uint32(codes[i]))
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n", medianUs(samples), hash, w*h*nIters, 1, nRuns)
}
