// immutable.go — a particle step in the immutable-update idiom: every step
// replaces each record wholesale instead of mutating fields. The canonical
// functional-state kernel (reducers, persistent game state, event-sourced
// models). Go gets the pattern free through value semantics — a struct
// assigned by value, zero allocation — the static reference for what the
// fresh-object JS idiom costs. Pure integer bounce physics, so positions are
// bit-identical across every engine and native target.
//
// Reports: median ms across N_RUNS, throughput in particle-steps/µs, FNV-1a
// checksum over the per-pass position folds.
package main

import (
	"fmt"
	"time"
)

const (
	n       = 4096 // particles
	steps   = 32   // steps per pass (one record replacement per particle per step)
	lim     = 1023 // box bound
	nRuns   = 21
	nWarmup = 5
)

type p struct{ x, y, vx, vy int32 }

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

// Deterministic initial state — XorShift32 positions in [0, LIM], velocities
// in [-8, 8] forced nonzero, identical per target.
func initParticles(ps []p) {
	s := int32(0x1234abcd)
	for i := 0; i < n; i++ {
		s ^= s << 13
		s ^= int32(uint32(s) >> 17)
		s ^= s << 5
		vx := int32((uint32(s)>>4)&15) - 8
		vy := int32((uint32(s)>>8)&15) - 8
		if vx == 0 {
			vx = 1
		}
		if vy == 0 {
			vy = 1
		}
		ps[i] = p{int32((uint32(s) >> 12) & lim), int32((uint32(s) >> 20) & lim), vx, vy}
	}
}

func runKernel(ps []p) uint32 {
	h := uint32(0x811c9dc5)
	for it := 0; it < steps; it++ {
		sum := int32(it)
		for i := 0; i < n; i++ {
			q := ps[i]
			nx, ny := q.x+q.vx, q.y+q.vy
			hitX := nx < 0 || nx > lim
			hitY := ny < 0 || ny > lim
			x, y := nx, ny
			vx, vy := q.vx, q.vy
			if hitX {
				x, vx = q.x, -q.vx
			}
			if hitY {
				y, vy = q.y, -q.vy
			}
			ps[i] = p{x, y, vx, vy}
			sum = int32(uint32(sum) + uint32(x) + uint32(y)*31)
		}
		h = mix(h, uint32(sum))
	}
	return h
}

func main() {
	ps := make([]p, n)
	var cs uint32
	// Fresh particle set per run — the kernel mutates the array, so timing runs
	// must not compound each other's motion.
	for i := 0; i < nWarmup; i++ {
		initParticles(ps)
		cs = runKernel(ps)
	}

	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		initParticles(ps)
		t0 := time.Now()
		cs = runKernel(ps)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, n*steps, 1, nRuns)
}
