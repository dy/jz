// jsonroundtrip.go – JSON.parse then JSON.stringify of one ~1 MB document,
// ported from jsonroundtrip.js (Perry's bench_json_roundtrip.ts,
// https://github.com/PerryTS/perry, benchmarks/suite, MIT): 10,000 records of
// an integer id, a string name, a float value, an array of two tag strings and
// a nested {x, y} object, written once, then parsed and written back.
//
// Go's idiomatic answer is encoding/json over tagged structs in both
// directions, as jsontransform.go has it: a []any of map[string]any would
// write each object's keys sorted, not in the JS's insertion order. Its float
// parsing is correctly rounded and its float formatting is ECMAScript's for
// these values, so the text comes back byte for byte, as JSON.stringify writes
// it.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over Perry's sum (each
// run's parsed length and text length; the text is ASCII, so its byte length
// is its UTF-16 length), then the last run's text: its UTF-16 length, then its
// UTF-16 code units.
package main

import (
	"encoding/json"
	"fmt"
	"strconv"
	"time"
	"unicode/utf16"
)

const (
	n       = 10000 // records in the document
	nRuns   = 21
	nWarmup = 5
)

type Nested struct {
	X int `json:"x"`
	Y int `json:"y"`
}

type Item struct {
	ID     int      `json:"id"`
	Name   string   `json:"name"`
	Value  float64  `json:"value"`
	Tags   []string `json:"tags"`
	Nested Nested   `json:"nested"`
}

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

func makeBlob() []byte {
	items := []Item{}
	for i := 0; i < n; i++ {
		items = append(items, Item{
			ID:     i,
			Name:   "item_" + strconv.Itoa(i),
			Value:  float64(i) * 3.14159,
			Tags:   []string{"tag_" + strconv.Itoa(i%10), "tag_" + strconv.Itoa(i%5)},
			Nested: Nested{X: i, Y: i * 2},
		})
	}
	blob, _ := json.Marshal(items)
	return blob
}

// JSON.stringify(JSON.parse(blob)), with the parsed array's length
func roundTrip(blob []byte) (int, []byte) {
	var parsed []Item
	_ = json.Unmarshal(blob, &parsed)
	out, _ := json.Marshal(parsed)
	return len(parsed), out
}

func checksum(count uint32, s []byte) uint32 {
	units := utf16.Encode([]rune(string(s)))
	h := mix(mix(0x811c9dc5, count), uint32(len(units)))
	for _, u := range units {
		h = mix(h, uint32(u))
	}
	return h
}

func main() {
	blob := makeBlob()
	var out []byte
	for i := 0; i < nWarmup; i++ {
		_, out = roundTrip(blob)
	}

	count := uint32(0)
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		var length int
		length, out = roundTrip(blob)
		count += uint32(length)
		count += uint32(len(out))
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), checksum(count, out), n, 2, nRuns)
}
