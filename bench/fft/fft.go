package main

import (
	"fmt"
	"math"
	"time"
)

const (
	n       = 1 << 16
	log2n   = 16
	nRuns   = 21
	nWarmup = 5
)

func mix(h, x uint32) uint32 { return (h ^ x) * 0x01000193 }

func checksumF64(out []float64) uint32 {
	h := uint32(0x811c9dc5)
	for i := 0; i < len(out); i += 128 {
		h = mix(h, uint32(math.Float64bits(out[i])))
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

func sinPoly(x float64) float64 {
	x2 := x * x
	return x * (1.0 + x2*(-0.16666666666666666+x2*(0.008333333333333333+x2*(-0.0001984126984126984+x2*(2.7557319223985893e-06+x2*-2.505210838544172e-08)))))
}
func cosPoly(x float64) float64 {
	x2 := x * x
	return 1.0 + x2*(-0.5+x2*(0.041666666666666664+x2*(-0.001388888888888889+x2*(2.48015873015873e-05+x2*-2.7557319223985894e-07))))
}

func buildTwiddles(wre, wim []float64, n int) {
	dt := -6.283185307179586 / float64(n)
	c1 := cosPoly(dt)
	s1 := sinPoly(dt)
	cr, ci := 1.0, 0.0
	for k := 0; k < n>>1; k++ {
		wre[k] = cr
		wim[k] = ci
		nr := cr*c1 - ci*s1
		ni := cr*s1 + ci*c1
		cr = nr
		ci = ni
	}
}

func fft(re, im, wre, wim []float64, n int) {
	j := 0
	for i := 1; i < n; i++ {
		bit := n >> 1
		for j&bit != 0 {
			j ^= bit
			bit >>= 1
		}
		j ^= bit
		if i < j {
			re[i], re[j] = re[j], re[i]
			im[i], im[j] = im[j], im[i]
		}
	}
	for length := 2; length <= n; length <<= 1 {
		half := length >> 1
		step := n / length
		for i := 0; i < n; i += length {
			k := 0
			for jj := 0; jj < half; jj++ {
				wr := wre[k]
				wi := wim[k]
				a := i + jj
				b := a + half
				xr := re[b]
				xi := im[b]
				tr := wr*xr - wi*xi
				ti := wr*xi + wi*xr
				re[b] = re[a] - tr
				im[b] = im[a] - ti
				re[a] = re[a] + tr
				im[a] = im[a] + ti
				k += step
			}
		}
	}
}

func mkSignal(out []float64) {
	s := uint32(0x1234abcd)
	for i := range out {
		s ^= s << 13
		s ^= s >> 17
		s ^= s << 5
		out[i] = (float64(s)/4294967296.0)*2.0 - 1.0
	}
}

func main() {
	sig := make([]float64, n)
	re := make([]float64, n)
	im := make([]float64, n)
	wre := make([]float64, n>>1)
	wim := make([]float64, n>>1)
	mkSignal(sig)
	buildTwiddles(wre, wim, n)

	reset := func() {
		for i := 0; i < n; i++ {
			re[i] = sig[i]
			im[i] = 0.0
		}
	}

	for w := 0; w < nWarmup; w++ {
		reset()
		fft(re, im, wre, wim, n)
	}
	samples := make([]float64, nRuns)
	for r := 0; r < nRuns; r++ {
		reset()
		t0 := time.Now()
		fft(re, im, wre, wim, n)
		samples[r] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), checksumF64(re), (n*log2n)>>1, log2n, nRuns)
}
