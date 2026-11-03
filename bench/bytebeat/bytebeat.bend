import Base
import ../_lib/bench.bend as B
# bytebeat.bend: Bend port of bytebeat.js (same song, length and checksum):
# one integer formula per sample index rendered into a byte buffer.

def n() -> U32:
  2097152

# v1 = (t*5 & t>>7) | (t*3 & t>>10); v2 = t * (((t>>12) | (t>>8)) & (63 & (t>>4)))
def sample(+t: U32) -> U32:
  +v1 = ((t * 5 .&. t >> 7n) .|. (t * 3 .&. t >> 10n) : U32)
  +v2 = (t * ((t >> 12n .|. t >> 8n) .&. (63 .&. t >> 4n)) : U32)
  (v1 + v2 .&. 255 : U32)

def render(k: Nat, +t: U32, a: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      a
    case 1n+p:
      render(p, (t + 1 : U32), a[t] <- sample(t))

def kernel(a: Array<U32>) -> Array<U32>:
  render(U32.to_nat(n()), 0, a)

def checksum(a: Array<U32>) -> U32:
  B.checksum_u8(U32.to_nat(n()), a)

def main() -> IO(Unit):
  buf = B.warm(~Array<U32>, ~(a => a), ~kernel, 5n, [0 : U32*2097152n])
  do IO<Unit>:
    r : Array<U32> & List<&2, U32> <- B.timed(~Array<U32>, ~(a => a), ~kernel, 21n, buf, [])
    B.finish(~Array<U32>, ~checksum, n(), 1, 21, r)
