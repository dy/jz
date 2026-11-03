// arraynumeric.go – a plain array that stays numeric: a quarter million
// integers pushed one by one, then 25 passes that add 1 to every slot, ported
// from arraynumeric.js (Perry's bench_numeric_array_numeric.ts,
// https://github.com/PerryTS/perry, benchmarks/suite, MIT).
//
// The JS array of numbers is a []float64 grown by append; each run builds one
// and drops it, as the JS drops its array.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every run's result
// and every slot of one more run's array, as the JS folds them.
package main

import (
	"fmt"
	"time"
)

const (
	size       = 250000
	iterations = 25
	nRuns      = 21
	nWarmup    = 3
)

func mix(h, x uint32) uint32 { return (h ^ x) * 0x01000193 }

// x | 0 for the integers these sums hold
func i32(x float64) uint32 { return uint32(int32(x)) }

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

func buildNumericArray() []float64 {
	arr := []float64{}
	for i := 0; i < size; i++ {
		arr = append(arr, float64(i))
	}
	return arr
}

func mutateNumericArray(arr []float64) float64 {
	checksum := 0.0

	for iter := 0; iter < iterations; iter++ {
		for i := 0; i < len(arr); i++ {
			arr[i] = arr[i] + 1
		}
		checksum = checksum + arr[0] + arr[len(arr)-1]
	}

	return checksum + float64(len(arr))
}

func runNumericArray() float64 {
	return mutateNumericArray(buildNumericArray())
}

func main() {
	for i := 0; i < nWarmup; i++ {
		runNumericArray()
	}

	h := uint32(0x811c9dc5)
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs := runNumericArray()
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
		h = mix(h, i32(cs))
	}

	arr := buildNumericArray()
	h = mix(h, i32(mutateNumericArray(arr)))
	for _, v := range arr {
		h = mix(h, i32(v))
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), h, size, 2, nRuns)
}
