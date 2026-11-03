import Base
import ../_lib/bench.bend as B
# base64.bend: Bend port of base64.js (same buffer, passes, perturbation and
# checksum): standard Base64 encode then decode of a 24576-byte buffer, the
# round trip verified byte by byte and the encoded text hashed. Each 3-byte
# block reads its bytes in a chain of stage defs, every read's pair the next
# stage's parameter; an alphabet lookup and its write are one stage, lut.

type Codec is Type:
  Codec{src: Array<U32>, enc: Array<U32>, dec: Array<U32>, b64: Array<U32>, back: Array<U32>}

def n() -> U32:
  24576

def enc_len() -> U32:
  32768

# A-Z a-z 0-9 + /
def alphabet(k: Nat, +i: U32, +c: U32, a: Array<U32>) -> Array<U32> & U32:
  match k:
    case 0n:
      (a, i)
    case 1n+p:
      alphabet(p, (i + 1 : U32), (c + 1 : U32), a[i] <- c)

def build_enc.f3(r: Array<U32> & U32) -> Array<U32>:
  (a, +i) = r
  a[i] <- 43
  a[(i + 1 : U32)] <- 47

def build_enc.f2(r: Array<U32> & U32) -> Array<U32>:
  (a, i) = r
  build_enc.f3(alphabet(10n, i, 48, a))

def build_enc.f1(r: Array<U32> & U32) -> Array<U32>:
  (a, i) = r
  build_enc.f2(alphabet(26n, i, 97, a))

def build_enc(a: Array<U32>) -> Array<U32>:
  build_enc.f1(alphabet(26n, 0, 65, a))

# dec[enc[i]] = i
def build_dec.put(+i: U32, dec: Array<U32>, r: Array<U32> & U32) -> Array<U32> & Array<U32>:
  (enc, c) = r
  (enc, dec[c] <- i)

def build_dec.step(+i: U32, r: Array<U32> & Array<U32>) -> Array<U32> & Array<U32>:
  (enc, dec) = r
  build_dec.put(i, dec, enc[i])

def build_dec(k: Nat, +i: U32, r: Array<U32> & Array<U32>) -> Array<U32> & Array<U32>:
  match k:
    case 0n:
      r
    case 1n+p:
      build_dec(p, (i + 1 : U32), build_dec.step(i, r))

# x = imul(x, 1103515245) + 12345; buf[i] = (x >>> 16) & 0xff
def init(k: Nat, +i: U32, +x: U32, a: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      a
    case 1n+p:
      +y = (x * 1103515245 + 12345 : U32)
      init(p, (i + 1 : U32), y, a[i] <- ((y >> 16n) .&. 255 : U32))

# out[op] = table[idx]: the table and the output back
def lut.put(+op: U32, out: Array<U32>, r: Array<U32> & U32) -> Array<U32> & Array<U32>:
  (table, v) = r
  (table, out[op] <- v)

def lut(+op: U32, +idx: U32, p: Array<U32> & Array<U32>) -> Array<U32> & Array<U32>:
  (table, out) = p
  lut.put(op, out, table[idx])

# out[op..op+3] = enc[a >>> 2], enc[((a & 3) << 4) | (b >>> 4)],
# enc[((b & 15) << 2) | (c >>> 6)], enc[c & 63]
def enc.block(+op: U32, +a: U32, +b: U32, +c: U32, src: Array<U32>, enc: Array<U32>,
              b64: Array<U32>) -> (Array<U32> & Array<U32>) & Array<U32>:
  (lut((op + 3 : U32), (c .&. 63 : U32),
    lut((op + 2 : U32), ((b .&. 15) << 2n .|. c >> 6n : U32),
      lut((op + 1 : U32), ((a .&. 3) << 4n .|. b >> 4n : U32),
        lut(op, (a >> 2n : U32), (enc, b64))))), src)

def enc.f3(+op: U32, +a: U32, +b: U32, enc: Array<U32>, b64: Array<U32>,
           r: Array<U32> & U32) -> (Array<U32> & Array<U32>) & Array<U32>:
  (src, c) = r
  enc.block(op, a, b, c, src, enc, b64)

def enc.f2(+i: U32, +op: U32, +a: U32, enc: Array<U32>, b64: Array<U32>,
           r: Array<U32> & U32) -> (Array<U32> & Array<U32>) & Array<U32>:
  (src, b) = r
  enc.f3(op, a, b, enc, b64, src[(i + 2 : U32)])

def enc.f1(+i: U32, +op: U32, enc: Array<U32>, b64: Array<U32>,
           r: Array<U32> & U32) -> (Array<U32> & Array<U32>) & Array<U32>:
  (src, a) = r
  enc.f2(i, op, a, enc, b64, src[(i + 1 : U32)])

def enc.step(+i: U32, +op: U32, s: (Array<U32> & Array<U32>) & Array<U32>) ->
  (Array<U32> & Array<U32>) & Array<U32>:
  ((enc, b64), src) = s
  enc.f1(i, op, enc, b64, src[i])

def encode(k: Nat, +i: U32, +op: U32, s: (Array<U32> & Array<U32>) & Array<U32>) ->
  (Array<U32> & Array<U32>) & Array<U32>:
  match k:
    case 0n:
      s
    case 1n+p:
      encode(p, (i + 3 : U32), (op + 4 : U32), enc.step(i, op, s))

# a = dec[src[i]] .. d = dec[src[i+3]]; three bytes out
def dec.block(+op: U32, +a: U32, +b: U32, +c: U32, d: U32, b64: Array<U32>,
              dec: Array<U32>, back: Array<U32>) -> Array<U32> & (Array<U32> & Array<U32>):
  back[op] <- ((a << 2n .|. b >> 4n) .&. 255 : U32)
  back[(op + 1 : U32)] <- (((b .&. 15) << 4n .|. c >> 2n) .&. 255 : U32)
  (b64, (dec, back[(op + 2 : U32)] <- (((c .&. 3) << 6n .|. d) .&. 255 : U32)))

# the k-th symbol of the block: dec[b64[i + k]]
def sym.f2(b64: Array<U32>, r: Array<U32> & U32) -> (Array<U32> & Array<U32>) & U32:
  (dec, v) = r
  ((b64, dec), v)

def sym.f1(dec: Array<U32>, r: Array<U32> & U32) -> (Array<U32> & Array<U32>) & U32:
  (b64, s) = r
  sym.f2(b64, dec[s])

def sym(+i: U32, b64: Array<U32>, dec: Array<U32>) -> (Array<U32> & Array<U32>) & U32:
  sym.f1(dec, b64[i])

def dec.d(+op: U32, +a: U32, +b: U32, +c: U32, back: Array<U32>,
          r: (Array<U32> & Array<U32>) & U32) -> Array<U32> & (Array<U32> & Array<U32>):
  ((b64, dec), d) = r
  dec.block(op, a, b, c, d, b64, dec, back)

def dec.c(+i: U32, +op: U32, +a: U32, +b: U32, back: Array<U32>,
          r: (Array<U32> & Array<U32>) & U32) -> Array<U32> & (Array<U32> & Array<U32>):
  ((b64, dec), c) = r
  dec.d(op, a, b, c, back, sym((i + 3 : U32), b64, dec))

def dec.b(+i: U32, +op: U32, +a: U32, back: Array<U32>,
          r: (Array<U32> & Array<U32>) & U32) -> Array<U32> & (Array<U32> & Array<U32>):
  ((b64, dec), b) = r
  dec.c(i, op, a, b, back, sym((i + 2 : U32), b64, dec))

def dec.a(+i: U32, +op: U32, back: Array<U32>,
          r: (Array<U32> & Array<U32>) & U32) -> Array<U32> & (Array<U32> & Array<U32>):
  ((b64, dec), a) = r
  dec.b(i, op, a, back, sym((i + 1 : U32), b64, dec))

def dec.step(+i: U32, +op: U32, s: Array<U32> & (Array<U32> & Array<U32>)) ->
  Array<U32> & (Array<U32> & Array<U32>):
  (b64, (dec, back)) = s
  dec.a(i, op, back, sym(i, b64, dec))

def decode(k: Nat, +i: U32, +op: U32, s: Array<U32> & (Array<U32> & Array<U32>)) ->
  Array<U32> & (Array<U32> & Array<U32>):
  match k:
    case 0n:
      s
    case 1n+p:
      decode(p, (i + 4 : U32), (op + 3 : U32), dec.step(i, op, s))

# ok = 0 where back[i] !== src[i]
def check.f2(ok: U32, x: U32, back: Array<U32>, r: Array<U32> & U32) -> (Array<U32> & Array<U32>) & U32:
  (src, y) = r
  ((back, src), Bool.pick(U32, U32.is_ne(x, y), 0, ok))

def check.f1(+i: U32, ok: U32, src: Array<U32>, r: Array<U32> & U32) -> (Array<U32> & Array<U32>) & U32:
  (back, x) = r
  check.f2(ok, x, back, src[i])

def check.step(+i: U32, s: (Array<U32> & Array<U32>) & U32) -> (Array<U32> & Array<U32>) & U32:
  ((back, src), ok) = s
  check.f1(i, ok, src, back[i])

def check(k: Nat, +i: U32, s: (Array<U32> & Array<U32>) & U32) -> (Array<U32> & Array<U32>) & U32:
  match k:
    case 0n:
      s
    case 1n+p:
      check(p, (i + 1 : U32), check.step(i, s))

# h = mix(mix(h, checksumU8(b64)), ok); src[j] = (src[j] + 1) & 0xff, j = it % N
def pass.bump(+j: U32, h: U32, enc: Array<U32>, dec: Array<U32>, b64: Array<U32>,
              back: Array<U32>, r: Array<U32> & U32) -> Codec & U32:
  (src, x) = r
  (Codec{src[j] <- ((x + 1) .&. 255 : U32), enc, dec, b64, back}, h)

def pass.mix(+j: U32, h: U32, enc: Array<U32>, dec: Array<U32>, b64: Array<U32>,
             r: (Array<U32> & Array<U32>) & U32) -> Codec & U32:
  ((back, src), ok) = r
  pass.bump(j, B.mix(h, ok), enc, dec, b64, back, src[j])

def pass.check(+j: U32, h: U32, src: Array<U32>, enc: Array<U32>, dec: Array<U32>,
               back: Array<U32>, r: Array<U32> & U32) -> Codec & U32:
  (b64, cs) = r
  pass.mix(j, B.mix(h, cs), enc, dec, b64, check(U32.to_nat(n()), 0, ((back, src), 1)))

def pass.hash(+j: U32, h: U32, src: Array<U32>, enc: Array<U32>,
              r: Array<U32> & (Array<U32> & Array<U32>)) -> Codec & U32:
  (b64, (dec, back)) = r
  pass.check(j, h, src, enc, dec, back, B.hash_u8(U32.to_nat(enc_len()), b64))

def pass.decode(+j: U32, h: U32, dec: Array<U32>, back: Array<U32>,
                r: (Array<U32> & Array<U32>) & Array<U32>) -> Codec & U32:
  ((enc, b64), src) = r
  pass.hash(j, h, src, enc, decode(8192n, 0, 0, (b64, (dec, back))))

def pass(+it: U32, r: Codec & U32) -> Codec & U32:
  (c, h) = r
  Codec{src, enc, dec, b64, back} = c
  pass.decode(U32.mod(it, n()), h, dec, back, encode(8192n, 0, 0, ((enc, b64), src)))

def run_kernel(k: Nat, +it: U32, r: Codec & U32) -> Codec & U32:
  match k:
    case 0n:
      r
    case 1n+p:
      run_kernel(p, (it + 1 : U32), pass(it, r))

def kernel(r: Codec & U32) -> Codec & U32:
  (c, h) = r
  run_kernel(64n, 0, (c, 0))

def checksum(r: Codec & U32) -> U32:
  (c, h) = r
  h

def run(src: Array<U32>, r: Array<U32> & Array<U32>) -> IO(Unit):
  (enc, dec) = r
  s = B.warm(~Codec & U32, ~(r => r), ~kernel, 5n,
    (Codec{src, enc, dec, [0 : U32*32768n], [0 : U32*32768n]}, 0))
  do IO<Unit>:
    r : (Codec & U32) & List<&2, U32> <- B.timed(~Codec & U32, ~(r => r), ~kernel, 21n, s, [])
    B.finish(~Codec & U32, ~checksum, (n() * 64 : U32), 1, 21, r)

def main() -> IO(Unit):
  src = init(U32.to_nat(n()), 0, 305419896, [0 : U32*32768n])
  run(src, build_dec(64n, 0, (build_enc([0 : U32*64n]), [0 : U32*256n])))
