package main

import (
	"fmt"
	"time"
)

const (
	w       = 512
	h       = 512
	r       = 4
	win     = 2*r + 1
	n       = w * h * 4
	nRuns   = 21
	nWarmup = 5
)

func mix(h, x uint32) uint32 { return (h ^ x) * 0x01000193 }

func checksumU8(out []uint8) uint32 {
	hh := uint32(0x811c9dc5)
	for _, b := range out {
		hh = mix(hh, uint32(b))
	}
	return hh
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

func mkImage(out []uint8) {
	s := uint32(0x1234abcd)
	for i := range out {
		s ^= s << 13
		s ^= s >> 17
		s ^= s << 5
		out[i] = uint8(s & 255)
	}
}

func hblur(src, dst []uint8, w, h, r int) {
	win := 2*r + 1
	for y := 0; y < h; y++ {
		row := y * w
		for x := 0; x < w; x++ {
			sr, sg, sb, sa := 0, 0, 0, 0
			for k := -r; k <= r; k++ {
				xi := x + k
				if xi < 0 {
					xi = 0
				} else if xi >= w {
					xi = w - 1
				}
				p := (row + xi) << 2
				sr += int(src[p])
				sg += int(src[p+1])
				sb += int(src[p+2])
				sa += int(src[p+3])
			}
			o := (row + x) << 2
			dst[o] = uint8(sr / win)
			dst[o+1] = uint8(sg / win)
			dst[o+2] = uint8(sb / win)
			dst[o+3] = uint8(sa / win)
		}
	}
}

func vblur(src, dst []uint8, w, h, r int) {
	win := 2*r + 1
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			sr, sg, sb, sa := 0, 0, 0, 0
			for k := -r; k <= r; k++ {
				yi := y + k
				if yi < 0 {
					yi = 0
				} else if yi >= h {
					yi = h - 1
				}
				p := (yi*w + x) << 2
				sr += int(src[p])
				sg += int(src[p+1])
				sb += int(src[p+2])
				sa += int(src[p+3])
			}
			o := (y*w + x) << 2
			dst[o] = uint8(sr / win)
			dst[o+1] = uint8(sg / win)
			dst[o+2] = uint8(sb / win)
			dst[o+3] = uint8(sa / win)
		}
	}
}

func main() {
	img := make([]uint8, n)
	tmp := make([]uint8, n)
	out := make([]uint8, n)
	mkImage(img)
	for i := 0; i < nWarmup; i++ {
		hblur(img, tmp, w, h, r)
		vblur(tmp, out, w, h, r)
	}
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		hblur(img, tmp, w, h, r)
		vblur(tmp, out, w, h, r)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), checksumU8(out), w*h, win, nRuns)
}
