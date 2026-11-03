import Base
import ../_lib/bench.bend as B
# shapes.bend: Bend port of shapes.js (same records, passes and checksum): a
# heterogeneous record stream of 8 shapes, each measured by its own formula.
# The shapes are one datatype of 8 constructors, the stream an Array<Shape>,
# and measure one match. Bend has no signed integer: |dx| reads the sign bit
# of the U32 difference.

type Shape is Data:
  Pt{x: U32, y: U32}
  Circle{r: U32}
  Rect{w: U32, h: U32}
  Seg{x0: U32, y0: U32, x1: U32, y1: U32}
  Tri{a: U32, b: U32, c: U32}
  Box{w: U32, h: U32, d: U32}
  Ring{r: U32, s: U32}
  Star{n: U32, s: U32}

def n() -> U32:
  16384

def shape(k: Nat, +a: U32, +b: U32, +c: U32) -> Shape:
  match k:
    case 0n:
      Pt{a, b}
    case 1n:
      Circle{a}
    case 2n:
      Rect{a, b}
    case 3n:
      Seg{a, b, c, ((a .^. b) .&. 511 : U32)}
    case 4n:
      Tri{a, b, c}
    case 5n:
      Box{a, b, c}
    case 6n:
      Ring{a, b}
    case 7n+q:
      Star{c, b}

# Deterministic records: XorShift32 picks each record's shape and fields.
def init(k: Nat, +i: U32, +s: U32, rows: Array<Shape>) -> Array<Shape>:
  match k:
    case 0n:
      rows
    case 1n+p:
      +s1 = (s .^. (s << 13n) : U32)
      +s2 = (s1 .^. (s1 >> 17n) : U32)
      +s3 = (s2 .^. (s2 << 5n) : U32)
      init(p, (i + 1 : U32), s3, Array.set(Shape, rows, i,
        shape(U32.to_nat((s3 .&. 7 : U32)), (s3 >> 3n .&. 1023 : U32),
          (s3 >> 13n .&. 1023 : U32), (s3 >> 23n .&. 511 : U32))))

def abs(+d: U32) -> U32:
  Bool.pick(U32, (d >= 2147483648 : U32), (0 - d : U32), d)

def measure(o: Shape) -> U32:
  match o:
    case Pt{x, y}:
      (x + y : U32)
    case Circle{+r}:
      (r * (r * 3) : U32)
    case Rect{w, h}:
      (w * h : U32)
    case Seg{x0, y0, x1, y1}:
      (abs((x1 - x0 : U32)) + abs((y1 - y0 : U32)) : U32)
    case Tri{a, b, c}:
      (a + b + c : U32)
    case Box{w, h, d}:
      (w * h - d : U32)
    case Ring{+r, s}:
      (r * s + r : U32)
    case Star{n, +s}:
      (n * (s * s) : U32)

def add(sum: U32, r: Array<Shape> & Shape) -> Array<Shape> & U32:
  (rows, o) = r
  (rows, (sum + measure(o) : U32))

def row(+i: U32, r: Array<Shape> & U32) -> Array<Shape> & U32:
  (rows, sum) = r
  add(sum, Array.get(Shape, rows, i))

def rows(k: Nat, +i: U32, r: Array<Shape> & U32) -> Array<Shape> & U32:
  match k:
    case 0n:
      r
    case 1n+p:
      rows(p, (i + 1 : U32), row(i, r))

def pass.mix(h: U32, r: Array<Shape> & U32) -> Array<Shape> & U32:
  (rs, sum) = r
  (rs, B.mix(h, sum))

def pass(+it: U32, r: Array<Shape> & U32) -> Array<Shape> & U32:
  (rs, h) = r
  pass.mix(h, rows(U32.to_nat(n()), 0, (rs, it)))

def passes(k: Nat, +it: U32, r: Array<Shape> & U32) -> Array<Shape> & U32:
  match k:
    case 0n:
      r
    case 1n+p:
      passes(p, (it + 1 : U32), pass(it, r))

def kernel(r: Array<Shape> & U32) -> Array<Shape> & U32:
  (rs, h) = r
  passes(48n, 0, (rs, 2166136261))

def checksum(r: Array<Shape> & U32) -> U32:
  (rs, h) = r
  h

def main() -> IO(Unit):
  rs = init(U32.to_nat(n()), 0, 305441741, [Circle{0} : Shape*16384n])
  s = B.warm(~Array<Shape> & U32, ~(r => r), ~kernel, 5n, (rs, 0))
  do IO<Unit>:
    r : (Array<Shape> & U32) & List<&2, U32> <- B.timed(~Array<Shape> & U32, ~(r => r), ~kernel, 21n, s, [])
    B.finish(~Array<Shape> & U32, ~checksum, (n() * 48 : U32), 8, 21, r)
