//go:build ignore
// +build ignore

// biquad.go — native Go reference of bench/biquad/biquad.js.
//
// Same algorithm, same constants. Build with:
//   go build -o biquad biquad.go
//
// Checksum parity: on amd64 Go matches the scalar f64 reference (1646038335).
// On arm64, Go's SSA backend auto-fuses `a*b + c` to FMADDD (mandatory in
// ARMv8); there is no flag to disable this short of `-N` which would kill
// optimization. The cascade then yields a different (but still IEEE-754
// correctly-rounded) checksum: 1814592024. The bench harness reports this
// as `fma` parity rather than `DIFF`. Same situation as Rust on arm64
// without `-C target-feature=-fma`.
package main

import (
	"encoding/binary"
	"fmt"
	"math"
	"time"
)

const (
	nSamples = 480000
	nStages  = 8
	nRuns    = 21
	nWarmup  = 5
)

func mkInput(out []float64) {
	s := uint32(0x1234abcd)
	for i := range out {
		s ^= s << 13
		s ^= s >> 17
		s ^= s << 5
		out[i] = (float64(s)/4294967296.0)*2.0 - 1.0
	}
}

func mkCoeffs(out []float64) {
	for i := 0; i < nStages; i++ {
		out[i*5+0] = 0.10 + float64(i)*0.001
		out[i*5+1] = 0.20 - float64(i)*0.0005
		out[i*5+2] = 0.10
		out[i*5+3] = -1.50 + float64(i)*0.01
		out[i*5+4] = 0.60 - float64(i)*0.005
	}
}

func processCascade(x, coeffs, state, out []float64) {
	n := len(x)
	for i := 0; i < n; i++ {
		v := x[i]
		for s := 0; s < nStages; s++ {
			c := s * 5
			sb := s * 4
			b0 := coeffs[c+0]
			b1 := coeffs[c+1]
			b2 := coeffs[c+2]
			a1 := coeffs[c+3]
			a2 := coeffs[c+4]
			x1 := state[sb+0]
			x2 := state[sb+1]
			y1 := state[sb+2]
			y2 := state[sb+3]
			y := b0*v + b1*x1 + b2*x2 - a1*y1 - a2*y2
			state[sb+0] = v
			state[sb+1] = x1
			state[sb+2] = y
			state[sb+3] = y1
			v = y
		}
		out[i] = v
	}
}

// FNV-1a over a 32-bit-word stride of out's bit pattern.
func checksum(out []float64) uint32 {
	h := uint32(0x811c9dc5)
	const stride = 4096
	total := len(out) * 2
	buf := make([]byte, 8)
	for i := 0; i < total; i += stride {
		binary.LittleEndian.PutUint64(buf, math.Float64bits(out[i/2]))
		off := (i & 1) * 4
		w := binary.LittleEndian.Uint32(buf[off : off+4])
		h = (h ^ w) * 0x01000193
	}
	return h
}

func resetState(state []float64) {
	for i := range state {
		state[i] = 0.0
	}
}

func main() {
	x := make([]float64, nSamples)
	coeffs := make([]float64, nStages*5)
	state := make([]float64, nStages*4)
	out := make([]float64, nSamples)
	mkInput(x)
	mkCoeffs(coeffs)

	for i := 0; i < nWarmup; i++ {
		resetState(state)
		processCascade(x, coeffs, state, out)
	}

	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		resetState(state)
		t0 := time.Now()
		processCascade(x, coeffs, state, out)
		samples[i] = float64(time.Since(t0).Microseconds()) / 1000.0
	}

	cs := checksum(out)

	sorted := make([]float64, nRuns)
	copy(sorted, samples)
	for i := 1; i < nRuns; i++ {
		v := sorted[i]
		j := i - 1
		for j >= 0 && sorted[j] > v {
			sorted[j+1] = sorted[j]
			j--
		}
		sorted[j+1] = v
	}
	medianMs := sorted[(nRuns-1)>>1]
	medianUs := int(medianMs * 1000.0)

	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs, cs, nSamples, nStages, nRuns)
}
