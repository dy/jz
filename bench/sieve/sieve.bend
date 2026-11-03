import Base
import ../_lib/bench.bend as B
# sieve.bend: Bend port of sieve.js (same limit, passes and checksum): the
# Sieve of Eratosthenes over a byte flag per number, comp[k] = 1 when k is
# composite. Bend checks that every loop ends, so a loop whose bound is a
# test (`j < LIMIT`) carries a Nat fuel no smaller than its trip count beside
# the test's Bool, the idiom of Bend's own benchmarks.

def limit() -> U32:
  1048576

def n_iters() -> Nat:
  6n

# comp[k] = 0 for the n slots from k
def clear(n: Nat, +k: U32, a: Array<U32>) -> Array<U32>:
  match n:
    case 0n:
      a
    case 1n+p:
      clear(p, (k + 1 : U32), a[k] <- 0)

# comp[j] = 1 for j = i*i, i*i + i, ... while j < LIMIT
def cross(f: Nat, go: Bool, +j: U32, +i: U32, a: Array<U32>) -> Array<U32>:
  match f go:
    case 0n _:
      a
    case 1n+p False{}:
      a
    case 1n+p True{}:
      +k = (j + i : U32)
      cross(p, (k < limit() : U32), k, i, a[j] <- 1)

def mark(prime: Bool, +i: U32, a: Array<U32>) -> Array<U32>:
  match prime:
    case False{}:
      a
    case True{}:
      +j = (i * i : U32)
      cross(U32.to_nat(limit()), (j < limit() : U32), j, i, a)

def step(+i: U32, r: Array<U32> & U32) -> Array<U32>:
  (a, c) = r
  mark(U32.is_eq(c, 0), i, a)

# for i = 2 while i*i < LIMIT: cross out i's multiples when i is prime
def outer(f: Nat, go: Bool, +i: U32, a: Array<U32>) -> Array<U32>:
  match f go:
    case 0n _:
      a
    case 1n+p False{}:
      a
    case 1n+p True{}:
      +k = (i + 1 : U32)
      outer(p, (k * k < limit() : U32), k, step(i, a[i]))

def sieve(a: Array<U32>) -> Array<U32>:
  b = clear(U32.to_nat(limit()), 0, a)
  b[0] <- 1
  b[1] <- 1
  outer(U32.to_nat(limit()), True{}, 2, b)

def run_kernel(n: Nat, a: Array<U32>) -> Array<U32>:
  match n:
    case 0n:
      a
    case 1n+p:
      run_kernel(p, sieve(a))

def kernel(a: Array<U32>) -> Array<U32>:
  run_kernel(n_iters(), a)

def checksum(a: Array<U32>) -> U32:
  B.checksum_u8(U32.to_nat(limit()), a)

def main() -> IO(Unit):
  comp = B.warm(~Array<U32>, ~(a => a), ~kernel, 5n, [0 : U32*1048576n])
  do IO<Unit>:
    r : Array<U32> & List<&2, U32> <- B.timed(~Array<U32>, ~(a => a), ~kernel, 21n, comp, [])
    B.finish(~Array<U32>, ~checksum, (limit() * 6 : U32), 1, 21, r)
