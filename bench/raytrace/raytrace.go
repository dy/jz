// raytrace.go — a minimal sphere ray tracer: one primary ray per pixel, a
// closest-hit search over a small sphere scene, then Lambert diffuse + ambient
// shading into an f64 framebuffer. The canonical 3-D rendering kernel — a branchy,
// loop-carried scalar pipeline (ray–sphere quadratic, closest-hit select, normal
// + light dot product) that no target auto-vectorizes, so it is a pure
// scalar-codegen race.
//
// Transcendental-free: only +,-,*,/ and sqrt, all IEEE-754 correctly-rounded, so
// the framebuffer is bit-identical across engines and native targets. Go's arm64
// backend force-fuses a*b+c → FMADDD (no flag to disable), so its checksum is the
// documented `fma` parity class, like fft/synth/biquad — same algorithm, last-ulp
// rounding only.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Float64Array, Math.sqrt, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in pixels/µs, FNV-1a checksum over
// the rendered framebuffer.
package main

import (
	"fmt"
	"math"
	"time"
)

const (
	W       = 384
	H       = 384
	NS      = 8
	nRuns   = 21
	nWarmup = 5
)

func mix(h, x uint32) uint32 { return (h ^ x) * 0x01000193 }

func checksumF64(o []float64) uint32 {
	h := uint32(0x811c9dc5)
	// stride=256 in u32 units → stride=128 in f64 units; 256 is even so always low 32 bits
	for i := 0; i < len(o); i += 128 {
		b := math.Float64bits(o[i])
		h = mix(h, uint32(b))
	}
	return h
}

func medianUs(s []float64) int {
	for i := 1; i < len(s); i++ {
		v := s[i]
		j := i - 1
		for j >= 0 && s[j] > v {
			s[j+1] = s[j]
			j--
		}
		s[j+1] = v
	}
	return int(s[(len(s)-1)>>1] * 1000)
}

func buildScene(sx, sy, sz, sr, cr, cg, cb []float64) {
	for i := 0; i < NS; i++ {
		sx[i] = float64((i%3)-1) * 2.2
		sy[i] = float64((i/3)-1) * 1.6
		sz[i] = -5.0 - float64(i)*1.3
		sr[i] = 0.7 + float64(i%4)*0.18
		cr[i] = 0.30 + float64(i%5)*0.14
		cg[i] = 0.25 + float64(i%3)*0.24
		cb[i] = 0.40 + float64(i%7)*0.08
	}
}

func render(fb, sx, sy, sz, sr, cr, cg, cb []float64, lx, ly, lz float64) {
	for py := 0; py < H; py++ {
		sv := 1.0 - (float64(py)+0.5)/H*2.0
		for px := 0; px < W; px++ {
			su := (float64(px)+0.5)/W*2.0 - 1.0
			dx, dy, dz := su, sv, -1.0
			dinv := 1.0 / math.Sqrt(dx*dx+dy*dy+dz*dz)
			dx = dx * dinv
			dy = dy * dinv
			dz = dz * dinv

			tBest := 1e30
			hit := -1
			for s := 0; s < NS; s++ {
				ox := -sx[s]
				oy := -sy[s]
				oz := -sz[s]
				b := ox*dx + oy*dy + oz*dz
				c := ox*ox + oy*oy + oz*oz - sr[s]*sr[s]
				disc := b*b - c
				if disc > 0.0 {
					t := -b - math.Sqrt(disc)
					if t > 0.001 && t < tBest {
						tBest = t
						hit = s
					}
				}
			}

			r, g, bl := 0.0, 0.0, 0.0
			if hit >= 0 {
				hx := dx * tBest
				hy := dy * tBest
				hz := dz * tBest
				nx := hx - sx[hit]
				ny := hy - sy[hit]
				nz := hz - sz[hit]
				ninv := 1.0 / math.Sqrt(nx*nx+ny*ny+nz*nz)
				nx = nx * ninv
				ny = ny * ninv
				nz = nz * ninv
				diff := nx*lx + ny*ly + nz*lz
				if diff < 0.0 {
					diff = 0.0
				}
				shade := 0.15 + 0.85*diff
				r = cr[hit] * shade
				g = cg[hit] * shade
				bl = cb[hit] * shade
			}
			o := (py*W + px) * 3
			fb[o] = r
			fb[o+1] = g
			fb[o+2] = bl
		}
	}
}

func main() {
	sx := make([]float64, NS)
	sy := make([]float64, NS)
	sz := make([]float64, NS)
	sr := make([]float64, NS)
	cr := make([]float64, NS)
	cg := make([]float64, NS)
	cb := make([]float64, NS)
	buildScene(sx, sy, sz, sr, cr, cg, cb)

	fb := make([]float64, W*H*3)
	// Compute llen with explicit intermediate variables to match JS evaluation order.
	// A single expression 0.6*0.6+1.0*1.0+0.5*0.5 gets FMA-contracted by Go even
	// in the wasm backend (IR-level), shifting the last ULP vs JS. Breaking into
	// three separate named products prevents contraction.
	llenA := 0.6 * 0.6
	llenB := 1.0 * 1.0
	llenC := 0.5 * 0.5
	llen := 1.0 / math.Sqrt(llenA+llenB+llenC)
	lx := -0.6 * llen
	ly := 1.0 * llen
	lz := 0.5 * llen

	for i := 0; i < nWarmup; i++ {
		render(fb, sx, sy, sz, sr, cr, cg, cb, lx, ly, lz)
	}

	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		render(fb, sx, sy, sz, sr, cr, cg, cb, lx, ly, lz)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), checksumF64(fb), W*H, NS, nRuns)
}
