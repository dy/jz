import Base
import ../_lib/bench.bend as B
# trace.bend: Bend port of trace.js (same bitmap, scan, passes and checksum):
# square-tracing contour following over a 512x512 bitmap of circles, each
# untraced boundary pixel walked (on ink turn left, on paper turn right, step
# forward) until the walk returns to its start pose, a chain code per step.
# The walk's bound is a test: it counts MAXCODES steps down as a Nat and
# answers its state beside the Bool that it has not returned to the start.
# The scan's three-part test, and the walk's bounds test before its pixel
# read, are chains of defs taking the caller's Bool, so a read happens only
# where the JS's && reaches it. Bend has no signed integer: x >= 0 is a sign
# test of bit 31, and a circle's dx and dy wrap in the U32, their squares
# exact as the int32's.

type Img is Type:
  Img{bmp: Array<U32>, visited: Array<U32>, codes: Array<U32>}

# the walk: the arrays, x, y, dir and nc
type Tr is Type:
  Tr{bmp: Array<U32>, visited: Array<U32>, codes: Array<U32>, x: U32, y: U32, dir: U32, nc: U32}

# the scan: the arrays, nc and h
type Sc is Type:
  Sc{bmp: Array<U32>, visited: Array<U32>, codes: Array<U32>, nc: U32, h: U32}

def w() -> U32:
  512

def maxcodes() -> U32:
  262144

def rnd(+s: U32) -> U32:
  +s1 = (s .^. (s << 13n) : U32)
  +s2 = (s1 .^. (s1 >> 17n) : U32)
  (s2 .^. (s2 << 5n) : U32)

def clear(k: Nat, +i: U32, a: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      a
    case 1n+p:
      clear(p, (i + 1 : U32), a[i] <- 0)

# if (dx * dx + dy * dy <= r2) bmp[y * W + x] = fill
def disc.put(on: Bool, +i: U32, fill: U32, bmp: Array<U32>) -> Array<U32>:
  match on:
    case True{}:
      bmp[i] <- fill
    case False{}:
      bmp

def disc.cols(k: Nat, +x: U32, +cx: U32, +y: U32, +dy: U32, +r2: U32, +fill: U32,
              bmp: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      bmp
    case 1n+p:
      +dx = (x - cx : U32)
      disc.cols(p, (x + 1 : U32), cx, y, dy, r2, fill,
        disc.put(((dx * dx) + (dy * dy) <= r2 : U32), (y * w() + x : U32), fill, bmp))

# for (y = cy - r; y <= cy + r; y++), for (x = cx - r; x <= cx + r; x++)
def disc.rows(k: Nat, +y: U32, +cx: U32, +cy: U32, +r: U32, +r2: U32, +fill: U32,
              bmp: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      bmp
    case 1n+p:
      disc.rows(p, (y + 1 : U32), cx, cy, r, r2, fill,
        disc.cols(U32.to_nat((r * 2 + 1 : U32)), (cx - r : U32), cx, y, (y - cy : U32), r2, fill, bmp))

# a circle at 44 + rnd() % (W - 88), radius 8 + rnd() % 33; every 5th
# punches a lake
def disc(+c: U32, s: Array<U32> & U32) -> Array<U32> & U32:
  (bmp, s0) = s
  +s1 = rnd(s0)
  +s2 = rnd(s1)
  +s3 = rnd(s2)
  +cx = (44 + U32.mod(s1, 424) : U32)
  +cy = (44 + U32.mod(s2, 424) : U32)
  +r = (8 + U32.mod(s3, 33) : U32)
  +fill = Bool.pick(U32, U32.is_eq(U32.mod(c, 5), 4), 0, 1)
  (disc.rows(U32.to_nat((r * 2 + 1 : U32)), (cy - r : U32), cx, cy, r, (r * r : U32), fill, bmp), s3)

def discs(k: Nat, +c: U32, s: Array<U32> & U32) -> Array<U32> & U32:
  match k:
    case 0n:
      s
    case 1n+p:
      discs(p, (c + 1 : U32), disc(c, s))

def bitmap(bmp: Array<U32>) -> Array<U32>:
  Pair.fst(Array<U32>, U32, discs(42n, 0, (clear(262144n, 0, bmp), 85780387)))

def nonneg(x: U32) -> Bool:
  U32.is_eq((x >> 31n : U32), 0)

# x, y one step along dir: 0 = E, 1 = S, 2 = W, else N
def mv.w(west: Bool, +x: U32, +y: U32) -> U32 & U32:
  match west:
    case True{}:
      ((x - 1 : U32), y)
    case False{}:
      (x, (y - 1 : U32))

def mv.s(south: Bool, +dir: U32, +x: U32, +y: U32) -> U32 & U32:
  match south:
    case True{}:
      (x, (y + 1 : U32))
    case False{}:
      mv.w(U32.is_eq(dir, 2), x, y)

def mv(east: Bool, +dir: U32, +x: U32, +y: U32) -> U32 & U32:
  match east:
    case True{}:
      ((x + 1 : U32), y)
    case False{}:
      mv.s(U32.is_eq(dir, 1), dir, x, y)

# steps++; the walk goes on unless x === sx && y === sy && dir === 3
def tl.end(+sx: U32, +sy: U32, +dir: U32, bmp: Array<U32>, visited: Array<U32>,
           r: Array<U32> & U32, xy: U32 & U32) -> Tr & Bool:
  (codes, nc) = r
  (+x, +y) = xy
  (Tr{bmp, visited, codes, x, y, dir, nc},
    Bool.not(U32.is_eq(x, sx) && U32.is_eq(y, sy) && U32.is_eq(dir, 3)))

# if (nc < MAXCODES) codes[nc++] = dir
def tl.emit(lt: Bool, +nc: U32, dir: U32, codes: Array<U32>) -> Array<U32> & U32:
  match lt:
    case True{}:
      (codes[nc] <- dir, (nc + 1 : U32))
    case False{}:
      (codes, nc)

def tl.code(+sx: U32, +sy: U32, x: U32, y: U32, codes: Array<U32>, +nc: U32, bmp: Array<U32>,
            r: Array<U32> & U32) -> Tr & Bool:
  (visited, +dir) = r
  tl.end(sx, sy, dir, bmp, visited, tl.emit((nc < maxcodes() : U32), nc, dir, codes),
    mv(U32.is_eq(dir, 0), dir, x, y))

# on ink: visited[i] = 1, turn left; on paper: turn right
def tl.turn(ink: Bool, +i: U32, dir: U32, visited: Array<U32>) -> Array<U32> & U32:
  match ink:
    case True{}:
      (visited[i] <- 1, ((dir + 3) .&. 3 : U32))
    case False{}:
      (visited, ((dir + 1) .&. 3 : U32))

def tl.f1(+sx: U32, +sy: U32, x: U32, y: U32, +i: U32, dir: U32, nc: U32, visited: Array<U32>,
          codes: Array<U32>, r: Array<U32> & Bool) -> Tr & Bool:
  (bmp, ink) = r
  tl.code(sx, sy, x, y, codes, nc, bmp, tl.turn(ink, i, dir, visited))

def tl.ink(r: Array<U32> & U32) -> Array<U32> & Bool:
  (bmp, v) = r
  (bmp, U32.is_eq(v, 1))

# bmp[y * W + x] === 1, read only inside the bitmap
def tl.inside(inb: Bool, +i: U32, bmp: Array<U32>) -> Array<U32> & Bool:
  match inb:
    case True{}:
      tl.ink(bmp[i])
    case False{}:
      (bmp, False{})

def tl.step(+sx: U32, +sy: U32, t: Tr) -> Tr & Bool:
  Tr{bmp, visited, codes, +x, +y, dir, nc} = t
  +i = (y * w() + x : U32)
  tl.f1(sx, sy, x, y, i, dir, nc, visited, codes,
    tl.inside(nonneg(x) && (x < w() : U32) && nonneg(y) && (y < w() : U32), i, bmp))

# while (steps < MAXCODES), until the walk returns to its start pose
def tl(k: Nat, +sx: U32, +sy: U32, r: Tr & Bool) -> Tr:
  match k:
    case 0n:
      (t, go) = r
      t
    case 1n+p:
      (t, go) = r
      match go:
        case False{}:
          t
        case True{}:
          tl(p, sx, sy, tl.step(sx, sy, t))

# h = mix(h, nc - start) | 0
def sc.fin(+start: U32, h: U32, t: Tr) -> Sc:
  Tr{bmp, visited, codes, x, y, dir, +nc} = t
  Sc{bmp, visited, codes, nc, B.mix(h, (nc - start : U32))}

# not yet traced: walk from (x, y) heading north
def sc.go(fresh: Bool, +x: U32, +y: U32, bmp: Array<U32>, codes: Array<U32>, +nc: U32, h: U32,
          visited: Array<U32>) -> Sc:
  match fresh:
    case True{}:
      sc.fin(nc, h, tl(U32.to_nat(maxcodes()), x, y, (Tr{bmp, visited, codes, x, y, 3, nc}, True{})))
    case False{}:
      Sc{bmp, visited, codes, nc, h}

def sc.vis(x: U32, y: U32, bmp: Array<U32>, codes: Array<U32>, nc: U32, h: U32,
           r: Array<U32> & U32) -> Sc:
  (visited, v) = r
  sc.go(U32.is_eq(v, 0), x, y, bmp, codes, nc, h, visited)

# paper to the west: visited[y * W + x] === 0
def sc.west(paper: Bool, x: U32, y: U32, +i: U32, codes: Array<U32>, nc: U32, h: U32,
            visited: Array<U32>, bmp: Array<U32>) -> Sc:
  match paper:
    case True{}:
      sc.vis(x, y, bmp, codes, nc, h, visited[i])
    case False{}:
      Sc{bmp, visited, codes, nc, h}

def sc.w(x: U32, y: U32, i: U32, visited: Array<U32>, codes: Array<U32>, nc: U32, h: U32,
         r: Array<U32> & U32) -> Sc:
  (bmp, v) = r
  sc.west(U32.is_eq(v, 0), x, y, i, codes, nc, h, visited, bmp)

# ink: bmp[y * W + x - 1] === 0
def sc.ink(ink: Bool, x: U32, y: U32, +i: U32, visited: Array<U32>, codes: Array<U32>, nc: U32,
           h: U32, bmp: Array<U32>) -> Sc:
  match ink:
    case True{}:
      sc.w(x, y, i, visited, codes, nc, h, bmp[(i - 1 : U32)])
    case False{}:
      Sc{bmp, visited, codes, nc, h}

def sc.f1(x: U32, y: U32, i: U32, visited: Array<U32>, codes: Array<U32>, nc: U32, h: U32,
          r: Array<U32> & U32) -> Sc:
  (bmp, v) = r
  sc.ink(U32.is_eq(v, 1), x, y, i, visited, codes, nc, h, bmp)

# a boundary start: bmp[y * W + x] === 1
def sc.step(+x: U32, +y: U32, s: Sc) -> Sc:
  Sc{bmp, visited, codes, nc, h} = s
  +i = (y * w() + x : U32)
  sc.f1(x, y, i, visited, codes, nc, h, bmp[i])

def cols(k: Nat, +x: U32, +y: U32, s: Sc) -> Sc:
  match k:
    case 0n:
      s
    case 1n+p:
      cols(p, (x + 1 : U32), y, sc.step(x, y, s))

# for (y = 1; y < H - 1; y++), for (x = 1; x < W - 1; x++)
def rows(k: Nat, +y: U32, s: Sc) -> Sc:
  match k:
    case 0n:
      s
    case 1n+p:
      rows(p, (y + 1 : U32), cols(510n, 1, y, s))

# mix(h, nc)
def trace_all.fin(s: Sc) -> Img & U32:
  Sc{bmp, visited, codes, +nc, h} = s
  (Img{bmp, visited, codes}, B.mix(h, nc))

def trace_all(im: Img) -> Img & U32:
  Img{bmp, visited, codes} = im
  trace_all.fin(rows(510n, 1, Sc{bmp, clear(262144n, 0, visited), codes, 0, 0}))

# h = mix(h, traceAll()), 4 times
def run.mix(h: U32, r: Img & U32) -> Img & U32:
  (im, x) = r
  (im, B.mix(h, x))

def run_kernel(k: Nat, s: Img & U32) -> Img & U32:
  match k:
    case 0n:
      s
    case 1n+p:
      (im, h) = s
      run_kernel(p, run.mix(h, trace_all(im)))

# acc = mix(acc, runKernel()), the warm-up runs and the timed ones alike
def kernel(s: Img & U32) -> Img & U32:
  (im, acc) = s
  run.mix(acc, run_kernel(4n, (im, 0)))

# h = mix(FNV, acc), then every 64th code
def checksum(s: Img & U32) -> U32:
  (im, acc) = s
  Img{bmp, visited, codes} = im
  Pair.snd(Array<U32>, U32, B.checksum.go(4096n, 64, 0, (codes, B.mix(2166136261, acc))))

def main() -> IO(Unit):
  s = B.warm(~Img & U32, ~(r => r), ~kernel, 5n,
    (Img{bitmap([0 : U32*262144n]), [0 : U32*262144n], [0 : U32*262144n]}, 0))
  do IO<Unit>:
    r : (Img & U32) & List<&2, U32> <- B.timed(~Img & U32, ~(r => r), ~kernel, 21n, s, [])
    B.finish(~Img & U32, ~checksum, (262144 * 4 : U32), 1, 21, r)
