// spmv.go — sparse matrix × dense vector in CSR form (y = A·x). The canonical
// sparse-linear-algebra kernel (iterative solvers, PageRank, GNN message passing,
// FEM): the inner loop is a multiply-accumulate whose vector operand is an
// INDIRECT gather x[col[k]] through a column-index array. That data-dependent
// gather — distinct from the suite's contiguous reductions — is the access
// pattern dense codegen handles worst.
//
// Values and x are small integers, so each product and the row sum are exact in
// f64 regardless of summation order or FMA fusion — the result vector is
// bit-identical across every engine and native target (no fma parity class here).
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Float64Array/Int32Array, no
// class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in nonzeros/µs, FNV-1a checksum
// over the result vector.
package main

import (
	"fmt"
	"math"
	"time"
)

const (
	rows    = 4096
	npr     = 16
	nnz     = rows * npr
	nIters  = 80
	nRuns   = 21
	nWarmup = 5
)

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

// checksumF64 mirrors benchlib.js checksumF64:
// view y as Uint32Array (2 u32 per f64), stride 256, FNV-1a mix (i32 wrapping multiply).
func checksumF64(y []float64) uint32 {
	h := int32(-2128831035) // 0x811c9dc5 as signed i32
	stride := 256
	// y has `rows` f64 elements → rows*2 u32 words
	n := rows * 2
	for i := 0; i < n; i += stride {
		// extract the i-th uint32 from the little-endian float64 layout
		fi := i >> 1   // which float64
		lo := (i & 1) == 0 // true → low 32 bits, false → high 32 bits
		bits := math.Float64bits(y[fi])
		var word uint32
		if lo {
			word = uint32(bits & 0xffffffff)
		} else {
			word = uint32(bits >> 32)
		}
		h = int32(uint32(h^int32(word)) * 0x01000193)
	}
	return uint32(h)
}

func build(rowPtr []int32, colIdx []int32, values []float64, x []float64) {
	s := uint32(0x1234abcd)
	next := func() uint32 {
		s ^= s << 13
		s ^= s >> 17
		s ^= s << 5
		return s
	}
	for r := 0; r <= rows; r++ {
		rowPtr[r] = int32(r * npr)
	}
	for k := 0; k < nnz; k++ {
		colIdx[k] = int32(next() % rows)
		values[k] = float64(int32(next()%9) - 4)
	}
	for i := 0; i < rows; i++ {
		x[i] = float64(int32(next()%7) - 3)
	}
}

func spmv(rowPtr []int32, colIdx []int32, values []float64, x []float64, y []float64) {
	for r := 0; r < rows; r++ {
		sum := 0.0
		end := rowPtr[r+1]
		for k := rowPtr[r]; k < end; k++ {
			sum += values[k] * x[colIdx[k]]
		}
		y[r] = sum
	}
}

func runKernel(rowPtr []int32, colIdx []int32, values []float64, x []float64, y []float64) {
	for it := 0; it < nIters; it++ {
		spmv(rowPtr, colIdx, values, x, y)
		for i := 0; i < rows; i++ {
			x[i] = x[i] + 1
		}
	}
}

func main() {
	rowPtr := make([]int32, rows+1)
	colIdx := make([]int32, nnz)
	values := make([]float64, nnz)
	x := make([]float64, rows)
	y := make([]float64, rows)

	build(rowPtr, colIdx, values, x)
	for i := 0; i < nWarmup; i++ {
		build(rowPtr, colIdx, values, x)
		runKernel(rowPtr, colIdx, values, x, y)
	}

	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		build(rowPtr, colIdx, values, x)
		t0 := time.Now()
		runKernel(rowPtr, colIdx, values, x, y)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	cs := checksumF64(y)
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, nnz*nIters, 2, nRuns)
}
