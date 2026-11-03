// mapint.go – graph analytics over sparse integer ids with integer-keyed
// maps: adjacency lists keyed by 30-bit node id, the degree histogram, and a
// breadth-first search per source with its distance map, from four sources.
// Go's idiomatic answer is map[int32]T. Map folds are sums; a search visits
// neighbors in insertion order, as the JavaScript does.
//
// Reports: median ms across N_RUNS, throughput in edges/µs, FNV-1a checksum
// over the degree histogram and the searches.
package main

import (
	"fmt"
	"time"
)

const (
	nodes   = 1 << 12
	edges   = 3 * nodes
	sources = 4
	nRuns   = 21
	nWarmup = 5
)

type result struct {
	nodes    int
	degrees  map[int]int
	searches []int
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

// a node number to its id: a bijective scramble of 30 bits
func idOf(n int) int32 {
	x := (uint32(n+1) * 0x2c1b3c6d) & 0x3fffffff
	x ^= x >> 15
	return int32((x * 0x297a2d39) & 0x3fffffff)
}

func buildEdges(src, dst []int32) {
	s := uint32(0x2545f491)
	for i := 0; i < edges; i++ {
		s ^= s << 13
		s ^= s >> 17
		s ^= s << 5
		a := int((s >> 2) & (nodes - 1))
		b := int((s >> 16) & (nodes - 1))
		if s&1 == 0 {
			b = int((s >> 16) & 1023)
		}
		if b == a {
			b = (a + 1) & (nodes - 1)
		}
		src[i] = idOf(a)
		dst[i] = idOf(b)
	}
}

func analyze(src, dst []int32) result {
	adj := map[int32][]int32{}
	for i := range src {
		a, b := src[i], dst[i]
		adj[a] = append(adj[a], b)
		adj[b] = append(adj[b], a)
	}
	degrees := map[int]int{}
	for _, list := range adj {
		degrees[len(list)]++
	}
	searches := make([]int, 0, 2*sources)
	queue := make([]int32, 0, nodes)
	for k := 0; k < sources; k++ {
		root := src[(k*6151)%len(src)]
		dist := map[int32]int{root: 0}
		queue = append(queue[:0], root)
		sum := 0
		for head := 0; head < len(queue); head++ {
			v := queue[head]
			d := dist[v] + 1
			for _, w := range adj[v] {
				if _, seen := dist[w]; !seen {
					dist[w] = d
					sum += d
					queue = append(queue, w)
				}
			}
		}
		searches = append(searches, len(dist), sum)
	}
	return result{nodes: len(adj), degrees: degrees, searches: searches}
}

func checksum(r result) uint32 {
	h := mix(0x811c9dc5, uint32(r.nodes))
	acc := uint32(0)
	for deg, count := range r.degrees {
		acc += mix(uint32(deg), uint32(count))
	}
	h = mix(mix(h, uint32(len(r.degrees))), acc)
	for _, x := range r.searches {
		h = mix(h, uint32(x))
	}
	return h
}

func main() {
	src, dst := make([]int32, edges), make([]int32, edges)
	buildEdges(src, dst)
	var r result
	for i := 0; i < nWarmup; i++ {
		r = analyze(src, dst)
	}

	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		r = analyze(src, dst)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), checksum(r), edges, 3, nRuns)
}
