import Base
import ../_lib/bench.bend as B
# radixsort.bend: Bend port of radixsort.js (same keys, sorts and checksum):
# LSD radix sort, 4 stable counting passes over 8-bit digits ping-ponging
# between two buffers: histogram, exclusive prefix sum, scatter. Each pass
# takes its buffers as a record and hands the next pass its source and
# target swapped, so after the 4th the sorted keys are back in the first.

type Pass is Type:
  Pass{src: Array<U32>, dst: Array<U32>, cnt: Array<U32>}

type Rx is Type:
  Rx{a: Array<U32>, tmp: Array<U32>, base: Array<U32>, cnt: Array<U32>}

def n() -> U32:
  16384

# Deterministic u32 keys: XorShift32, identical per target.
def fill(k: Nat, +i: U32, +s: U32, a: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      a
    case 1n+p:
      +s1 = (s .^. (s << 13n) : U32)
      +s2 = (s1 .^. (s1 >> 17n) : U32)
      +s3 = (s2 .^. (s2 << 5n) : U32)
      fill(p, (i + 1 : U32), s3, a[i] <- s3)

def clear(k: Nat, +i: U32, a: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      a
    case 1n+p:
      clear(p, (i + 1 : U32), a[i] <- 0)

# count[(src[i] >>> shift) & 0xff]++
def hist.f2(+d: U32, src: Array<U32>, dst: Array<U32>, r: Array<U32> & U32) -> Pass:
  (cnt, c) = r
  Pass{src, dst, cnt[d] <- (c + 1 : U32)}

def hist.f1(+sh: Nat, dst: Array<U32>, cnt: Array<U32>, r: Array<U32> & U32) -> Pass:
  (src, x) = r
  +d = ((x >> sh) .&. 255 : U32)
  hist.f2(d, src, dst, cnt[d])

def hist(k: Nat, +sh: Nat, +i: U32, s: Pass) -> Pass:
  match k:
    case 0n:
      s
    case 1n+p:
      Pass{src, dst, cnt} = s
      hist(p, sh, (i + 1 : U32), hist.f1(sh, dst, cnt, src[i]))

# exclusive prefix sum: c = count[i]; count[i] = sum; sum += c (one swap)
def prefix.f1(+sum: U32, r: Array<U32> & U32) -> Array<U32> & U32:
  (cnt, c) = r
  (cnt, (sum + c : U32))

def prefix.step(+i: U32, s: Array<U32> & U32) -> Array<U32> & U32:
  (cnt, +sum) = s
  prefix.f1(sum, Array.swap(U32, cnt, i, sum))

def prefix(k: Nat, +i: U32, s: Array<U32> & U32) -> Array<U32> & U32:
  match k:
    case 0n:
      s
    case 1n+p:
      prefix(p, (i + 1 : U32), prefix.step(i, s))

# d = (src[i] >>> shift) & 0xff; dst[count[d]] = src[i]; count[d]++
def scat.f2(+d: U32, +x: U32, src: Array<U32>, dst: Array<U32>, r: Array<U32> & U32) -> Pass:
  (cnt, +pos) = r
  Pass{src, dst[pos] <- x, cnt[d] <- (pos + 1 : U32)}

def scat.f1(+sh: Nat, dst: Array<U32>, cnt: Array<U32>, r: Array<U32> & U32) -> Pass:
  (src, +x) = r
  +d = ((x >> sh) .&. 255 : U32)
  scat.f2(d, x, src, dst, cnt[d])

def scat(k: Nat, +sh: Nat, +i: U32, s: Pass) -> Pass:
  match k:
    case 0n:
      s
    case 1n+p:
      Pass{src, dst, cnt} = s
      scat(p, sh, (i + 1 : U32), scat.f1(sh, dst, cnt, src[i]))

def pass.scat(+sh: Nat, src: Array<U32>, dst: Array<U32>, r: Array<U32> & U32) -> Pass:
  (cnt, sum) = r
  scat(U32.to_nat(n()), sh, 0, Pass{src, dst, cnt})

def pass.prefix(+sh: Nat, s: Pass) -> Pass:
  Pass{src, dst, cnt} = s
  pass.scat(sh, src, dst, prefix(256n, 0, (cnt, 0)))

def pass(+sh: Nat, s: Pass) -> Pass:
  Pass{src, dst, cnt} = s
  pass.prefix(sh, hist(U32.to_nat(n()), sh, 0, Pass{src, dst, clear(256n, 0, cnt)}))

def flip(s: Pass) -> Pass:
  Pass{src, dst, cnt} = s
  Pass{dst, src, cnt}

# 4 passes at shifts 0, 8, 16, 24, each target the next pass's source
def passes(k: Nat, +sh: Nat, s: Pass) -> Pass:
  match k:
    case 0n:
      s
    case 1n+p:
      passes(p, Nat.add(sh, 8n), flip(pass(sh, s)))

# a[i] = base[i] + it
def load.f1(+i: U32, +it: U32, a: Array<U32>, r: Array<U32> & U32) -> Array<U32> & Array<U32>:
  (base, x) = r
  (a[i] <- (x + it : U32), base)

def load.step(+i: U32, +it: U32, s: Array<U32> & Array<U32>) -> Array<U32> & Array<U32>:
  (a, base) = s
  load.f1(i, it, a, base[i])

def load(k: Nat, +i: U32, +it: U32, s: Array<U32> & Array<U32>) -> Array<U32> & Array<U32>:
  match k:
    case 0n:
      s
    case 1n+p:
      load(p, (i + 1 : U32), it, load.step(i, it, s))

def sort.fin(base: Array<U32>, s: Pass) -> Rx:
  Pass{a, tmp, cnt} = s
  Rx{a, tmp, base, cnt}

def sort(tmp: Array<U32>, cnt: Array<U32>, r: Array<U32> & Array<U32>) -> Rx:
  (a, base) = r
  sort.fin(base, passes(4n, 0n, Pass{a, tmp, cnt}))

def run_kernel(k: Nat, +it: U32, s: Rx) -> Rx:
  match k:
    case 0n:
      s
    case 1n+p:
      Rx{a, tmp, base, cnt} = s
      run_kernel(p, (it + 1 : U32), sort(tmp, cnt, load(U32.to_nat(n()), 0, it, (a, base))))

def kernel(s: Rx) -> Rx:
  run_kernel(40n, 0, s)

def checksum(s: Rx) -> U32:
  Rx{a, tmp, base, cnt} = s
  B.checksum_u32(U32.to_nat(n()), a)

def main() -> IO(Unit):
  base = fill(U32.to_nat(n()), 0, 305441741, [0 : U32*16384n])
  s = {Rx{[0 : U32*16384n], [0 : U32*16384n], base, [0 : U32*256n]} : Rx}
  do IO<Unit>:
    r : Rx & List<&2, U32> <- B.timed(~Rx, ~(s => s), ~kernel, 21n, B.warm(~Rx, ~(s => s), ~kernel, 5n, s), [])
    B.finish(~Rx, ~checksum, (n() * 40 : U32), 4, 21, r)
