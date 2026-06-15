package main

import (
	"fmt"
	"math"
	"time"
)

const (
	sr       = 44100.0
	nNotes   = 64
	noteLen  = 8192
	n        = nNotes * noteLen
	nRuns    = 21
	nWarmup  = 5
	attack   = 400.0
	decay    = 1600.0
	release  = 2400.0
	noteLenF = 8192.0
	sustain  = 0.6
	b0       = 0.0675
	b1       = 0.135
	b2       = 0.0675
	a1       = -1.143
	a2       = 0.412
)

var freqs = [8]float64{261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88, 523.25}

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

func sinTau(ph float64) float64 {
	q := ph * 4.0
	m := math.Floor(q + 0.5)
	phi := (q - m) * 1.5707963267948966
	p2 := phi * phi
	sp := phi * (1.0 + p2*(-0.16666666666666666+p2*(0.008333333333333333+p2*(-0.0001984126984126984+p2*(2.7557319223985893e-06+p2*-2.505210838544172e-08)))))
	cp := 1.0 + p2*(-0.5+p2*(0.041666666666666664+p2*(-0.001388888888888889+p2*(2.48015873015873e-05+p2*-2.7557319223985894e-07))))
	r := int(m) & 3
	if r == 0 {
		return sp
	} else if r == 1 {
		return cp
	} else if r == 2 {
		return -sp
	}
	return -cp
}

func render(out []float64) {
	x1, x2, y1, y2 := 0.0, 0.0, 0.0, 0.0
	for note := 0; note < nNotes; note++ {
		oct := 1.0
		if (note>>2)&1 != 0 {
			oct = 2.0
		}
		freq := freqs[(note*3+1)&7] * oct
		dph := freq / sr
		ph := 0.0
		off := note * noteLen
		for t := 0; t < noteLen; t++ {
			tf := float64(t)
			var env float64
			if tf < attack {
				env = tf / attack
			} else if tf < attack+decay {
				env = 1.0 - (1.0-sustain)*(tf-attack)/decay
			} else if tf < noteLenF-release {
				env = sustain
			} else {
				env = (noteLenF - tf) / release * sustain
			}
			s := sinTau(ph) * env
			ph += dph
			if ph >= 1.0 {
				ph -= 1.0
			}
			y := b0*s + b1*x1 + b2*x2 - a1*y1 - a2*y2
			x2 = x1
			x1 = s
			y2 = y1
			y1 = y
			out[off+t] = y
		}
	}
}

func main() {
	out := make([]float64, n)
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
		medianUs(samples), checksumF64(out), n, nNotes, nRuns)
}
