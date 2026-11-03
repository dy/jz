import Base
import ../_lib/bench.bend as B
# alpha.bend: Bend port of alpha.js (same images, opacity and checksum):
# per-byte fixed-point alpha blend of two RGBA images,
# out = (src*A + dst*(255-A) + 127) >> 8.

type Img is Type:
  Img{src: Array<U32>, dst: Array<U32>, out: Array<U32>}

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

def blend.f2(+i: U32, x: U32, src: Array<U32>, out: Array<U32>, r: Array<U32> & U32) -> Img:
  (dst, y) = r
  Img{src, dst, out[i] <- (x * 160 + y * 95 + 127 >> 8n : U32)}

def blend.f1(+i: U32, dst: Array<U32>, out: Array<U32>, r: Array<U32> & U32) -> Img:
  (src, x) = r
  blend.f2(i, x, src, out, dst[i])

def blend(k: Nat, +i: U32, s: Img) -> Img:
  match k:
    case 0n:
      s
    case 1n+p:
      Img{src, dst, out} = s
      blend(p, (i + 1 : U32), blend.f1(i, dst, out, src[i]))

def kernel(s: Img) -> Img:
  blend(U32.to_nat(n()), 0, s)

def checksum(s: Img) -> U32:
  Img{src, dst, out} = s
  B.checksum_u8(U32.to_nat(n()), out)

def main() -> IO(Unit):
  src = noise(U32.to_nat(n()), 0, 305441741, [0 : U32*1048576n])
  dst = noise(U32.to_nat(n()), 0, 2115998645, [0 : U32*1048576n])
  s = B.warm(~Img, ~(s => s), ~kernel, 5n, Img{src, dst, [0 : U32*1048576n]})
  do IO<Unit>:
    r : Img & List<&2, U32> <- B.timed(~Img, ~(s => s), ~kernel, 21n, s, [])
    B.finish(~Img, ~checksum, n(), 1, 21, r)
