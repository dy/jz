import Base
import ../_lib/bench.bend as B
# crc32.bend: Bend port of crc32.js (same buffer, passes, perturbation and
# checksum): table-driven CRC-32 (IEEE, reflected) over a byte buffer. A read
# hands its array back beside the word, so each loop step is a chain of
# stage defs, every read's pair the next stage's parameter, and the state
# rides in a record.

type Crc is Type:
  Crc{buf: Array<U32>, tab: Array<U32>, c: U32}

def n() -> U32:
  16384

def n_iters() -> Nat:
  220n

# one of the 8 shifts of a table entry: (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
def poly.step(odd: Bool, +c: U32) -> U32:
  match odd:
    case True{}:
      (3988292384 .^. (c >> 1n) : U32)
    case False{}:
      (c >> 1n : U32)

def poly(k: Nat, +c: U32) -> U32:
  match k:
    case 0n:
      c
    case 1n+p:
      poly(p, poly.step(U32.is_ne((c .&. 1 : U32), 0), c))

def table(k: Nat, +i: U32, t: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      t
    case 1n+p:
      table(p, (i + 1 : U32), t[i] <- poly(8n, i))

# x = x * 1103515245 + 12345; buf[i] = (x >>> 16) & 0xff
def init(k: Nat, +i: U32, +x: U32, a: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      a
    case 1n+p:
      +y = (x * 1103515245 + 12345 : U32)
      init(p, (i + 1 : U32), y, a[i] <- ((y >> 16n) .&. 255 : U32))

# c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
def crc.f2(+c: U32, buf: Array<U32>, r: Array<U32> & U32) -> Crc:
  (tab, t) = r
  Crc{buf, tab, (t .^. (c >> 8n) : U32)}

def crc.f1(+c: U32, tab: Array<U32>, r: Array<U32> & U32) -> Crc:
  (buf, b) = r
  crc.f2(c, buf, tab[((c .^. b) .&. 255 : U32)])

def crc.step(+i: U32, s: Crc) -> Crc:
  Crc{buf, tab, +c} = s
  crc.f1(c, tab, buf[i])

def crc.go(k: Nat, +i: U32, s: Crc) -> Crc:
  match k:
    case 0n:
      s
    case 1n+p:
      crc.go(p, (i + 1 : U32), crc.step(i, s))

# one pass: h = mix(h, crc32(buf)); buf[j] = (buf[j] + 1) & 0xff, j = it % N
def pass.f2(+j: U32, tab: Array<U32>, h: U32, r: Array<U32> & U32) -> Crc:
  (buf, b) = r
  Crc{buf[j] <- ((b + 1) .&. 255 : U32), tab, h}

def pass.f1(+j: U32, h: U32, s: Crc) -> Crc:
  Crc{buf, tab, c} = s
  pass.f2(j, tab, B.mix(h, (c .^. 4294967295 : U32)), buf[j])

def pass(+it: U32, s: Crc) -> Crc:
  Crc{buf, tab, h} = s
  pass.f1(U32.mod(it, n()), h, crc.go(U32.to_nat(n()), 0, Crc{buf, tab, 4294967295}))

def run_kernel(k: Nat, +it: U32, s: Crc) -> Crc:
  match k:
    case 0n:
      s
    case 1n+p:
      run_kernel(p, (it + 1 : U32), pass(it, s))

def kernel(s: Crc) -> Crc:
  Crc{buf, tab, h} = s
  run_kernel(n_iters(), 0, Crc{buf, tab, 0})

def checksum(s: Crc) -> U32:
  Crc{buf, tab, h} = s
  h

def main() -> IO(Unit):
  buf = init(U32.to_nat(n()), 0, 305419896, [0 : U32*16384n])
  s = B.warm(~Crc, ~(s => s), ~kernel, 5n, Crc{buf, table(256n, 0, [0 : U32*256n]), 0})
  do IO<Unit>:
    r : Crc & List<&2, U32> <- B.timed(~Crc, ~(s => s), ~kernel, 21n, s, [])
    B.finish(~Crc, ~checksum, (n() * 220 : U32), 1, 21, r)
