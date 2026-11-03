// setops.go – near-duplicate detection over tokenized documents with sets:
// each document becomes a set of its words minus the stop words, every word
// joins a vocabulary union, and each document is compared with the eight that
// follow it (intersection by probing, union by inclusion-exclusion, Jaccard in
// thousandths); duplicates pay for a set difference both ways (copy, delete).
// Go's idiomatic set is map[string]struct{}; no fold depends on its order.
//
// Reports: median ms across N_RUNS, throughput in documents/µs, FNV-1a
// checksum over the vocabulary size, scores and differences.
package main

import (
	"fmt"
	"strconv"
	"time"
)

const (
	nWords  = 1024
	nStop   = 32 // the most common words are stop words
	nDocs   = 256
	window  = 8 // documents compared after each one
	nRuns   = 21
	nWarmup = 5
)

type set = map[string]struct{}

type result struct{ vocab, score, dupes, diff int }

var seed = uint32(0x6d2b79f5)

func next() uint32 {
	seed ^= seed << 13
	seed ^= seed >> 17
	seed ^= seed << 5
	return seed
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

func buildWords() []string {
	words := make([]string, nWords)
	for i := range words {
		length := 3 + int(next()%7)
		b := make([]byte, length)
		for j := range b {
			b[j] = byte(97 + next()%26)
		}
		words[i] = string(b) + strconv.Itoa(i)
	}
	return words
}

// a word index skewed toward common words: the minimum of two uniform draws
func pick() int {
	a := next() % nWords
	b := next() % nWords
	if a < b {
		return int(a)
	}
	return int(b)
}

func buildDocs(words []string) [][]string {
	docs := make([][]string, 0, nDocs)
	for d := 0; d < nDocs; d++ {
		var doc []string
		if d%8 == 7 {
			prev := docs[d-1]
			for k := range prev {
				if next()%10 == 0 {
					doc = append(doc, words[pick()])
				} else {
					doc = append(doc, prev[k])
				}
			}
		} else {
			length := 24 + int(next()%73)
			for k := 0; k < length; k++ {
				doc = append(doc, words[pick()])
			}
		}
		docs = append(docs, doc)
	}
	return docs
}

func compare(docs [][]string, stopWords []string) result {
	stop := set{}
	for _, w := range stopWords {
		stop[w] = struct{}{}
	}
	vocab := set{}
	sets := make([]set, 0, len(docs))
	for _, doc := range docs {
		s := set{}
		for _, w := range doc {
			if _, ok := stop[w]; !ok {
				s[w] = struct{}{}
			}
		}
		for w := range s {
			vocab[w] = struct{}{}
		}
		sets = append(sets, s)
	}
	r := result{vocab: len(vocab)}
	for i, a := range sets {
		for j := i + 1; j <= i+window && j < len(sets); j++ {
			b := sets[j]
			small, large := b, a
			if len(a) < len(b) {
				small, large = a, b
			}
			inter := 0
			for w := range small {
				if _, ok := large[w]; ok {
					inter++
				}
			}
			union := len(a) + len(b) - inter
			jac := 0
			if union != 0 {
				jac = inter * 1000 / union
			}
			r.score += jac
			if jac >= 600 {
				r.dupes++
				onlyA := make(set, len(a))
				for w := range a {
					onlyA[w] = struct{}{}
				}
				for w := range b {
					delete(onlyA, w)
				}
				onlyB := make(set, len(b))
				for w := range b {
					onlyB[w] = struct{}{}
				}
				for w := range a {
					delete(onlyB, w)
				}
				r.diff += len(onlyA) + len(onlyB)
			}
		}
	}
	return r
}

func main() {
	words := buildWords()
	docs := buildDocs(words)
	stopWords := words[:nStop]
	var r result
	for i := 0; i < nWarmup; i++ {
		r = compare(docs, stopWords)
	}

	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		r = compare(docs, stopWords)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	cs := mix(mix(mix(mix(0x811c9dc5, uint32(r.vocab)), uint32(r.score)), uint32(r.dupes)), uint32(r.diff))
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, nDocs, 3, nRuns)
}
