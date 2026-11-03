// mapobj.go – a build tool's pass over a module graph with pointer-keyed
// maps: in-degree and reverse edges, Kahn's topological order with each
// module's depth, then a deep copy through a memo map that keeps shared
// dependencies shared and a set (map to struct{}) that counts the distinct
// copies. Go's idiomatic answer is map[*Module]T: identity, not content, keys
// the tables, as an object key does in JavaScript.
//
// Reports: median ms across N_RUNS, throughput in modules/µs, FNV-1a checksum
// over the order, depths and copy counts.
package main

import (
	"fmt"
	"time"
)

const (
	n       = 4096 // modules
	entries = 64   // entry points copied from the end of the order
	nRuns   = 21
	nWarmup = 5
)

var names = []string{"react", "lodash", "util", "core", "events", "buffer", "path", "stream", "zlib", "url"}

type Module struct {
	id   int
	name string
	size int
	deps []*Module
}

type result struct {
	order                  []*Module
	depth                  map[*Module]int
	copies, distinct, size int
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

func buildGraph() []*Module {
	modules := make([]*Module, 0, n)
	s := uint32(0x9e3779b9)
	next := func() uint32 {
		s ^= s << 13
		s ^= s >> 17
		s ^= s << 5
		return s
	}
	for i := 0; i < n; i++ {
		nDeps := 0
		if i > 0 {
			nDeps = int(next() % 5)
		}
		deps := make([]*Module, 0, nDeps)
		for k := 0; k < nDeps; k++ {
			deps = append(deps, modules[next()%uint32(i)])
		}
		name := names[next()%uint32(len(names))]
		size := 100 + int(next()%9900)
		modules = append(modules, &Module{id: i, name: name, size: size, deps: deps})
	}
	return modules
}

func plan(modules []*Module) result {
	indeg := map[*Module]int{}
	users := map[*Module][]*Module{}
	for _, m := range modules {
		if _, ok := indeg[m]; !ok {
			indeg[m] = 0
		}
		for _, d := range m.deps {
			indeg[m]++
			users[d] = append(users[d], m)
		}
	}
	depth := map[*Module]int{}
	order := []*Module{}
	for _, m := range modules {
		if indeg[m] == 0 {
			order = append(order, m)
			depth[m] = 0
		}
	}
	for head := 0; head < len(order); head++ {
		m := order[head]
		u, ok := users[m]
		if !ok {
			continue
		}
		d := depth[m] + 1
		for _, v := range u {
			if dv, ok := depth[v]; !ok || dv < d {
				depth[v] = d
			}
			indeg[v]--
			if indeg[v] == 0 {
				order = append(order, v)
			}
		}
	}
	memo := map[*Module]*Module{}
	var copyOf func(m *Module) *Module
	copyOf = func(m *Module) *Module {
		if c, ok := memo[m]; ok {
			return c
		}
		c := &Module{id: m.id, name: m.name, size: m.size, deps: make([]*Module, 0, len(m.deps))}
		memo[m] = c
		for _, d := range m.deps {
			c.deps = append(c.deps, copyOf(d))
		}
		return c
	}
	seen := map[*Module]struct{}{}
	stack := []*Module{}
	size := 0
	for e := len(order) - entries; e < len(order); e++ {
		stack = append(stack, copyOf(order[e]))
		for len(stack) > 0 {
			c := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if _, ok := seen[c]; ok {
				continue
			}
			seen[c] = struct{}{}
			size += c.size
			stack = append(stack, c.deps...)
		}
	}
	return result{order: order, depth: depth, copies: len(memo), distinct: len(seen), size: size}
}

func checksum(r result) uint32 {
	h := uint32(0x811c9dc5)
	for _, m := range r.order {
		h = mix(mix(h, uint32(m.id)), uint32(r.depth[m]))
	}
	return mix(mix(mix(h, uint32(r.copies)), uint32(r.distinct)), uint32(r.size))
}

func main() {
	modules := buildGraph()
	var r result
	for i := 0; i < nWarmup; i++ {
		r = plan(modules)
	}

	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		r = plan(modules)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), checksum(r), n, 3, nRuns)
}
