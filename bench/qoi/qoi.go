package main

import (
	"fmt"
	"time"
)

const (
	npix    = 256 * 256
	imgLen  = npix * 4
	cap_    = npix*5 + 64
	nIters  = 10
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

func mkImage(img []byte) {
	x := int32(0x12345678)
	r, g, b, a := byte(128), byte(128), byte(128), byte(255)
	for p := 0; p < npix; p++ {
		x = x*1103515245 + 12345
		ux := uint32(x)
		roll := (ux >> 28) & 7
		if roll < 3 {
			// keep previous pixel - run-length
		} else if roll < 6 {
			r = byte((int(r) + int((ux>>4)&3) - 1) & 255)
			g = byte((int(g) + int((ux>>6)&3) - 1) & 255)
			b = byte((int(b) + int((ux>>8)&3) - 1) & 255)
		} else if roll == 6 {
			r = byte((ux >> 10) & 255)
			g = byte((ux >> 16) & 255)
			b = byte((ux >> 20) & 255)
		} else {
			a = byte((ux >> 12) & 255)
		}
		o := p << 2
		img[o] = r; img[o+1] = g; img[o+2] = b; img[o+3] = a
	}
}

func encode(img []byte, ir, ig, ib, ia []byte, out []byte) int {
	for i := 0; i < 64; i++ { ir[i] = 0; ig[i] = 0; ib[i] = 0; ia[i] = 0 }
	pr, pg, pb, pa := byte(0), byte(0), byte(0), byte(255)
	run := 0
	op := 0
	for p := 0; p < npix; p++ {
		o := p << 2
		r, g, b, a := img[o], img[o+1], img[o+2], img[o+3]
		if r == pr && g == pg && b == pb && a == pa {
			run++
			if run == 62 || p == npix-1 {
				out[op] = byte(0xc0 | (run - 1)); op++; run = 0
			}
		} else {
			if run > 0 { out[op] = byte(0xc0 | (run - 1)); op++; run = 0 }
			h := int((uint32(r)*3 + uint32(g)*5 + uint32(b)*7 + uint32(a)*11) & 63)
			if ir[h] == r && ig[h] == g && ib[h] == b && ia[h] == a {
				out[op] = byte(h); op++
			} else {
				ir[h] = r; ig[h] = g; ib[h] = b; ia[h] = a
				if a == pa {
					// signed-8-bit wraparound: int32(int8(r - pr))
					vr := int32(int8(r - pr))
					vg := int32(int8(g - pg))
					vb := int32(int8(b - pb))
					vgr := vr - vg
					vgb := vb - vg
					if vr >= -2 && vr <= 1 && vg >= -2 && vg <= 1 && vb >= -2 && vb <= 1 {
						out[op] = byte(0x40 | ((vr+2)<<4) | ((vg+2)<<2) | (vb + 2)); op++
					} else if vgr >= -8 && vgr <= 7 && vg >= -32 && vg <= 31 && vgb >= -8 && vgb <= 7 {
						out[op] = byte(0x80 | (vg + 32)); op++
						out[op] = byte(((vgr + 8) << 4) | (vgb + 8)); op++
					} else {
						out[op] = 0xfe; op++; out[op] = r; op++; out[op] = g; op++; out[op] = b; op++
					}
				} else {
					out[op] = 0xff; op++; out[op] = r; op++; out[op] = g; op++; out[op] = b; op++; out[op] = a; op++
				}
			}
		}
		pr = r; pg = g; pb = b; pa = a
	}
	return op
}

func decode(inp []byte, clen int, ir, ig, ib, ia []byte, out []byte) {
	for i := 0; i < 64; i++ { ir[i] = 0; ig[i] = 0; ib[i] = 0; ia[i] = 0 }
	pr, pg, pb, pa := byte(0), byte(0), byte(0), byte(255)
	run := 0
	ip := 0
	for p := 0; p < npix; p++ {
		if run > 0 {
			run--
		} else if ip < clen {
			b0 := int(inp[ip]); ip++
			if b0 == 0xfe {
				pr = inp[ip]; ip++; pg = inp[ip]; ip++; pb = inp[ip]; ip++
			} else if b0 == 0xff {
				pr = inp[ip]; ip++; pg = inp[ip]; ip++; pb = inp[ip]; ip++; pa = inp[ip]; ip++
			} else if (b0 & 0xc0) == 0x00 {
				pr = ir[b0]; pg = ig[b0]; pb = ib[b0]; pa = ia[b0]
			} else if (b0 & 0xc0) == 0x40 {
				pr = byte((int(pr) + ((b0 >> 4) & 3) - 2) & 255)
				pg = byte((int(pg) + ((b0 >> 2) & 3) - 2) & 255)
				pb = byte((int(pb) + (b0 & 3) - 2) & 255)
			} else if (b0 & 0xc0) == 0x80 {
				b1 := int(inp[ip]); ip++
				vg := (b0 & 63) - 32
				pr = byte((int(pr) + vg + ((b1>>4)&15) - 8) & 255)
				pg = byte((int(pg) + vg) & 255)
				pb = byte((int(pb) + vg + (b1&15) - 8) & 255)
			} else {
				run = b0 & 63
			}
			h := int((uint32(pr)*3 + uint32(pg)*5 + uint32(pb)*7 + uint32(pa)*11) & 63)
			ir[h] = pr; ig[h] = pg; ib[h] = pb; ia[h] = pa
		}
		o := p << 2
		out[o] = pr; out[o+1] = pg; out[o+2] = pb; out[o+3] = pa
	}
}

func runKernel(img []byte, ir, ig, ib, ia []byte, comp []byte, dec []byte) uint32 {
	h := uint32(0)
	for it := 0; it < nIters; it++ {
		clen := encode(img, ir, ig, ib, ia, comp)
		decode(comp, clen, ir, ig, ib, ia, dec)
		ok := uint32(1)
		for i := 0; i < imgLen; i++ {
			if dec[i] != img[i] { ok = 0 }
		}
		h = mix(h, uint32(clen))
		for i := 0; i < clen; i++ { h = mix(h, uint32(comp[i])) }
		h = mix(h, ok)
		j := (it % npix) << 2
		img[j] = (img[j] + 1) & 0xff
	}
	return h
}

func main() {
	img := make([]byte, imgLen)
	ir := make([]byte, 64)
	ig := make([]byte, 64)
	ib := make([]byte, 64)
	ia := make([]byte, 64)
	comp := make([]byte, cap_)
	dec := make([]byte, imgLen)
	mkImage(img)
	cs := uint32(0)
	for i := 0; i < nWarmup; i++ {
		cs = runKernel(img, ir, ig, ib, ia, comp, dec)
	}
	samples := make([]float64, nRuns)
	for i := 0; i < nRuns; i++ {
		t0 := time.Now()
		cs = runKernel(img, ir, ig, ib, ia, comp, dec)
		samples[i] = float64(time.Since(t0).Nanoseconds()) / 1e6
	}
	fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",
		medianUs(samples), cs, npix*nIters, 1, nRuns)
}
