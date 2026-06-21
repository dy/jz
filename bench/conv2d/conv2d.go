package main

import (
	"fmt"
	"time"
)

const (
	cin    = 4
	cout   = 16
	h      = 34
	w      = 34
	k      = 3
	oh     = h - k + 1 // 32
	ow     = w - k + 1 // 32
	inLen  = cin * h * w
	wtLen  = cout * cin * k * k
	outLen = cout * oh * ow
	shift  = 11
	nIters = 24
	nRuns  = 21
	nWarmup = 5
)

func mix(hh, x uint32) uint32 { return (hh ^ x) * 0x01000193 }

func checksumU8(out []uint8) uint32 {
	h := uint32(0x811c9dc5)
	for _, b := range out {
		h = mix(h, uint32(b))
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

func fillI8(arr []int8, seed int32) {
	x := seed
	for i := range arr {
		x = int32(uint32(x)*1103515245 + 12345)
		arr[i] = int8(x >> 24)
	}
}

func fillBias(arr []int32, seed int32) {
	x := seed
	for i := range arr {
		x = int32(uint32(x)*1103515245 + 12345)
		arr[i] = (x >> 20) & 1023
	}
}

func conv(inp []int8, wt []int8, bias []int32, out []uint8) {
	for oc := 0; oc < cout; oc++ {
		b := bias[oc]
		ocBase := oc * oh * ow
		for oy := 0; oy < oh; oy++ {
			for ox := 0; ox < ow; ox++ {
				acc := b
				for ic := 0; ic < cin; ic++ {
					inCh := ic * h * w
					wCh := ((oc*cin) + ic) * k * k
					for ky := 0; ky < k; ky++ {
						irow := inCh + (oy+ky)*w + ox
						wrow := wCh + ky*k
						for kx := 0; kx < k; kx++ {
							acc += int32(inp[irow+kx]) * int32(wt[wrow+kx])
						}
					}
				}
				q := acc >> shift
				if q < 0 {
					q = 0
				}
				if q > 127 {
					q = 127
				}
				out[ocBase+oy*ow+ox] = uint8(q)
			}
		}
	}
}

func runKernel(inp []int8, wt []int8, bias []int32, out []uint8) uint32 {
	hh := uint32(0)
	for it := 0; it < nIters; it++ {
		conv(inp, wt, bias, out)
		hh = mix(hh, checksumU8(out))
		j := it % inLen
		inp[j] = inp[j] + 1
	}
	return hh
}

func main() {
	inp := make([]int8, inLen)
	wt := make([]int8, wtLen)
	bias := make([]int32, cout)
	out := make([]uint8, outLen)
	fillI8(inp, int32(0x12345678))
	fillI8(wt, int32(0x2bb3c1f7))
	fillBias(bias, int32(0x51e3a9d1))
	cs := uint32(0)
	for i := 0; i < nWarmup; i++ {
		cs = runKernel(inp, wt, bias, out)
	}
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs = runKernel(inp, wt, bias, out)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, cout*oh*ow*cin*k*k*nIters, 1, nRuns)
}
