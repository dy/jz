import Base
import ../_lib/bench.bend as B
# nqueens.bend: Bend port of nqueens.js (same board sizes, queries and
# checksum): bitmask N-Queens counting by backtracking recursion. A match
# reads only a parameter, so each decision's Bool is computed by the caller:
# solve takes z (no square left on this row) and e (the board is full). The
# row's while loop is solve's tail call on the next candidate bit, and the
# child row its nested call; mutual recursion is refused, so both are one def.
# Bend checks that recursion ends: a Nat fuel drops by one on every call of
# the chain, and the seed (n + 1)^2 exceeds its length (at most n candidate
# bits on each of n rows), so the fuel never runs out.

def nq() -> Nat:
  20n

# Deterministic per-query board sizes: XorShift32, identical per target.
def fill(k: Nat, +i: U32, +s: U32, a: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      a
    case 1n+p:
      +s1 = (s .^. (s << 13n) : U32)
      +s2 = (s1 .^. (s1 >> 17n) : U32)
      +s3 = (s2 .^. (s2 << 5n) : U32)
      fill(p, (i + 1 : U32), s3, a[i] <- (8 + U32.mod(s3, 4) : U32))

# Count placements below a row. avail holds the row's legal squares; each
# step peels its lowest bit b = avail & -avail, counts the child row (1 when
# it fills the board), then continues on avail - b, adding into cnt.
def solve(+f: Nat, z: Bool, e: Bool, +avail: U32, +all: U32, +cols: U32,
          +d1: U32, +d2: U32, cnt: U32) -> U32:
  match f z e:
    case 0n _ _:
      cnt
    case 1n+g True{} _:
      cnt
    case 1n+g False{} True{}:
      +b = (avail .&. (0 - avail) : U32)
      +rest = (avail - b : U32)
      solve(g, U32.is_zero(rest), U32.is_eq((cols .|. (rest .&. (0 - rest)) : U32), all),
        rest, all, cols, d1, d2, (cnt + 1 : U32))
    case 1n+g False{} False{}:
      +b = (avail .&. (0 - avail) : U32)
      +rest = (avail - b : U32)
      +nc = (cols .|. b : U32)
      +n1 = ((d1 .|. b) << 1n : U32)
      +n2 = ((d2 .|. b) >> 1n : U32)
      +na = (all .&. U32.not((nc .|. n1 .|. n2 : U32)) : U32)
      solve(g, U32.is_zero(rest), U32.is_eq((cols .|. (rest .&. (0 - rest)) : U32), all),
        rest, all, cols, d1, d2,
        (cnt + solve(g, U32.is_zero(na), U32.is_eq((nc .|. (na .&. (0 - na)) : U32), all),
          na, all, nc, n1, n2, 0) : U32))

def count_n(+n: U32) -> U32:
  +all = ((1 << U32.to_nat(n)) - 1 : U32)
  solve(U32.to_nat(((n + 1) * (n + 1) : U32)), U32.is_zero(all),
    U32.is_eq((all .&. (0 - all) : U32), all), all, all, 0, 0, 0, 0)

# h = mix(h, countN(sizes[q])) over the queries
def query(h: U32, r: Array<U32> & U32) -> Array<U32> & U32:
  (a, n) = r
  (a, B.mix(h, count_n(n)))

def queries.step(+q: U32, s: Array<U32> & U32) -> Array<U32> & U32:
  (a, h) = s
  query(h, a[q])

def queries(k: Nat, +q: U32, s: Array<U32> & U32) -> Array<U32> & U32:
  match k:
    case 0n:
      s
    case 1n+p:
      queries(p, (q + 1 : U32), queries.step(q, s))

def kernel(s: Array<U32> & U32) -> Array<U32> & U32:
  (a, h) = s
  queries(nq(), 0, (a, 2166136261))

# total: the solution counts summed over the queries
def total.add(t: U32, r: Array<U32> & U32) -> Array<U32> & U32:
  (a, n) = r
  (a, (t + count_n(n) : U32))

def total.step(+q: U32, s: Array<U32> & U32) -> Array<U32> & U32:
  (a, t) = s
  total.add(t, a[q])

def total(k: Nat, +q: U32, s: Array<U32> & U32) -> Array<U32> & U32:
  match k:
    case 0n:
      s
    case 1n+p:
      total(p, (q + 1 : U32), total.step(q, s))

def checksum(s: Array<U32> & U32) -> U32:
  (a, h) = s
  h

def report(+t: U32, r: (Array<U32> & U32) & List<&2, U32>) -> IO(Unit):
  B.finish(~Array<U32> & U32, ~checksum, t, 11, 21, r)

def run(s: Array<U32> & U32) -> IO(Unit):
  (sizes, t) = s
  do IO<Unit>:
    r : (Array<U32> & U32) & List<&2, U32> <- B.timed(~Array<U32> & U32, ~(s => s), ~kernel, 21n,
      B.warm(~Array<U32> & U32, ~(s => s), ~kernel, 5n, (sizes, 0)), [])
    report(t, r)

def main() -> IO(Unit):
  run(total(nq(), 0, (fill(nq(), 0, 305441741, [0 : U32*32n]), 0)))
