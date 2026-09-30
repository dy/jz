// glyfparse.go — Go port of the unchanged JavaScript workload.
package main

import (
	"fmt"
	"math"
	"time"
)

const nRuns = 21
const nWarmup = 5

func next(s *uint32) uint32  { *s ^= *s << 13; *s ^= *s >> 17; *s ^= *s << 5; return *s }
func mix(h, x uint32) uint32 { return (h ^ x) * 0x01000193 }
func checksum(out []float64) uint32 {
	h := uint32(0x811c9dc5)
	for i := 0; i < len(out)*2; i += 256 {
		h = mix(h, uint32(math.Float64bits(out[i/2])>>uint((i&1)*32)))
	}
	return h
}
func medianUs(samples []float64) uint64 {
	for i := 1; i < len(samples); i++ {
		v, j := samples[i], i-1
		for j >= 0 && samples[j] > v {
			samples[j+1] = samples[j]
			j--
		}
		samples[j+1] = v
	}
	return uint64(samples[(len(samples)-1)>>1] * 1000)
}

const ng = 600
const maxPts = 120
const streamCap = 1 << 19
const nIters = 12

func buildStream(stream []uint8, offset, points []int32) {
	s := uint32(0x8e1d3a5)
	pos := 0
	flags := make([]uint8, maxPts)
	for g := 0; g < ng; g++ {
		offset[g] = int32(pos)
		np := 20 + int(next(&s)%(maxPts-20+1))
		points[g] = int32(np)
		for p := 0; p < np; p++ {
			dx, dy := next(&s)%3, next(&s)%3
			f := uint8(next(&s) & 1)
			if dx == 0 {
				f |= 0x02 | uint8((next(&s)&1)<<4)
			} else if dx == 2 {
				f |= 0x10
			}
			if dy == 0 {
				f |= 0x04 | uint8((next(&s)&1)<<5)
			} else if dy == 2 {
				f |= 0x20
			}
			flags[p] = f
		}
		for p := 0; p < np; {
			run := 1
			for p+run < np && flags[p+run] == flags[p] && run < 255 {
				run++
			}
			if run > 1 {
				stream[pos] = flags[p] | 0x08
				pos++
				stream[pos] = uint8(run - 1)
				pos++
			} else {
				stream[pos] = flags[p]
				pos++
			}
			p += run
		}
		for p := 0; p < np; p++ {
			f := flags[p]
			if f&0x02 != 0 {
				stream[pos] = uint8(next(&s) % 256)
				pos++
			} else if f&0x10 == 0 {
				d := next(&s) & 0xffff
				stream[pos] = uint8(d >> 8)
				stream[pos+1] = uint8(d)
				pos += 2
			}
		}
		for p := 0; p < np; p++ {
			f := flags[p]
			if f&0x04 != 0 {
				stream[pos] = uint8(next(&s) % 256)
				pos++
			} else if f&0x20 == 0 {
				d := next(&s) & 0xffff
				stream[pos] = uint8(d >> 8)
				stream[pos+1] = uint8(d)
				pos += 2
			}
		}
	}
}
func parseAll(stream []uint8, offset, points []int32, flags []uint8) uint32 {
	hash := uint32(0x811c9dc5)
	for g := 0; g < ng; g++ {
		pos, np := int(offset[g]), int(points[g])
		p := 0
		for p < np {
			f := stream[pos]
			pos++
			flags[p] = f
			p++
			if f&0x08 != 0 {
				rep := int(stream[pos])
				pos++
				for rep > 0 {
					flags[p] = f
					p++
					rep--
				}
			}
		}
		x, onCount := int32(0), uint32(0)
		for i := 0; i < np; i++ {
			f := flags[i]
			if f&0x02 != 0 {
				d := int32(stream[pos])
				pos++
				if f&0x10 != 0 {
					x += d
				} else {
					x -= d
				}
			} else if f&0x10 == 0 {
				x += int32(int16(uint16(stream[pos])<<8 | uint16(stream[pos+1])))
				pos += 2
			}
			hash = mix(hash, uint32(x))
			onCount += uint32(f & 1)
		}
		y := int32(0)
		for i := 0; i < np; i++ {
			f := flags[i]
			if f&0x04 != 0 {
				d := int32(stream[pos])
				pos++
				if f&0x20 != 0 {
					y += d
				} else {
					y -= d
				}
			} else if f&0x20 == 0 {
				y += int32(int16(uint16(stream[pos])<<8 | uint16(stream[pos+1])))
				pos += 2
			}
			hash = mix(hash, uint32(y))
		}
		hash = mix(hash, onCount)
	}
	return hash
}
func runKernel(stream []uint8, offset, points []int32, flags []uint8) uint32 {
	hash := uint32(0)
	for it := 0; it < nIters; it++ {
		hash = mix(hash, parseAll(stream, offset, points, flags))
	}
	return hash
}
func main() {
	stream, flags := make([]uint8, streamCap), make([]uint8, maxPts)
	offset, points := make([]int32, ng), make([]int32, ng)
	buildStream(stream, offset, points)
	acc := uint32(0)
	for i := 0; i < nWarmup; i++ {
		acc = mix(acc, runKernel(stream, offset, points, flags))
	}
	samples := make([]float64, nRuns)
	for i := range samples {
		t := time.Now()
		acc = mix(acc, runKernel(stream, offset, points, flags))
		samples[i] = float64(time.Since(t).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n", medianUs(samples), acc, ng*nIters, 1, nRuns)
}
