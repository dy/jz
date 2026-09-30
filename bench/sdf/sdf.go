// sdf.go — Go port of the unchanged JavaScript workload.
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

const w = 384
const h = 384
const nIters = 4
const inf = 1e20

func buildBitmap(b []uint8) {
	s := uint32(0x77aa123)
	for i := range b {
		b[i] = 0
	}
	for c := 0; c < 30; c++ {
		cx, cy, r := 20+int(next(&s)%(w-40)), 20+int(next(&s)%(h-40)), 6+int(next(&s)%25)
		fill := uint8(1)
		if c%4 == 3 {
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
func edt1d(f, d []float64, v []int32, z []float64, n int) {
	k := 0
	v[0] = 0
	z[0] = -inf
	z[1] = inf
	for q := 1; q < n; q++ {
		sm := ((f[q] + float64(q*q)) - (f[v[k]] + float64(v[k]*v[k]))) / (2*float64(q) - 2*float64(v[k]))
		for sm <= z[k] {
			k--
			sm = ((f[q] + float64(q*q)) - (f[v[k]] + float64(v[k]*v[k]))) / (2*float64(q) - 2*float64(v[k]))
		}
		k++
		v[k] = int32(q)
		z[k] = sm
		z[k+1] = inf
	}
	k = 0
	for q := 0; q < n; q++ {
		for z[k+1] < float64(q) {
			k++
		}
		dq := q - int(v[k])
		d[q] = float64(dq*dq) + f[v[k]]
	}
}
func transform(bmp []uint8, dist, rowf, rowd []float64, v []int32, z []float64) {
	for i := range dist {
		if bmp[i] == 1 {
			dist[i] = 0
		} else {
			dist[i] = inf
		}
	}
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			rowf[y] = dist[y*w+x]
		}
		edt1d(rowf, rowd, v, z, h)
		for y := 0; y < h; y++ {
			dist[y*w+x] = rowd[y]
		}
	}
	for y := 0; y < h; y++ {
		off := y * w
		for x := 0; x < w; x++ {
			rowf[x] = dist[off+x]
		}
		edt1d(rowf, rowd, v, z, w)
		for x := 0; x < w; x++ {
			dist[off+x] = rowd[x]
		}
	}
}
func runKernel(bmp []uint8, dist, rowf, rowd []float64, v []int32, z []float64) {
	for it := 0; it < nIters; it++ {
		transform(bmp, dist, rowf, rowd, v, z)
	}
}
func main() {
	bmp := make([]uint8, w*h)
	dist, rowf, rowd := make([]float64, w*h), make([]float64, w), make([]float64, w)
	v, z := make([]int32, w), make([]float64, w+1)
	buildBitmap(bmp)
	for i := 0; i < nWarmup; i++ {
		runKernel(bmp, dist, rowf, rowd, v, z)
	}
	samples := make([]float64, nRuns)
	for i := range samples {
		t := time.Now()
		runKernel(bmp, dist, rowf, rowd, v, z)
		samples[i] = float64(time.Since(t).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n", medianUs(samples), checksum(dist), w*h*nIters, 2, nRuns)
}
