// mapstr.go – sessionizing a request log with string-keyed maps: per event,
// count the route, find or open the user's session, drop the event while the
// user is rate-limited, ban users that exceed a burst, and every 512 events
// close the sessions idle for a window (deleting while ranging, which Go
// allows). Go's idiomatic answer is map[string]T; the keys are fresh strings
// per event, as a parser hands them over. Map folds are sums, so Go's random
// iteration order changes nothing.
//
// Reports: median ms across N_RUNS, throughput in events/µs, FNV-1a checksum
// over closed-session statistics and the final maps.
package main

import (
	"fmt"
	"strconv"
	"time"
)

const (
	n       = 1 << 15 // events per pass
	nUsers  = 4096
	nRoutes = 96
	window  = 2048 // a session idle this many events closes
	sweep   = 512  // events between sweeps
	burst   = 48   // hits within one session that earn a ban
	penalty = 1024 // events a ban lasts
	nRuns   = 21
	nWarmup = 5
)

var resources = []string{"users", "orders", "items", "carts", "search", "auth", "images", "reviews",
	"stock", "prices", "tags", "stats"}

type session struct{ hits, bytes, first, last int }

type result struct {
	routeHits                             map[string]int
	sessions                              map[string]*session
	banned                                map[string]int
	dropped, closed, closedBytes, longest int
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

func buildEvents(users, routes []string, bytes []int) {
	s := uint32(0x1234abcd)
	for i := 0; i < n; i++ {
		s ^= s << 13
		s ^= s >> 17
		s ^= s << 5
		u := (s >> 1) & (nUsers - 1)
		if s&1 == 0 {
			u = (s >> 1) & 63
		}
		r := (s >> 13) % nRoutes
		users[i] = "user" + strconv.Itoa(int(u))
		routes[i] = "/api/v" + strconv.Itoa(int(1+r%3)) + "/" + resources[r%uint32(len(resources))] + "/" + strconv.Itoa(int(r>>2))
		bytes[i] = 200 + int((s>>20)&4095)
	}
}

func run(users, routes []string, bytes []int) result {
	res := result{routeHits: map[string]int{}, sessions: map[string]*session{}, banned: map[string]int{}}
	for i := 0; i < n; i++ {
		res.routeHits[routes[i]]++
		u := users[i]
		if until, ok := res.banned[u]; ok {
			if until > i {
				res.dropped++
				continue
			}
			delete(res.banned, u)
		}
		s, ok := res.sessions[u]
		if !ok {
			s = &session{first: i, last: i}
			res.sessions[u] = s
		}
		s.hits++
		s.bytes += bytes[i]
		s.last = i
		if s.hits%burst == 0 {
			res.banned[u] = i + penalty
		}
		if i%sweep == sweep-1 {
			for k, v := range res.sessions {
				if i-v.last > window {
					res.closed++
					res.closedBytes += v.bytes
					if v.last-v.first > res.longest {
						res.longest = v.last - v.first
					}
					delete(res.sessions, k)
				}
			}
		}
	}
	return res
}

func hashStr(s string) uint32 {
	h := uint32(0x811c9dc5)
	for i := 0; i < len(s); i++ { // ASCII keys: bytes are the UTF-16 code units
		h = mix(h, uint32(s[i]))
	}
	return h
}

func checksum(r result) uint32 {
	h := mix(mix(mix(mix(0x811c9dc5, uint32(r.dropped)), uint32(r.closed)), uint32(r.closedBytes)), uint32(r.longest))
	acc := uint32(0)
	for k, v := range r.routeHits {
		acc += mix(hashStr(k), uint32(v))
	}
	h = mix(mix(h, uint32(len(r.routeHits))), acc)
	acc = 0
	for k, v := range r.sessions {
		acc += mix(mix(hashStr(k), uint32(v.hits)), uint32(v.bytes))
	}
	h = mix(mix(h, uint32(len(r.sessions))), acc)
	acc = 0
	for k, v := range r.banned {
		acc += mix(hashStr(k), uint32(v))
	}
	return mix(mix(h, uint32(len(r.banned))), acc)
}

func main() {
	users, routes, bytes := make([]string, n), make([]string, n), make([]int, n)
	buildEvents(users, routes, bytes)
	var r result
	for i := 0; i < nWarmup; i++ {
		r = run(users, routes, bytes)
	}

	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		r = run(users, routes, bytes)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), checksum(r), n, 3, nRuns)
}
