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

type Doc struct {
	Items []Item `json:"items"`
	Meta  Meta   `json:"meta"`
}

type Item struct {
	ID    int `json:"id"`
	Kind  int `json:"kind"`
	Value int `json:"value"`
}

type Meta struct {
	Scale int `json:"scale"`
	Bias  int `json:"bias"`
}

func walk() uint32 {
	h := uint32(0x811c9dc5)
	for i := 0; i < nIters; i++ {
		var d Doc
		_ = json.Unmarshal([]byte(src), &d)
		s := d.Meta.Bias
		for _, it := range d.Items {
			s += it.ID*d.Meta.Scale + it.Kind + it.Value
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
