import Base
import ../_lib/bench.bend as B
# hash.bend: Bend port of hash.js (same buffer, passes, perturbation and
# checksum): MurmurHash3 x86_32, body only, over a 16384-byte buffer. Each
# block reads its four bytes in a chain of stage defs, every read's pair the
# next stage's parameter.

type Mur is Type:
  Mur{buf: Array<U32>, h: U32}

def n() -> U32:
  16384

def n_iters() -> Nat:
  700n

# x = x * 1103515245 + 12345; buf[i] = (x >>> 16) & 0xff
def init(k: Nat, +i: U32, +x: U32, a: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      a
    case 1n+p:
      +y = (x * 1103515245 + 12345 : U32)
      init(p, (i + 1 : U32), y, a[i] <- ((y >> 16n) .&. 255 : U32))

def rotl(+x: U32, r: Nat, +l: Nat) -> U32:
  ((x << r) .|. (x >> l) : U32)

# k *= C1; k = rotl(k, 15); k *= C2; h ^= k; h = rotl(h, 13); h = h * 5 + 0xe6546b64
def block(+h: U32, +k: U32) -> U32:
  +k1 = rotl((k * 3432918353 : U32), 15n, 17n)
  +h1 = rotl((h .^. (k1 * 461845907) : U32), 13n, 19n)
  (h1 * 5 + 3864292196 : U32)

def blk.f4(+h: U32, +k: U32, r: Array<U32> & U32) -> Mur:
  (buf, b) = r
  Mur{buf, block(h, (k .|. (b << 24n) : U32))}

def blk.f3(+i: U32, +h: U32, +k: U32, r: Array<U32> & U32) -> Mur:
  (buf, b) = r
  blk.f4(h, (k .|. (b << 16n) : U32), buf[(i + 3 : U32)])

def blk.f2(+i: U32, +h: U32, +k: U32, r: Array<U32> & U32) -> Mur:
  (buf, b) = r
  blk.f3(i, h, (k .|. (b << 8n) : U32), buf[(i + 2 : U32)])

def blk.f1(+i: U32, +h: U32, r: Array<U32> & U32) -> Mur:
  (buf, b) = r
  blk.f2(i, h, b, buf[(i + 1 : U32)])

def blk(+i: U32, s: Mur) -> Mur:
  Mur{buf, h} = s
  blk.f1(i, h, buf[i])

def body(k: Nat, +i: U32, s: Mur) -> Mur:
  match k:
    case 0n:
      s
    case 1n+p:
      body(p, (i + 4 : U32), blk(i, s))

# h ^= n; then the fmix32 finalizer
def fmix(+h: U32) -> U32:
  +h1 = (h .^. n() : U32)
  +h2 = ((h1 .^. (h1 >> 16n)) * 2246822507 : U32)
  +h3 = ((h2 .^. (h2 >> 13n)) * 3266489909 : U32)
  (h3 .^. (h3 >> 16n) : U32)

# one pass: h = mix(h, murmur3(buf, N, 0x9747b28c)); buf[j] = (buf[j] + 1) & 0xff
def pass.f2(+j: U32, h: U32, r: Array<U32> & U32) -> Mur:
  (buf, b) = r
  Mur{buf[j] <- ((b + 1) .&. 255 : U32), h}

def pass.f1(+j: U32, h: U32, s: Mur) -> Mur:
  Mur{buf, m} = s
  pass.f2(j, B.mix(h, fmix(m)), buf[j])

def pass(+it: U32, s: Mur) -> Mur:
  Mur{buf, h} = s
  pass.f1(U32.mod(it, n()), h, body(U32.to_nat((n() >> 2n : U32)), 0, Mur{buf, 2538058380}))

def run_kernel(k: Nat, +it: U32, s: Mur) -> Mur:
  match k:
    case 0n:
      s
    case 1n+p:
      run_kernel(p, (it + 1 : U32), pass(it, s))

def kernel(s: Mur) -> Mur:
  Mur{buf, h} = s
  run_kernel(n_iters(), 0, Mur{buf, 0})

def checksum(s: Mur) -> U32:
  Mur{buf, h} = s
  h

def main() -> IO(Unit):
  buf = init(U32.to_nat(n()), 0, 305419896, [0 : U32*16384n])
  s = B.warm(~Mur, ~(s => s), ~kernel, 5n, Mur{buf, 0})
  do IO<Unit>:
    r : Mur & List<&2, U32> <- B.timed(~Mur, ~(s => s), ~kernel, 21n, s, [])
    B.finish(~Mur, ~checksum, (n() * 700 : U32), 1, 21, r)
