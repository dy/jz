import Base
import ../_lib/bench.bend as B
# glyfparse.bend: Bend port of glyfparse.js (same stream, glyphs, passes and
# checksum): TrueType glyf-style outline decoding, flag runs expanded by
# their REPEAT counts, then the x and y deltas (a short byte signed by a
# flag bit, a long 16-bit word, or the same as before) accumulated to
# absolute coordinates and hashed. The flag loop's bound is a test (p < np):
# it answers its state beside the Bool and carries a Nat fuel of np + 1
# steps, as each step takes a point. A coordinate's kind is a chain of defs
# taking the caller's Bool, each read's pair the next stage's parameter.
# Bend has no signed integer: a long delta is the 16-bit word shifted left
# 16 then arithmetically right 16 (the sign filled), and x - d wraps in the
# U32 as the int32 does.

# the parse's arrays: the stream, glyphOff, glyphPts and flagBuf
type Font is Type:
  Font{stream: Array<U32>, off: Array<U32>, pts: Array<U32>, fb: Array<U32>}

# the flag loop: the stream, flagBuf, r and p
type Fl is Type:
  Fl{stream: Array<U32>, fb: Array<U32>, r: U32, p: U32}

# a coordinate loop: the stream, flagBuf, r, the coordinate, onCount and h
type Ax is Type:
  Ax{stream: Array<U32>, fb: Array<U32>, r: U32, v: U32, on: U32, h: U32}

# buildStream's state: the stream, flags, glyphOff, glyphPts, the xorshift
# state and w
type Bld is Type:
  Bld{stream: Array<U32>, flags: Array<U32>, off: Array<U32>, pts: Array<U32>, s: U32, w: U32}

type Rle is Type:
  Rle{stream: Array<U32>, flags: Array<U32>, w: U32, p: U32}

type Dl is Type:
  Dl{stream: Array<U32>, flags: Array<U32>, s: U32, w: U32}

def ng() -> U32:
  600

# s ^= s << 13; s ^= s >>> 17; s ^= s << 5: the draw is the new state
def rnd(+s: U32) -> U32:
  +s1 = (s .^. (s << 13n) : U32)
  +s2 = (s1 .^. (s1 >> 17n) : U32)
  (s2 .^. (s2 << 5n) : U32)

# dxKind 0 (short) draws the sign bit 0x10 beside 0x02; 2 (same) sets 0x10
def pt.dx(k0: Bool, k2: Bool, +s: U32, f: U32) -> U32 & U32:
  match k0 k2:
    case True{} _:
      +s1 = rnd(s)
      (s1, (f .|. 2 .|. ((s1 .&. 1) << 4n) : U32))
    case False{} True{}:
      (s, (f .|. 16 : U32))
    case False{} False{}:
      (s, f)

# dyKind 0 (short) draws the sign bit 0x20 beside 0x04; 2 (same) sets 0x20
def pt.dy(k0: Bool, k2: Bool, +s: U32, f: U32) -> U32 & U32:
  match k0 k2:
    case True{} _:
      +s1 = rnd(s)
      (s1, (f .|. 4 .|. ((s1 .&. 1) << 5n) : U32))
    case False{} True{}:
      (s, (f .|. 32 : U32))
    case False{} False{}:
      (s, f)

def pt.fin(+p: U32, stream: Array<U32>, flags: Array<U32>, off: Array<U32>, pts: Array<U32>,
           w: U32, r: U32 & U32) -> Bld:
  (s, f) = r
  Bld{stream, flags[p] <- f, off, pts, s, w}

def pt.f1(+p: U32, stream: Array<U32>, flags: Array<U32>, off: Array<U32>, pts: Array<U32>,
          w: U32, +dyk: U32, r: U32 & U32) -> Bld:
  (s, f) = r
  pt.fin(p, stream, flags, off, pts, w, pt.dy(U32.is_eq(dyk, 0), U32.is_eq(dyk, 2), s, f))

# flags[p]: dxKind, dyKind, the on-curve bit, then each kind's sign draw
def pt(+p: U32, b: Bld) -> Bld:
  Bld{stream, flags, off, pts, s, w} = b
  +s1 = rnd(s)
  +s2 = rnd(s1)
  +s3 = rnd(s2)
  +dxk = U32.mod(s1, 3)
  pt.f1(p, stream, flags, off, pts, w, U32.mod(s2, 3),
    pt.dx(U32.is_eq(dxk, 0), U32.is_eq(dxk, 2), s3, (s3 .&. 1 : U32)))

def points(k: Nat, +p: U32, b: Bld) -> Bld:
  match k:
    case 0n:
      b
    case 1n+q:
      points(q, (p + 1 : U32), pt(p, b))

# while (p + run < np && flags[p + run] === flags[p] && run < 255) run++:
# the count is run < 255, the Bool the rest of the test
def run.cmp(+fp: U32, y: Array<U32> & U32) -> Array<U32> & Bool:
  (flags, x) = y
  (flags, U32.is_eq(x, fp))

def run.test(lt: Bool, +i: U32, +fp: U32, flags: Array<U32>) -> Array<U32> & Bool:
  match lt:
    case True{}:
      run.cmp(fp, flags[i])
    case False{}:
      (flags, False{})

def run.next(+run: U32, y: Array<U32> & Bool) -> (Array<U32> & U32) & Bool:
  (flags, go) = y
  ((flags, run), go)

def run.step(+np: U32, +p: U32, +fp: U32, x: Array<U32> & U32) -> (Array<U32> & U32) & Bool:
  (flags, run) = x
  +run1 = (run + 1 : U32)
  +i = (p + run1 : U32)
  run.next(run1, run.test((i < np : U32), i, fp, flags))

def run.go(k: Nat, +np: U32, +p: U32, +fp: U32, r: (Array<U32> & U32) & Bool) -> Array<U32> & U32:
  match k:
    case 0n:
      (x, go) = r
      x
    case 1n+q:
      (x, go) = r
      match go:
        case False{}:
          x
        case True{}:
          run.go(q, np, p, fp, run.step(np, p, fp, x))

# a run of 2 or more: flags[p] | 0x08, then run - 1; else flags[p] alone
def rle.put(more: Bool, +fp: U32, run: U32, +w: U32, stream: Array<U32>) -> Array<U32> & U32:
  match more:
    case True{}:
      stream[w] <- (fp .|. 8 : U32)
      (stream[(w + 1 : U32)] <- (run - 1 : U32), (w + 2 : U32))
    case False{}:
      (stream[w] <- fp, (w + 1 : U32))

def rle.f3(+np: U32, +p: U32, flags: Array<U32>, y: Array<U32> & U32) -> Rle & Bool:
  (stream, w) = y
  (Rle{stream, flags, w, p}, (p < np : U32))

def rle.f2(+np: U32, +p: U32, +w: U32, +fp: U32, stream: Array<U32>, x: Array<U32> & U32) -> Rle & Bool:
  (flags, +run) = x
  rle.f3(np, (p + run : U32), flags, rle.put((run > 1 : U32), fp, run, w, stream))

def rle.f1(+np: U32, +p: U32, +w: U32, stream: Array<U32>, y: Array<U32> & U32) -> Rle & Bool:
  (flags, +fp) = y
  +i = (p + 1 : U32)
  rle.f2(np, p, w, fp, stream, run.go(254n, np, p, fp, run.next(1, run.test((i < np : U32), i, fp, flags))))

def rle.step(+np: U32, x: Rle) -> Rle & Bool:
  Rle{stream, flags, w, +p} = x
  rle.f1(np, p, w, stream, flags[p])

# while (p < np): a run takes at least one point, so np + 1 steps of fuel
def rle(f: Nat, +np: U32, r: Rle & Bool) -> Rle:
  match f:
    case 0n:
      (x, go) = r
      x
    case 1n+q:
      (x, go) = r
      match go:
        case False{}:
          x
        case True{}:
          rle(q, np, rle.step(np, x))

# a delta: a short one is rnd() % 256; a long one (no same bit) two bytes of rnd() & 0xffff
def dl.long(long: Bool, stream: Array<U32>, flags: Array<U32>, +s: U32, +w: U32) -> Dl:
  match long:
    case True{}:
      +s1 = rnd(s)
      +d = (s1 .&. 65535 : U32)
      stream[w] <- (d >> 8n : U32)
      Dl{stream[(w + 1 : U32)] <- (d .&. 255 : U32), flags, s1, (w + 2 : U32)}
    case False{}:
      Dl{stream, flags, s, w}

def dl.kind(short: Bool, +pb: U32, +f: U32, stream: Array<U32>, flags: Array<U32>, +s: U32,
            +w: U32) -> Dl:
  match short:
    case True{}:
      +s1 = rnd(s)
      Dl{stream[w] <- U32.mod(s1, 256), flags, s1, (w + 1 : U32)}
    case False{}:
      dl.long(U32.is_eq((f .&. pb : U32), 0), stream, flags, s, w)

def dl.f1(+sb: U32, +pb: U32, stream: Array<U32>, s: U32, w: U32, y: Array<U32> & U32) -> Dl:
  (flags, +f) = y
  dl.kind(U32.is_ne((f .&. sb : U32), 0), pb, f, stream, flags, s, w)

def dl.step(+sb: U32, +pb: U32, +i: U32, x: Dl) -> Dl:
  Dl{stream, flags, s, w} = x
  dl.f1(sb, pb, stream, s, w, flags[i])

def deltas(k: Nat, +sb: U32, +pb: U32, +i: U32, x: Dl) -> Dl:
  match k:
    case 0n:
      x
    case 1n+q:
      deltas(q, sb, pb, (i + 1 : U32), dl.step(sb, pb, i, x))

def bg.fin(off: Array<U32>, pts: Array<U32>, x: Dl) -> Bld:
  Dl{stream, flags, s, w} = x
  Bld{stream, flags, off, pts, s, w}

# the x deltas (short 0x02, same 0x10), then the y deltas (0x04, 0x20)
def bg.deltas(+np: U32, off: Array<U32>, pts: Array<U32>, s: U32, x: Rle) -> Bld:
  Rle{stream, flags, w, p} = x
  +k = U32.to_nat(np)
  bg.fin(off, pts, deltas(k, 4, 32, 0, deltas(k, 2, 16, 0, Dl{stream, flags, s, w})))

def bg.rle(+np: U32, b: Bld) -> Bld:
  Bld{stream, flags, off, pts, s, w} = b
  bg.deltas(np, off, pts, s, rle(U32.to_nat((np + 1 : U32)), np, (Rle{stream, flags, w, 0}, (0 < np : U32))))

# glyphOff[g] = w; np = 20 + rnd() % 101; the flags, their runs, the deltas
def bg(+g: U32, b: Bld) -> Bld:
  Bld{stream, flags, off, pts, s, +w} = b
  +s1 = rnd(s)
  +np = (20 + U32.mod(s1, 101) : U32)
  bg.rle(np, points(U32.to_nat(np), 0, Bld{stream, flags, off[g] <- w, pts[g] <- np, s1, w}))

def build(k: Nat, +g: U32, b: Bld) -> Bld:
  match k:
    case 0n:
      b
    case 1n+q:
      build(q, (g + 1 : U32), bg(g, b))

# while (rep > 0) { flagBuf[p++] = f; rep-- }
def rep(k: Nat, +f: U32, +p: U32, fb: Array<U32>) -> Array<U32> & U32:
  match k:
    case 0n:
      (fb, p)
    case 1n+q:
      rep(q, f, (p + 1 : U32), fb[p] <- f)

def flag.fin(+np: U32, stream: Array<U32>, r: U32, z: Array<U32> & U32) -> Fl & Bool:
  (fb, +p) = z
  (Fl{stream, fb, r, p}, (p < np : U32))

def flag.run(+np: U32, f: U32, fb: Array<U32>, r: U32, p: U32, y: Array<U32> & U32) -> Fl & Bool:
  (stream, n) = y
  flag.fin(np, stream, r, rep(U32.to_nat(n), f, p, fb))

# f & 0x08: rep = stream[r++] more copies
def flag.more(isrep: Bool, +np: U32, f: U32, stream: Array<U32>, fb: Array<U32>, +r: U32,
              +p: U32) -> Fl & Bool:
  match isrep:
    case True{}:
      flag.run(np, f, fb, (r + 1 : U32), p, stream[r])
    case False{}:
      (Fl{stream, fb, r, p}, (p < np : U32))

# f = stream[r++]; flagBuf[p++] = f
def flag.f1(+np: U32, fb: Array<U32>, +r: U32, +p: U32, y: Array<U32> & U32) -> Fl & Bool:
  (stream, +f) = y
  flag.more(U32.is_ne((f .&. 8 : U32), 0), np, f, stream, fb[p] <- f, (r + 1 : U32), (p + 1 : U32))

def flag.step(+np: U32, x: Fl) -> Fl & Bool:
  Fl{stream, fb, +r, p} = x
  flag.f1(np, fb, r, p, stream[r])

# while (p < np): a flag takes at least one point, so np + 1 steps of fuel
def flags(f: Nat, +np: U32, z: Fl & Bool) -> Fl:
  match f:
    case 0n:
      (x, go) = z
      x
    case 1n+q:
      (x, go) = z
      match go:
        case False{}:
          x
        case True{}:
          flags(q, np, flag.step(np, x))

# (w << 16) >> 16 on an int32, w already shifted: the sign bit fills the top 16
def sext(+s: U32) -> U32:
  Bool.pick(U32, (s >= 2147483648 : U32), ((s >> 16n) .|. 4294901760 : U32), (s >> 16n : U32))

# x = (f & pos) ? x + d : x - d
def coord.add(pos: Bool, +v: U32, d: U32) -> U32:
  match pos:
    case True{}:
      (v + d : U32)
    case False{}:
      (v - d : U32)

# a short delta: d = stream[r++]; h = mix(h, x)
def coord.s(+pb: U32, +f: U32, fb: Array<U32>, +r: U32, v: U32, on: U32, h: U32,
            y: Array<U32> & U32) -> Ax:
  (stream, d) = y
  +v1 = coord.add(U32.is_ne((f .&. pb : U32), 0), v, d)
  Ax{stream, fb, (r + 1 : U32), v1, on, B.mix(h, v1)}

# a long delta: x += ((stream[r] << 8) | stream[r + 1]) << 16 >> 16; r += 2
def coord.l2(hi: U32, fb: Array<U32>, +r: U32, v: U32, on: U32, h: U32, y: Array<U32> & U32) -> Ax:
  (stream, lo) = y
  +v1 = (v + sext((((hi << 8n) .|. lo) << 16n : U32)) : U32)
  Ax{stream, fb, (r + 2 : U32), v1, on, B.mix(h, v1)}

def coord.l1(fb: Array<U32>, +r: U32, v: U32, on: U32, h: U32, y: Array<U32> & U32) -> Ax:
  (stream, hi) = y
  coord.l2(hi, fb, r, v, on, h, stream[(r + 1 : U32)])

# no same bit: a long delta; else the coordinate repeats
def coord.same(long: Bool, fb: Array<U32>, +r: U32, +v: U32, on: U32, h: U32,
               stream: Array<U32>) -> Ax:
  match long:
    case True{}:
      coord.l1(fb, r, v, on, h, stream[r])
    case False{}:
      Ax{stream, fb, r, v, on, B.mix(h, v)}

def coord.kind(short: Bool, +pb: U32, +f: U32, stream: Array<U32>, fb: Array<U32>, +r: U32,
               v: U32, on: U32, h: U32) -> Ax:
  match short:
    case True{}:
      coord.s(pb, f, fb, r, v, on, h, stream[r])
    case False{}:
      coord.same(U32.is_eq((f .&. pb : U32), 0), fb, r, v, on, h, stream)

# one point of a coordinate whose short bit is sb and same/positive bit pb
def coord(+sb: U32, +pb: U32, +f: U32, a: Ax) -> Ax:
  Ax{stream, fb, r, v, on, h} = a
  coord.kind(U32.is_ne((f .&. sb : U32), 0), pb, f, stream, fb, r, v, on, h)

# f = flagBuf[i]; x by bits 0x02 and 0x10; onCount += f & 1
def x.f1(stream: Array<U32>, r: U32, v: U32, on: U32, h: U32, y: Array<U32> & U32) -> Ax:
  (fb, +f) = y
  coord(2, 16, f, Ax{stream, fb, r, v, (on + (f .&. 1) : U32), h})

def x.step(+i: U32, a: Ax) -> Ax:
  Ax{stream, fb, r, v, on, h} = a
  x.f1(stream, r, v, on, h, fb[i])

def xs(k: Nat, +i: U32, a: Ax) -> Ax:
  match k:
    case 0n:
      a
    case 1n+q:
      xs(q, (i + 1 : U32), x.step(i, a))

# f = flagBuf[i]; y by bits 0x04 and 0x20
def y.f1(stream: Array<U32>, r: U32, v: U32, on: U32, h: U32, y: Array<U32> & U32) -> Ax:
  (fb, +f) = y
  coord(4, 32, f, Ax{stream, fb, r, v, on, h})

def y.step(+i: U32, a: Ax) -> Ax:
  Ax{stream, fb, r, v, on, h} = a
  y.f1(stream, r, v, on, h, fb[i])

def ys(k: Nat, +i: U32, a: Ax) -> Ax:
  match k:
    case 0n:
      a
    case 1n+q:
      ys(q, (i + 1 : U32), y.step(i, a))

# h = mix(h, onCount)
def glyph.fin(off: Array<U32>, pts: Array<U32>, a: Ax) -> Font & U32:
  Ax{stream, fb, r, v, on, h} = a
  (Font{stream, off, pts, fb}, B.mix(h, on))

def glyph.y(+np: U32, off: Array<U32>, pts: Array<U32>, a: Ax) -> Font & U32:
  Ax{stream, fb, r, v, on, h} = a
  glyph.fin(off, pts, ys(U32.to_nat(np), 0, Ax{stream, fb, r, 0, on, h}))

def glyph.x(+np: U32, off: Array<U32>, pts: Array<U32>, h: U32, z: Fl) -> Font & U32:
  Fl{stream, fb, r, p} = z
  glyph.y(np, off, pts, xs(U32.to_nat(np), 0, Ax{stream, fb, r, 0, 0, h}))

def glyph.f2(r: U32, h: U32, stream: Array<U32>, fb: Array<U32>, off: Array<U32>,
             y: Array<U32> & U32) -> Font & U32:
  (pts, +np) = y
  glyph.x(np, off, pts, h, flags(U32.to_nat((np + 1 : U32)), np, (Fl{stream, fb, r, 0}, (0 < np : U32))))

# r = glyphOff[g], np = glyphPts[g]; the flags, then x, then y
def glyph.f1(+g: U32, h: U32, stream: Array<U32>, fb: Array<U32>, pts: Array<U32>,
             y: Array<U32> & U32) -> Font & U32:
  (off, r) = y
  glyph.f2(r, h, stream, fb, off, pts[g])

def glyph(+g: U32, s: Font & U32) -> Font & U32:
  (f, h) = s
  Font{stream, off, pts, fb} = f
  glyph.f1(g, h, stream, fb, pts, off[g])

def glyphs(k: Nat, +g: U32, s: Font & U32) -> Font & U32:
  match k:
    case 0n:
      s
    case 1n+q:
      glyphs(q, (g + 1 : U32), glyph(g, s))

# h = mix(h, parseAll()), 12 times
def run.mix(h: U32, r: Font & U32) -> Font & U32:
  (f, x) = r
  (f, B.mix(h, x))

def run_kernel(k: Nat, s: Font & U32) -> Font & U32:
  match k:
    case 0n:
      s
    case 1n+q:
      (f, h) = s
      run_kernel(q, run.mix(h, glyphs(U32.to_nat(ng()), 0, (f, 2166136261))))

# acc = mix(acc, runKernel()), the warm-up runs and the timed ones alike
def kernel(s: Font & U32) -> Font & U32:
  (f, acc) = s
  run.mix(acc, run_kernel(12n, (f, 0)))

def checksum(s: Font & U32) -> U32:
  (f, acc) = s
  acc

def font(b: Bld) -> Font:
  Bld{stream, flags, off, pts, s, w} = b
  Font{stream, off, pts, [0 : U32*128n]}

def main() -> IO(Unit):
  f = font(build(U32.to_nat(ng()), 0,
    Bld{[0 : U32*524288n], [0 : U32*128n], [0 : U32*1024n], [0 : U32*1024n], 149017509, 0}))
  s = B.warm(~Font & U32, ~(r => r), ~kernel, 5n, (f, 0))
  do IO<Unit>:
    r : (Font & U32) & List<&2, U32> <- B.timed(~Font & U32, ~(r => r), ~kernel, 21n, s, [])
    B.finish(~Font & U32, ~checksum, (ng() * 12 : U32), 1, 21, r)
