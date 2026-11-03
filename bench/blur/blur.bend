import Base
import ../_lib/bench.bend as B
# blur.bend: Bend port of blur.js (same image, radius and checksum): a
# separable box blur of an RGBA image, a horizontal then a vertical pass,
# each output byte the mean of its 9-tap window, edge-clamped. Bend has no
# signed integer, so the window offset k runs over [0, 2R] and the clamp
# tests compare unsigned: x + k - R < 0 is x + k < R.

type Img is Type:
  Img{img: Array<U32>, tmp: Array<U32>, out: Array<U32>}

type Sum is Type:
  Sum{src: Array<U32>, r: U32, g: U32, b: U32, a: U32}

def w() -> U32:
  512

def h() -> U32:
  512

def rad() -> U32:
  4

def n() -> U32:
  1048576

# Deterministic RGBA noise: XorShift32 bytes.
def noise(k: Nat, +i: U32, +s: U32, a: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      a
    case 1n+p:
      +s1 = (s .^. (s << 13n) : U32)
      +s2 = (s1 .^. (s1 >> 17n) : U32)
      +s3 = (s2 .^. (s2 << 5n) : U32)
      noise(p, (i + 1 : U32), s3, a[i] <- (s3 .&. 255 : U32))

# clamp(v - R, 0, m - 1) for v = x + k
def clamp.hi(over: Bool, +v: U32, +m: U32) -> U32:
  match over:
    case True{}:
      (m - 1 : U32)
    case False{}:
      (v - rad() : U32)

def clamp.lo(under: Bool, +v: U32, +m: U32) -> U32:
  match under:
    case True{}:
      0
    case False{}:
      clamp.hi((v - rad() >= m : U32), v, m)

def clamp(+v: U32, +m: U32) -> U32:
  clamp.lo((v < rad() : U32), v, m)

# sr += src[p]; sg += src[p+1]; sb += src[p+2]; sa += src[p+3]
def tap.c3(r: U32, g: U32, b: U32, a: U32, x: Array<U32> & U32) -> Sum:
  (src, v) = x
  Sum{src, r, g, b, (a + v : U32)}

def tap.c2(+p: U32, r: U32, g: U32, b: U32, a: U32, x: Array<U32> & U32) -> Sum:
  (src, v) = x
  tap.c3(r, g, (b + v : U32), a, src[(p + 3 : U32)])

def tap.c1(+p: U32, r: U32, g: U32, b: U32, a: U32, x: Array<U32> & U32) -> Sum:
  (src, v) = x
  tap.c2(p, r, (g + v : U32), b, a, src[(p + 2 : U32)])

def tap.c0(+p: U32, r: U32, g: U32, b: U32, a: U32, x: Array<U32> & U32) -> Sum:
  (src, v) = x
  tap.c1(p, (r + v : U32), g, b, a, src[(p + 1 : U32)])

def tap(+p: U32, s: Sum) -> Sum:
  Sum{src, r, g, b, a} = s
  tap.c0(p, r, g, b, a, src[p])

# the tap's byte offset: ((row + xi) << 2) across, ((yi * w + x) << 2) down
def pos(horiz: Bool, +kk: U32, +x: U32, +y: U32) -> U32:
  match horiz:
    case True{}:
      ((y * w() + clamp((x + kk : U32), w())) << 2n : U32)
    case False{}:
      ((clamp((y + kk : U32), h()) * w() + x) << 2n : U32)

def taps(k: Nat, +kk: U32, +x: U32, +y: U32, +horiz: Bool, s: Sum) -> Sum:
  match k:
    case 0n:
      s
    case 1n+q:
      taps(q, (kk + 1 : U32), x, y, horiz, tap(pos(horiz, kk, x, y), s))

def put(+o: U32, dst: Array<U32>, s: Sum) -> Array<U32> & Array<U32>:
  Sum{src, r, g, b, a} = s
  dst[o] <- U32.div(r, 9)
  dst[(o + 1 : U32)] <- U32.div(g, 9)
  dst[(o + 2 : U32)] <- U32.div(b, 9)
  (src, dst[(o + 3 : U32)] <- U32.div(a, 9))

def pixel(+x: U32, +y: U32, horiz: Bool, r: Array<U32> & Array<U32>) -> Array<U32> & Array<U32>:
  (src, dst) = r
  put(((y * w() + x) << 2n : U32), dst, taps(9n, 0, x, y, horiz, Sum{src, 0, 0, 0, 0}))

def pixels(k: Nat, +x: U32, +y: U32, +horiz: Bool, r: Array<U32> & Array<U32>) -> Array<U32> & Array<U32>:
  match k:
    case 0n:
      r
    case 1n+p:
      pixels(p, (x + 1 : U32), y, horiz, pixel(x, y, horiz, r))

def lines(k: Nat, +y: U32, +horiz: Bool, r: Array<U32> & Array<U32>) -> Array<U32> & Array<U32>:
  match k:
    case 0n:
      r
    case 1n+p:
      lines(p, (y + 1 : U32), horiz, pixels(U32.to_nat(w()), 0, y, horiz, r))

def blur.fin(img: Array<U32>, r: Array<U32> & Array<U32>) -> Img:
  (tmp, out) = r
  Img{img, tmp, out}

def blur.down(out: Array<U32>, r: Array<U32> & Array<U32>) -> Img:
  (img, tmp) = r
  blur.fin(img, lines(U32.to_nat(h()), 0, False{}, (tmp, out)))

def kernel(s: Img) -> Img:
  Img{img, tmp, out} = s
  blur.down(out, lines(U32.to_nat(h()), 0, True{}, (img, tmp)))

def checksum(s: Img) -> U32:
  Img{img, tmp, out} = s
  B.checksum_u8(U32.to_nat(n()), out)

def main() -> IO(Unit):
  img = noise(U32.to_nat(n()), 0, 305441741, [0 : U32*1048576n])
  s = B.warm(~Img, ~(s => s), ~kernel, 5n, Img{img, [0 : U32*1048576n], [0 : U32*1048576n]})
  do IO<Unit>:
    r : Img & List<&2, U32> <- B.timed(~Img, ~(s => s), ~kernel, 21n, s, [])
    B.finish(~Img, ~checksum, (w() * h() : U32), 9, 21, r)
