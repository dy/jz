// matmul.go — dense matrix multiply C = A·Bᵀ. Bit-identical to matmul.js.
// Small-integer data keeps every product-sum exact in f64 (arm64 FMA on `s += a*b`
// stays exact on integer operands), so the checksum matches every target with no
// parity class.
package main

import (
	"fmt"
	"math"
	"time"
)

const (
	N        = 256
	N_RUNS   = 21
	N_WARMUP = 5
)

func mix(h, x uint32) uint32 { return (h ^ x) * 0x01000193 }

func checksumF64(out []float64) uint32 {
	h := uint32(0x811c9dc5)
	for i := 0; i < len(out)*2; i += 256 {
		bits := math.Float64bits(out[i/2])
		var w uint32
		if i&1 == 0 {
			w = uint32(bits)
		} else {
			w = uint32(bits >> 32)
		}
		h = mix(h, w)
	}
	return h
}

func medianUs(samples []float64) uint64 {
	for i := 1; i < len(samples); i++ {
		v := samples[i]
		j := i - 1
		for j >= 0 && samples[j] > v {
			samples[j+1] = samples[j]
			j--
		}
		samples[j+1] = v
	}
	return uint64(samples[(len(samples)-1)>>1] * 1000.0)
}

func initData(a, bt []float64) {
	for i := 0; i < N*N; i++ {
		a[i] = float64(i%13) - 6
		bt[i] = float64((i*7)%11) - 5
	}
}

// C = A·Bᵀ. Inner loop is a contiguous dot over row i of A and row j of Bᵀ.
func matmul(a, bt, c []float64) {
	for i := 0; i < N; i++ {
		ai := i * N
		for j := 0; j < N; j++ {
			bj := j * N
			var s float64
			for k := 0; k < N; k++ {
				s += a[ai+k] * bt[bj+k]
			}
			c[ai+j] = s
		}
	}
}

func main() {
	a := make([]float64, N*N)
	bt := make([]float64, N*N)
	c := make([]float64, N*N)
	initData(a, bt)
	for i := 0; i < N_WARMUP; i++ {
		matmul(a, bt, c)
	}
	samples := make([]float64, N_RUNS)
	for i := 0; i < N_RUNS; i++ {
		t0 := time.Now()
		matmul(a, bt, c)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), checksumF64(c), N*N*N, 2, N_RUNS)
}
