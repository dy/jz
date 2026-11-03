import Base
import ../_lib/bench.bend as B
# arraynumeric.bend: Bend port of arraynumeric.js (Perry's
# bench_numeric_array_numeric.ts, https://github.com/PerryTS/perry,
# benchmarks/suite, MIT; same values, passes and checksum): a quarter million
# integers stored one by one, then 25 passes that add 1 to every slot. A
# Bend array has a fixed power-of-two slot count and no push, so each run
# makes one of 2^18 slots and stores the 250,000 values in order, where the JS
# pushes them; the integers stay below 2^23, so U32 holds every value and sum
# the JS's doubles hold. The state is the hash of the timed runs' results and
# the count of runs made, the warm-up runs mixing nothing.

def size() -> U32:
  250000

# a[i] = i for the n slots from i
def fill(n: Nat, +i: U32, a: Array<U32>) -> Array<U32>:
  match n:
    case 0n:
      a
    case 1n+p:
      fill(p, (i + 1 : U32), a[i] <- i)

def build() -> Array<U32>:
  fill(U32.to_nat(size()), 0, [0 : U32*262144n])

# a[i] = a[i] + 1
def inc.set(+i: U32, r: Array<U32> & U32) -> Array<U32>:
  (a, x) = r
  a[i] <- (x + 1 : U32)

def inc(n: Nat, +i: U32, a: Array<U32>) -> Array<U32>:
  match n:
    case 0n:
      a
    case 1n+p:
      inc(p, (i + 1 : U32), inc.set(i, a[i]))

def add(cs: U32, r: Array<U32> & U32) -> Array<U32> & U32:
  (a, x) = r
  (a, (cs + x : U32))

# checksum + arr[0] + arr[arr.length - 1]
def ends.last(r: Array<U32> & U32) -> Array<U32> & U32:
  (a, cs) = r
  add(cs, a[(size() - 1 : U32)])

def ends(cs: U32, a: Array<U32>) -> Array<U32> & U32:
  ends.last(add(cs, a[0]))

def pass(r: Array<U32> & U32) -> Array<U32> & U32:
  (a, cs) = r
  ends(cs, inc(U32.to_nat(size()), 0, a))

def passes(n: Nat, r: Array<U32> & U32) -> Array<U32> & U32:
  match n:
    case 0n:
      r
    case 1n+p:
      passes(p, pass(r))

def total(r: Array<U32> & U32) -> Array<U32> & U32:
  (a, cs) = r
  (a, (cs + size() : U32))

# the JS's mutateNumericArray: the array back beside checksum + arr.length
def mutate(a: Array<U32>) -> Array<U32> & U32:
  total(passes(25n, (a, 0)))

def run() -> U32:
  Pair.snd(Array<U32>, U32, mutate(build()))

# one run: its result mixed into h once the 3 warm-up runs are made
def kernel(s: U32 & U32) -> U32 & U32:
  (+h, +k) = s
  +cs = run()
  (Bool.pick(U32, (k >= 3 : U32), B.mix(h, cs), h), (k + 1 : U32))

# one more run's result, then every slot of its array
def fold(h: U32, r: Array<U32> & U32) -> U32:
  (a, cs) = r
  Pair.snd(Array<U32>, U32, B.checksum.go(U32.to_nat(size()), 1, 0, (a, B.mix(h, cs))))

def checksum(s: U32 & U32) -> U32:
  (h, k) = s
  fold(h, mutate(build()))

def main() -> IO(Unit):
  s = B.warm(~U32 & U32, ~(s => s), ~kernel, 3n, (2166136261, 0))
  do IO<Unit>:
    r : (U32 & U32) & List<&2, U32> <- B.timed(~U32 & U32, ~(s => s), ~kernel, 21n, s, [])
    B.finish(~U32 & U32, ~checksum, size(), 2, 21, r)
