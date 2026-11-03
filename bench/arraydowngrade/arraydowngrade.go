// arraydowngrade.go – a plain array that starts numeric and stops being so: a
// quarter million integers pushed one by one, an object and a string stored in
// the middle, then 25 passes that add 1 to every numeric slot on both sides of
// them, ported from arraydowngrade.js (Perry's
// bench_numeric_array_downgrade.ts, https://github.com/PerryTS/perry,
// benchmarks/suite, MIT).
//
// A JS array of mixed values is Go's []any grown by append: a float64, a
// *Obj for the object `{ value: 7 }`, a string. `arr[i] = arr[i] + 1` is JS's
// `+` on a slot of any kind: a number adds, a string concatenates, an object
// concatenates its string form, so addOne switches on the dynamic type of
// every slot it updates; the passes never reach the string or the object, so
// the concatenations never run. Storing a float64 in an interface boxes it, as
// Go does for any value it cannot hold in the interface word.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every run's result
// and every slot of one more run's array, as the JS folds them (a number as
// itself, the object by its field, the string by its UTF-16 length).
package main

import (
	"fmt"
	"math"
	"time"
	"unicode/utf16"
)

const (
	size        = 250000
	iterations  = 25
	objectIndex = 125000
	stringIndex = 125001
	nRuns       = 21
	nWarmup     = 3
)

type Obj struct{ value float64 }

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

// v + 1, JS's `+`
func addOne(v any) any {
	switch x := v.(type) {
	case float64:
		return x + 1
	case string:
		return x + "1"
	default:
		return "[object Object]1"
	}
}

// a slot in a numeric sum: a number, or NaN (an undefined field, a string's concatenation never taken here)
func num(v any) float64 {
	if x, ok := v.(float64); ok {
		return x
	}
	return math.NaN()
}

func fieldValue(v any) float64 {
	if o, ok := v.(*Obj); ok {
		return o.value
	}
	return math.NaN()
}

func buildDowngradedArray() []any {
	arr := []any{}
	for i := 0; i < size; i++ {
		arr = append(arr, float64(i))
	}

	arr[objectIndex] = &Obj{value: 7}
	arr[stringIndex] = "numeric-array-downgrade-payload"
	return arr
}

func mutateDowngradedArray(arr []any) float64 {
	checksum := 0.0

	for iter := 0; iter < iterations; iter++ {
		for i := 0; i < objectIndex; i++ {
			arr[i] = addOne(arr[i])
		}
		for i := stringIndex + 1; i < len(arr); i++ {
			arr[i] = addOne(arr[i])
		}

		checksum = checksum + num(arr[0]) + num(arr[len(arr)-1]) + fieldValue(arr[objectIndex])
		if s, ok := arr[stringIndex].(string); !ok || s != "" {
			checksum = checksum + 3
		}
	}

	return checksum + float64(len(arr))
}

func runDowngradedArray() float64 {
	return mutateDowngradedArray(buildDowngradedArray())
}

func main() {
	for i := 0; i < nWarmup; i++ {
		runDowngradedArray()
	}

	h := uint32(0x811c9dc5)
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs := runDowngradedArray()
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
		h = mix(h, i32(cs))
	}

	arr := buildDowngradedArray()
	h = mix(h, i32(mutateDowngradedArray(arr)))
	for _, v := range arr {
		switch x := v.(type) {
		case float64:
			h = mix(h, i32(x))
		case string:
			h = mix(h, uint32(len(utf16.Encode([]rune(x)))))
		case *Obj:
			h = mix(h, i32(x.value))
		}
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), h, size, 2, nRuns)
}
