import Base
import ../_lib/bench.bend as B
# lz.bend: Bend port of lz.js (same input, format, passes, perturbation and
# checksum): an LZSS compressor and decompressor round trip, a greedy
# longest-match search over a 1024-byte window, then a byte-exact inflate
# verified against the source. Each loop whose bound is a test (ip < n, a
# match's bytes agreeing, a candidate reaching MAX_MATCH) answers its state
# beside the test's Bool; the block loops carry a Nat fuel of one more step
# than the bytes they can take, the candidate loop counts the window down and
# the match loop counts maxLen down. Each read's pair is the next stage's
# parameter, the buffers riding in records.

type Lz is Type:
  Lz{src: Array<U32>, comp: Array<U32>, dec: Array<U32>}

# compress: the source, the output, ip, op and the control byte being built
type Enc is Type:
  Enc{src: Array<U32>, out: Array<U32>, ip: U32, op: U32, ctrl: U32}

# the longest match so far: the source beside bestLen and bestDist
type Best is Type:
  Best{src: Array<U32>, len: U32, dist: U32}

# inflate: the compressed input, the output, ip and op
type Dec is Type:
  Dec{inp: Array<U32>, dst: Array<U32>, ip: U32, op: U32}

def n() -> U32:
  4096

def window() -> U32:
  1024

def min_match() -> U32:
  3

def max_match() -> U32:
  18

# x = imul(x, 1103515245) + 12345; past i = 64, one byte in 8 copies one of
# the 64 before it, the rest are (x >>> 16) & 0xff
def init.copy(+i: U32, r: Array<U32> & U32) -> Array<U32>:
  (a, v) = r
  a[i] <- v

def init.put(back: Bool, +i: U32, +x: U32, a: Array<U32>) -> Array<U32>:
  match back:
    case True{}:
      init.copy(i, a[((i - 1) - ((x >> 8n) .&. 63) : U32)])
    case False{}:
      a[i] <- ((x >> 16n) .&. 255 : U32)

def init(k: Nat, +i: U32, +x: U32, a: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      a
    case 1n+p:
      +y = (x * 1103515245 + 12345 : U32)
      +back = (i > 64 : U32) && U32.is_eq((y .&. 112 : U32), 0)
      init(p, (i + 1 : U32), y, init.put(back, i, y, a))

# while (len < maxLen && src[j + len] === src[ip + len]) len++: the count is
# maxLen, the Bool the bytes agreeing
def mlen.f2(+len: U32, x: U32, r: Array<U32> & U32) -> (Array<U32> & U32) & Bool:
  (src, y) = r
  +eq = U32.is_eq(x, y)
  ((src, Bool.pick(U32, eq, (len + 1 : U32), len)), eq)

def mlen.f1(+ip: U32, +len: U32, r: Array<U32> & U32) -> (Array<U32> & U32) & Bool:
  (src, x) = r
  mlen.f2(len, x, src[(ip + len : U32)])

def mlen.step(+j: U32, +ip: U32, s: Array<U32> & U32) -> (Array<U32> & U32) & Bool:
  (src, +len) = s
  mlen.f1(ip, len, src[(j + len : U32)])

def mlen(k: Nat, +j: U32, +ip: U32, r: (Array<U32> & U32) & Bool) -> Array<U32> & U32:
  match k:
    case 0n:
      (s, go) = r
      s
    case 1n+p:
      (s, go) = r
      match go:
        case False{}:
          s
        case True{}:
          mlen(p, j, ip, mlen.step(j, ip, s))

# if (len > bestLen) { bestLen = len; bestDist = ip - j; if (len >= maxLen) break }
def cand.pick(gt: Bool, +len: U32, dist: U32, +maxlen: U32, src: Array<U32>,
              blen: U32, bdist: U32) -> Best & Bool:
  match gt:
    case True{}:
      (Best{src, len, dist}, (len < maxlen : U32))
    case False{}:
      (Best{src, blen, bdist}, True{})

def cand.f1(+ip: U32, +j: U32, +maxlen: U32, +blen: U32, bdist: U32,
            r: Array<U32> & U32) -> Best & Bool:
  (src, +len) = r
  cand.pick((len > blen : U32), len, (ip - j : U32), maxlen, src, blen, bdist)

def cand.step(+ip: U32, +j: U32, +maxlen: U32, b: Best) -> Best & Bool:
  Best{src, blen, bdist} = b
  cand.f1(ip, j, maxlen, blen, bdist, mlen(U32.to_nat(maxlen), j, ip, ((src, 0), True{})))

# for (j = ip - 1; j >= start; j--), nearest first: ip - start candidates
def cand(k: Nat, +j: U32, +ip: U32, +maxlen: U32, r: Best & Bool) -> Best:
  match k:
    case 0n:
      (b, go) = r
      b
    case 1n+p:
      (b, go) = r
      match go:
        case False{}:
          b
        case True{}:
          cand(p, (j - 1 : U32), ip, maxlen, cand.step(ip, j, maxlen, b))

# a literal: out[op++] = src[ip++]
def tok.lit(+ip: U32, +op: U32, ctrl: U32, out: Array<U32>, r: Array<U32> & U32) -> Enc & Bool:
  (src, x) = r
  +ip1 = (ip + 1 : U32)
  (Enc{src, out[op] <- x, ip1, (op + 1 : U32), ctrl}, (ip1 < n() : U32))

# a match: ctrl |= 1 << b, the code (dist - 1) << 4 | (len - MIN_MATCH) in two
# bytes, ip += bestLen
def tok.put(m: Bool, +b: U32, +ip: U32, +op: U32, ctrl: U32, out: Array<U32>,
            src: Array<U32>, +len: U32, dist: U32) -> Enc & Bool:
  match m:
    case True{}:
      +code = (((dist - 1) << 4n) .|. (len - min_match()) : U32)
      +ip1 = (ip + len : U32)
      out[op] <- ((code >> 8n) .&. 255 : U32)
      (Enc{src, out[(op + 1 : U32)] <- (code .&. 255 : U32), ip1, (op + 2 : U32),
        (ctrl .|. (1 << U32.to_nat(b)) : U32)}, (ip1 < n() : U32))
    case False{}:
      tok.lit(ip, op, ctrl, out, src[ip])

def tok.f1(+b: U32, +ip: U32, +op: U32, ctrl: U32, out: Array<U32>, best: Best) -> Enc & Bool:
  Best{src, +len, dist} = best
  tok.put((len >= min_match() : U32), b, ip, op, ctrl, out, src, len, dist)

# one token: the longest match over the window, nearest first, then a
# literal or a match
def tok(+b: U32, e: Enc) -> Enc & Bool:
  Enc{src, out, +ip, +op, ctrl} = e
  +start = Bool.pick(U32, (ip < window() : U32), 0, (ip - window() : U32))
  +maxlen = U32.min((n() - ip : U32), max_match())
  tok.f1(b, ip, op, ctrl, out,
    cand(U32.to_nat((ip - start : U32)), (ip - 1 : U32), ip, maxlen, (Best{src, 0, 0}, True{})))

# for (b = 0; b < 8 && ip < n; b++)
def toks(k: Nat, +b: U32, r: Enc & Bool) -> Enc:
  match k:
    case 0n:
      (e, go) = r
      e
    case 1n+p:
      (e, go) = r
      match go:
        case False{}:
          e
        case True{}:
          toks(p, (b + 1 : U32), tok(b, e))

# out[ctrlPos] = ctrl, then the while test ip < n
def block.fin(+cpos: U32, e: Enc) -> Enc & Bool:
  Enc{src, out, +ip, op, ctrl} = e
  (Enc{src, out[cpos] <- ctrl, ip, op, 0}, (ip < n() : U32))

# ctrlPos = op++; ctrl = 0; up to 8 tokens
def block(e: Enc) -> Enc & Bool:
  Enc{src, out, +ip, +op, ctrl} = e
  block.fin(op, toks(8n, 0, (Enc{src, out, ip, (op + 1 : U32), 0}, (ip < n() : U32))))

# while (ip < n): a block takes at least one byte, so n + 1 steps of fuel
def compress(f: Nat, r: Enc & Bool) -> Enc:
  match f:
    case 0n:
      (e, go) = r
      e
    case 1n+p:
      (e, go) = r
      match go:
        case False{}:
          e
        case True{}:
          compress(p, block(e))

# for (k = 0; k < len; k++) dst[op] = dst[op - dist], op++: byte by byte, so
# an overlapping match repeats a run
def copy.put(+op: U32, r: Array<U32> & U32) -> Array<U32>:
  (dst, v) = r
  dst[op] <- v

def copy(k: Nat, +op: U32, +dist: U32, dst: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      dst
    case 1n+p:
      copy(p, (op + 1 : U32), dist, copy.put(op, dst[(op - dist : U32)]))

# a match: code = inp[ip] << 8 | inp[ip + 1]; ip += 2; copy len bytes from dist back
def itok.f2(+ip: U32, +op: U32, +clen: U32, hi: U32, dst: Array<U32>,
            r: Array<U32> & U32) -> Dec & Bool:
  (inp, lo) = r
  +code = ((hi << 8n) .|. lo : U32)
  +len = ((code .&. 15) + min_match() : U32)
  +ip2 = (ip + 2 : U32)
  (Dec{inp, copy(U32.to_nat(len), op, ((code >> 4n) + 1 : U32), dst), ip2, (op + len : U32)},
    (ip2 < clen : U32))

def itok.f1(+ip: U32, +op: U32, +clen: U32, dst: Array<U32>, r: Array<U32> & U32) -> Dec & Bool:
  (inp, hi) = r
  itok.f2(ip, op, clen, hi, dst, inp[(ip + 1 : U32)])

# a literal: dst[op++] = inp[ip++]
def itok.lit(+ip: U32, +op: U32, +clen: U32, dst: Array<U32>, r: Array<U32> & U32) -> Dec & Bool:
  (inp, x) = r
  +ip1 = (ip + 1 : U32)
  (Dec{inp, dst[op] <- x, ip1, (op + 1 : U32)}, (ip1 < clen : U32))

def itok.put(m: Bool, +ip: U32, +op: U32, +clen: U32, inp: Array<U32>, dst: Array<U32>) -> Dec & Bool:
  match m:
    case True{}:
      itok.f1(ip, op, clen, dst, inp[ip])
    case False{}:
      itok.lit(ip, op, clen, dst, inp[ip])

# if (ctrl & (1 << b))
def itok(+b: U32, +ctrl: U32, +clen: U32, d: Dec) -> Dec & Bool:
  Dec{inp, dst, ip, op} = d
  itok.put(U32.is_ne((ctrl .&. (1 << U32.to_nat(b)) : U32), 0), ip, op, clen, inp, dst)

# for (b = 0; b < 8 && ip < clen; b++)
def itoks(k: Nat, +b: U32, +ctrl: U32, +clen: U32, r: Dec & Bool) -> Dec:
  match k:
    case 0n:
      (d, go) = r
      d
    case 1n+p:
      (d, go) = r
      match go:
        case False{}:
          d
        case True{}:
          itoks(p, (b + 1 : U32), ctrl, clen, itok(b, ctrl, clen, d))

def iblock.fin(+clen: U32, d: Dec) -> Dec & Bool:
  Dec{inp, dst, +ip, op} = d
  (Dec{inp, dst, ip, op}, (ip < clen : U32))

# ctrl = inp[ip++]; up to 8 tokens
def iblock.f1(+ip: U32, op: U32, +clen: U32, dst: Array<U32>, r: Array<U32> & U32) -> Dec & Bool:
  (inp, ctrl) = r
  +ip1 = (ip + 1 : U32)
  iblock.fin(clen, itoks(8n, 0, ctrl, clen, (Dec{inp, dst, ip1, op}, (ip1 < clen : U32))))

def iblock(+clen: U32, d: Dec) -> Dec & Bool:
  Dec{inp, dst, +ip, op} = d
  iblock.f1(ip, op, clen, dst, inp[ip])

# while (ip < clen): a block takes at least one byte, so clen + 1 steps of fuel
def inflate(f: Nat, +clen: U32, r: Dec & Bool) -> Dec:
  match f:
    case 0n:
      (d, go) = r
      d
    case 1n+p:
      (d, go) = r
      match go:
        case False{}:
          d
        case True{}:
          inflate(p, clen, iblock(clen, d))

# ok = 0 where dec[i] !== src[i]
def check.f2(ok: U32, x: U32, dec: Array<U32>, r: Array<U32> & U32) -> (Array<U32> & Array<U32>) & U32:
  (src, y) = r
  ((dec, src), Bool.pick(U32, U32.is_ne(x, y), 0, ok))

def check.f1(+i: U32, ok: U32, src: Array<U32>, r: Array<U32> & U32) -> (Array<U32> & Array<U32>) & U32:
  (dec, x) = r
  check.f2(ok, x, dec, src[i])

def check.step(+i: U32, s: (Array<U32> & Array<U32>) & U32) -> (Array<U32> & Array<U32>) & U32:
  ((dec, src), ok) = s
  check.f1(i, ok, src, dec[i])

def check(k: Nat, +i: U32, s: (Array<U32> & Array<U32>) & U32) -> (Array<U32> & Array<U32>) & U32:
  match k:
    case 0n:
      s
    case 1n+p:
      check(p, (i + 1 : U32), check.step(i, s))

# h = mix(h, ok); src[j] = (src[j] + 1) & 0xff, j = it % N
def pass.bump(+j: U32, h: U32, comp: Array<U32>, dec: Array<U32>, r: Array<U32> & U32) -> Lz & U32:
  (src, x) = r
  (Lz{src[j] <- ((x + 1) .&. 255 : U32), comp, dec}, h)

def pass.mix(+it: U32, ok: U32, src: Array<U32>, dec: Array<U32>, r: Array<U32> & U32) -> Lz & U32:
  (comp, h) = r
  +j = U32.mod(it, n())
  pass.bump(j, B.mix(h, ok), comp, dec, src[j])

# h = mix(h, clen); h = mix(h, comp[i]) for i < clen
def pass.hash(+it: U32, h: U32, +clen: U32, comp: Array<U32>,
              r: (Array<U32> & Array<U32>) & U32) -> Lz & U32:
  ((dec, src), ok) = r
  pass.mix(it, ok, src, dec, B.checksum.go(U32.to_nat(clen), 1, 0, (comp, B.mix(h, clen))))

# ok = dlen === N, then byte by byte
def pass.check(+it: U32, h: U32, +clen: U32, src: Array<U32>, d: Dec) -> Lz & U32:
  Dec{comp, dec, ip, dlen} = d
  pass.hash(it, h, clen, comp,
    check(U32.to_nat(n()), 0, ((dec, src), Bool.to_u32(U32.is_eq(dlen, n())))))

def pass.inflate(+it: U32, h: U32, dec: Array<U32>, e: Enc) -> Lz & U32:
  Enc{src, comp, ip, +clen, ctrl} = e
  pass.check(it, h, clen, src,
    inflate(U32.to_nat((clen + 1 : U32)), clen, (Dec{comp, dec, 0, 0}, (0 < clen : U32))))

def pass(+it: U32, r: Lz & U32) -> Lz & U32:
  (z, h) = r
  Lz{src, comp, dec} = z
  pass.inflate(it, h, dec,
    compress(U32.to_nat((n() + 1 : U32)), (Enc{src, comp, 0, 0, 0}, (0 < n() : U32))))

def run_kernel(k: Nat, +it: U32, r: Lz & U32) -> Lz & U32:
  match k:
    case 0n:
      r
    case 1n+p:
      run_kernel(p, (it + 1 : U32), pass(it, r))

def kernel(r: Lz & U32) -> Lz & U32:
  (z, h) = r
  run_kernel(5n, 0, (z, 0))

def checksum(r: Lz & U32) -> U32:
  (z, h) = r
  h

def main() -> IO(Unit):
  src = init(U32.to_nat(n()), 0, 305419896, [0 : U32*4096n])
  s = B.warm(~Lz & U32, ~(r => r), ~kernel, 5n,
    (Lz{src, [0 : U32*16384n], [0 : U32*4096n]}, 0))
  do IO<Unit>:
    r : (Lz & U32) & List<&2, U32> <- B.timed(~Lz & U32, ~(r => r), ~kernel, 21n, s, [])
    B.finish(~Lz & U32, ~checksum, (n() * 5 : U32), 1, 21, r)
