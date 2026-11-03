import Base
import ../_lib/bench.bend as B
# bitwise.bend: Bend port of bitwise.js (same state, rounds and checksum): a
# shift / xor / multiply mixing round over every word of a 65536-word state,
# 128 rounds, reseeded by XorShift32 before each timed run. An Int32Array
# word is a U32 here: every operation of the round is the same on its bits.

def n() -> U32:
  65536

def init(k: Nat, +i: U32, +s: U32, a: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      a
    case 1n+p:
      +s1 = (s .^. (s << 13n) : U32)
      +s2 = (s1 .^. (s1 >> 17n) : U32)
      +s3 = (s2 .^. (s2 << 5n) : U32)
      init(p, (i + 1 : U32), s3, a[i] <- s3)

def reseed(a: Array<U32>) -> Array<U32>:
  init(U32.to_nat(n()), 0, 305441741, a)

# x ^= x << 7; x ^= x >>> 9; x = x * 1103515245 + 12345; x ^ (x >>> 16)
def round(+x: U32) -> U32:
  +x1 = (x .^. (x << 7n) : U32)
  +x2 = (x1 .^. (x1 >> 9n) : U32)
  +x3 = (x2 * 1103515245 + 12345 : U32)
  (x3 .^. (x3 >> 16n) : U32)

def word(+i: U32, r: Array<U32> & U32) -> Array<U32>:
  (a, x) = r
  a[i] <- round(x)

def sweep(k: Nat, +i: U32, a: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      a
    case 1n+p:
      sweep(p, (i + 1 : U32), word(i, a[i]))

def rounds(k: Nat, a: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      a
    case 1n+p:
      rounds(p, sweep(U32.to_nat(n()), 0, a))

def kernel(a: Array<U32>) -> Array<U32>:
  rounds(128n, a)

def checksum(a: Array<U32>) -> U32:
  B.checksum_u32(U32.to_nat(n()), a)

def main() -> IO(Unit):
  state = B.warm(~Array<U32>, ~reseed, ~kernel, 5n, reseed([0 : U32*65536n]))
  do IO<Unit>:
    r : Array<U32> & List<&2, U32> <- B.timed(~Array<U32>, ~reseed, ~kernel, 21n, state, [])
    B.finish(~Array<U32>, ~checksum, (n() * 128 : U32), 3, 21, r)
