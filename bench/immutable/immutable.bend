import Base
import ../_lib/bench.bend as B
# immutable.bend: Bend port of immutable.js (same particles, steps and
# checksum): 4096 particles bouncing in a box, every step replacing each
# particle with a fresh record. The particles are a list of P records, each
# step a pass that opens every record and builds its successor, in order.
# Bend has no signed integer: a velocity is a U32 in two's complement, and a
# step past the box's low edge wraps above LIM, so the bounce test
# nx < 0 || nx > LIM is the one unsigned test nx > LIM.

type P is Data:
  P{x: U32, y: U32, vx: U32, vy: U32}

def n() -> Nat:
  4096n

def lim() -> U32:
  1023

def speed(+v: U32) -> U32:
  Bool.pick(U32, U32.is_zero(v), 1, v)

# Deterministic initial state: XorShift32 positions in [0, LIM], velocities
# in [-8, 8] forced nonzero.
def init(k: Nat, +s: U32) -> List<P>:
  match k:
    case 0n:
      Nil{}
    case 1n+p:
      +s1 = (s .^. (s << 13n) : U32)
      +s2 = (s1 .^. (s1 >> 17n) : U32)
      +s3 = (s2 .^. (s2 << 5n) : U32)
      P{(s3 >> 12n .&. lim() : U32), (s3 >> 20n .&. lim() : U32),
        speed(((s3 >> 4n .&. 15) - 8 : U32)), speed(((s3 >> 8n .&. 15) - 8 : U32))}
        <> init(p, s3)

# a fresh particle set before every run, outside the clock
def fresh(s: List<P> & U32) -> List<P> & U32:
  (init(n(), 305441741), 0)

def cons(p: P, r: List<P> & U32) -> List<P> & U32:
  (ps, sum) = r
  (p <> ps, sum)

# one step: each particle moves, bouncing off a wall it would cross;
# sum = sum + x + imul(y, 31)
def step(ps: List<P>, sum: U32) -> List<P> & U32:
  match ps:
    case Nil{}:
      (Nil{}, sum)
    case P{+x, +y, +vx, +vy} <> t:
      +nx = (x + vx : U32)
      +ny = (y + vy : U32)
      +hx = (nx > lim() : U32)
      +hy = (ny > lim() : U32)
      +x2 = Bool.pick(U32, hx, x, nx)
      +y2 = Bool.pick(U32, hy, y, ny)
      cons(P{x2, y2, Bool.pick(U32, hx, (0 - vx : U32), vx), Bool.pick(U32, hy, (0 - vy : U32), vy)},
        step(t, (sum + x2 + y2 * 31 : U32)))

def steps.mix(h: U32, r: List<P> & U32) -> List<P> & U32:
  (ps, sum) = r
  (ps, B.mix(h, sum))

def steps.next(+it: U32, r: List<P> & U32) -> List<P> & U32:
  (ps, h) = r
  steps.mix(h, step(ps, it))

def steps(k: Nat, +it: U32, r: List<P> & U32) -> List<P> & U32:
  match k:
    case 0n:
      r
    case 1n+p:
      steps(p, (it + 1 : U32), steps.next(it, r))

def kernel(r: List<P> & U32) -> List<P> & U32:
  (ps, h) = r
  steps(32n, 0, (ps, 2166136261))

def checksum(r: List<P> & U32) -> U32:
  (ps, h) = r
  h

def main() -> IO(Unit):
  s = B.warm(~List<P> & U32, ~fresh, ~kernel, 5n, (Nil{}, 0))
  do IO<Unit>:
    r : (List<P> & U32) & List<&2, U32> <- B.timed(~List<P> & U32, ~fresh, ~kernel, 21n, s, [])
    B.finish(~List<P> & U32, ~checksum, (4096 * 32 : U32), 1, 21, r)
