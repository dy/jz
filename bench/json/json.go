// json.go — general JSON parser (encoding/json into map[string]interface{}) for benchmark.
package main

import (
	"encoding/json"
	"fmt"
	"time"
)

const src = `{"items":[{"id":1,"kind":2,"value":10},{"id":2,"kind":3,"value":20},{"id":3,"kind":5,"value":30}],"meta":{"scale":7,"bias":11}}`

const (
	nIters  = 512
	nRuns   = 21
	nWarmup = 5
)

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

// getInt extracts an int32 from a float64 value in the generic map
// (encoding/json unmarshals all numbers as float64 in interface{} context).
func getInt(v interface{}) int32 {
	if f, ok := v.(float64); ok {
		return int32(int64(f))
	}
	return 0
}

func walk() uint32 {
	h := uint32(0x811c9dc5)
	for i := 0; i < nIters; i++ {
		// Parse into a fully generic value — no schema knowledge.
		var root map[string]interface{}
		_ = json.Unmarshal([]byte(src), &root)

		// Walk by string-key access on the generic map.
		items := root["items"].([]interface{})
		meta  := root["meta"].(map[string]interface{})
		scale := getInt(meta["scale"])
		s     := getInt(meta["bias"])

		for _, elem := range items {
			it := elem.(map[string]interface{})
			id    := getInt(it["id"])
			kind  := getInt(it["kind"])
			value := getInt(it["value"])
			s += id*scale + kind + value
		}
		h = mix(h, uint32(s))
	}
	return h
}

func main() {
	var cs uint32
	for i := 0; i < nWarmup; i++ {
		cs = walk()
	}

	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs = walk()
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, nIters, 4, nRuns)
}
