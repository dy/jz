import Base
import ../_lib/bench.bend as B
# qoi.bend: Bend port of qoi.js (same image, ops, passes, perturbation and
# checksum): a QOI encoder and decoder round trip over a 256x256 RGBA image,
# each pixel the cheapest of run, index, diff, luma or literal against the
# previous one. A pixel is a Data record, Px, copied where the JS reads it
# twice; the four index arrays ride in a record, Ix, read and written four
# at a time. Each if-else chain is a chain of defs taking the caller's Bool.
# Bend has no signed integer: a channel delta is the wrapped byte shifted
# left 24 then arithmetically right 24 (the sign filled), and a two-sided
# test like -2 <= vr <= 1 is the one unsigned test vr + 2 <= 3, as blur
# clamps by comparing x + k with the radius.

type Px is Data:
  Px{r: U32, g: U32, b: U32, a: U32}

type Ix is Type:
  Ix{ir: Array<U32>, ig: Array<U32>, ib: Array<U32>, ia: Array<U32>}

# the output and its cursor, beside the pending run
type Out is Type:
  Out{buf: Array<U32>, op: U32, run: U32}

type Enc is Type:
  Enc{img: Array<U32>, o: Out, ix: Ix, pv: Px}

type Dec is Type:
  Dec{inp: Array<U32>, out: Array<U32>, ix: Ix, pv: Px, run: U32, ip: U32}

type Qoi is Type:
  Qoi{img: Array<U32>, comp: Array<U32>, dec: Array<U32>, ix: Ix}

def npix() -> U32:
  65536

def img_len() -> U32:
  262144

# x = imul(x, 1103515245) + 12345; roll = (x >>> 28) & 7 keeps the pixel
# (roll < 3), nudges each channel (roll < 6), draws a fresh colour (6) or a
# fresh alpha (7)
def mk.fresh(eq6: Bool, +x: U32, c: Px) -> Px:
  match eq6:
    case True{}:
      Px{r, g, b, a} = c
      Px{((x >> 10n) .&. 255 : U32), ((x >> 16n) .&. 255 : U32), ((x >> 20n) .&. 255 : U32), a}
    case False{}:
      Px{r, g, b, a} = c
      Px{r, g, b, ((x >> 12n) .&. 255 : U32)}

def mk.delta(lt6: Bool, +roll: U32, +x: U32, c: Px) -> Px:
  match lt6:
    case True{}:
      Px{r, g, b, a} = c
      Px{(((r + ((x >> 4n) .&. 3)) - 1) .&. 255 : U32),
        (((g + ((x >> 6n) .&. 3)) - 1) .&. 255 : U32),
        (((b + ((x >> 8n) .&. 3)) - 1) .&. 255 : U32), a}
    case False{}:
      mk.fresh(U32.is_eq(roll, 6), x, c)

def mk.roll(lt3: Bool, +roll: U32, +x: U32, c: Px) -> Px:
  match lt3:
    case True{}:
      c
    case False{}:
      mk.delta((roll < 6 : U32), roll, x, c)

# img[o..o+3] = r, g, b, a
def put4(+o: U32, px: Px, buf: Array<U32>) -> Array<U32>:
  Px{r, g, b, a} = px
  buf[o] <- r
  buf[(o + 1 : U32)] <- g
  buf[(o + 2 : U32)] <- b
  buf[(o + 3 : U32)] <- a

def mk(k: Nat, +p: U32, +x: U32, c: Px, img: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      img
    case 1n+q:
      +y = (x * 1103515245 + 12345 : U32)
      +roll = ((y >> 28n) .&. 7 : U32)
      +c1 = mk.roll((roll < 3 : U32), roll, y, c)
      mk(q, (p + 1 : U32), y, c1, put4((p << 2n : U32), c1, img))

def hash(px: Px) -> U32:
  Px{r, g, b, a} = px
  (((r * 3) + (g * 5) + (b * 7) + (a * 11)) .&. 63 : U32)

def px.eq(x: Px, y: Px) -> Bool:
  Px{r, g, b, a} = x
  Px{r2, g2, b2, a2} = y
  U32.is_eq(r, r2) && U32.is_eq(g, g2) && U32.is_eq(b, b2) && U32.is_eq(a, a2)

# (x << 24) >> 24 on an int32, x already shifted: the sign bit fills the top 24
def sext(+s: U32) -> U32:
  Bool.pick(U32, (s >= 2147483648 : U32), ((s >> 24n) .|. 4294967040 : U32), (s >> 24n : U32))

# r, g, b at buf[o..o+2], the alpha given; rgba reads the alpha at o + 3 first
def rgb.b(a: U32, r: U32, g: U32, x: Array<U32> & U32) -> Array<U32> & Px:
  (buf, b) = x
  (buf, Px{r, g, b, a})

def rgb.g(+o: U32, a: U32, r: U32, x: Array<U32> & U32) -> Array<U32> & Px:
  (buf, g) = x
  rgb.b(a, r, g, buf[(o + 2 : U32)])

def rgb.r(+o: U32, a: U32, x: Array<U32> & U32) -> Array<U32> & Px:
  (buf, r) = x
  rgb.g(o, a, r, buf[(o + 1 : U32)])

def rgb(+o: U32, a: U32, buf: Array<U32>) -> Array<U32> & Px:
  rgb.r(o, a, buf[o])

def rgba.a(+o: U32, x: Array<U32> & U32) -> Array<U32> & Px:
  (buf, a) = x
  rgb(o, a, buf)

def rgba(+o: U32, buf: Array<U32>) -> Array<U32> & Px:
  rgba.a(o, buf[(o + 3 : U32)])

# for (i = 0; i < 64; i++) ir[i] = ig[i] = ib[i] = ia[i] = 0
def ix.clear(k: Nat, +i: U32, x: Ix) -> Ix:
  match k:
    case 0n:
      x
    case 1n+q:
      Ix{ir, ig, ib, ia} = x
      ix.clear(q, (i + 1 : U32), Ix{ir[i] <- 0, ig[i] <- 0, ib[i] <- 0, ia[i] <- 0})

def ix.set(+h: U32, px: Px, x: Ix) -> Ix:
  Px{r, g, b, a} = px
  Ix{ir, ig, ib, ia} = x
  Ix{ir[h] <- r, ig[h] <- g, ib[h] <- b, ia[h] <- a}

# (ir[h], ig[h], ib[h], ia[h]): the index back beside the pixel
def ix.get.a(r: U32, g: U32, b: U32, ir: Array<U32>, ig: Array<U32>, ib: Array<U32>,
             x: Array<U32> & U32) -> Ix & Px:
  (ia, a) = x
  (Ix{ir, ig, ib, ia}, Px{r, g, b, a})

def ix.get.b(+h: U32, r: U32, g: U32, ir: Array<U32>, ig: Array<U32>, ia: Array<U32>,
             x: Array<U32> & U32) -> Ix & Px:
  (ib, b) = x
  ix.get.a(r, g, b, ir, ig, ib, ia[h])

def ix.get.g(+h: U32, r: U32, ir: Array<U32>, ib: Array<U32>, ia: Array<U32>,
             x: Array<U32> & U32) -> Ix & Px:
  (ig, g) = x
  ix.get.b(h, r, g, ir, ig, ia, ib[h])

def ix.get.r(+h: U32, ig: Array<U32>, ib: Array<U32>, ia: Array<U32>,
             x: Array<U32> & U32) -> Ix & Px:
  (ir, r) = x
  ix.get.g(h, r, ir, ib, ia, ig[h])

def ix.get(+h: U32, x: Ix) -> Ix & Px:
  Ix{ir, ig, ib, ia} = x
  ix.get.r(h, ig, ib, ia, ir[h])

# out[op++] = v
def put(v: U32, o: Out) -> Out:
  Out{buf, +op, run} = o
  Out{buf[op] <- v, (op + 1 : U32), run}

# out[op++] = 0xc0 | (run - 1); run = 0
def flush(f: Bool, o: Out) -> Out:
  match f:
    case True{}:
      Out{buf, +op, run} = o
      Out{buf[op] <- (192 .|. (run - 1) : U32), (op + 1 : U32), 0}
    case False{}:
      o

# QOI_OP_LUMA (vg + 32, then (vgr + 8) << 4 | (vgb + 8)), else QOI_OP_RGB
def enc.luma(lu: Bool, r: U32, g: U32, b: U32, dg: U32, dgr: U32, dgb: U32, o: Out) -> Out:
  match lu:
    case True{}:
      put(((dgr << 4n) .|. dgb : U32), put((128 .|. dg : U32), o))
    case False{}:
      put(b, put(g, put(r, put(254, o))))

# QOI_OP_DIFF: 0x40 | (vr + 2) << 4 | (vg + 2) << 2 | (vb + 2); else
# -8 <= vgr <= 7, -32 <= vg <= 31, -8 <= vgb <= 7 tries the luma op
def enc.diff(sm: Bool, r: U32, g: U32, b: U32, +vr: U32, +vg: U32, +vb: U32, o: Out) -> Out:
  match sm:
    case True{}:
      put((64 .|. ((vr + 2) << 4n) .|. ((vg + 2) << 2n) .|. (vb + 2) : U32), o)
    case False{}:
      +dgr = ((vr - vg) + 8 : U32)
      +dg = (vg + 32 : U32)
      +dgb = ((vb - vg) + 8 : U32)
      enc.luma((dgr <= 15 : U32) && (dg <= 63 : U32) && (dgb <= 15 : U32), r, g, b, dg, dgr, dgb, o)

# a === pa: vr, vg, vb the signed-8-bit deltas, -2 <= each <= 1 for the
# diff op; else QOI_OP_RGBA
def enc.rgb(same: Bool, +r: U32, +g: U32, +b: U32, a: U32, pr: U32, pg: U32, pb: U32,
            o: Out) -> Out:
  match same:
    case True{}:
      +vr = sext(((r - pr) << 24n : U32))
      +vg = sext(((g - pg) << 24n : U32))
      +vb = sext(((b - pb) << 24n : U32))
      enc.diff(((vr + 2 : U32) <= 3 : U32) && ((vg + 2 : U32) <= 3 : U32) && ((vb + 2 : U32) <= 3 : U32),
        r, g, b, vr, vg, vb, o)
    case False{}:
      put(a, put(b, put(g, put(r, put(255, o)))))

def enc.alpha(px: Px, pv: Px, o: Out) -> Out:
  Px{r, g, b, +a} = px
  Px{pr, pg, pb, pa} = pv
  enc.rgb(U32.is_eq(a, pa), r, g, b, a, pr, pg, pb, o)

# the index holds the pixel: QOI_OP_INDEX; else the index takes it
def enc.miss(hit: Bool, +h: U32, img: Array<U32>, o: Out, +px: Px, pv: Px, ix: Ix) -> Enc:
  match hit:
    case True{}:
      Enc{img, put(h, o), ix, px}
    case False{}:
      Enc{img, enc.alpha(px, pv, o), ix.set(h, px, ix), px}

def enc.look(img: Array<U32>, o: Out, +px: Px, pv: Px, +h: U32, x: Ix & Px) -> Enc:
  (ix, q) = x
  enc.miss(px.eq(q, px), h, img, o, px, pv, ix)

# a new pixel: a pending run goes out first, then h = hash(px)
def enc.new(img: Array<U32>, o: Out, +px: Px, pv: Px, ix: Ix) -> Enc:
  Out{buf, op, +run} = o
  +h = hash(px)
  enc.look(img, flush((run > 0 : U32), Out{buf, op, run}), px, pv, h, ix.get(h, ix))

# the pixel repeats: run++, out at 62 or at the last pixel
def enc.same(same: Bool, +p: U32, img: Array<U32>, o: Out, +px: Px, pv: Px, ix: Ix) -> Enc:
  match same:
    case True{}:
      Out{buf, op, run} = o
      +run1 = (run + 1 : U32)
      Enc{img, flush(U32.is_eq(run1, 62) || U32.is_eq(p, (npix() - 1 : U32)), Out{buf, op, run1}), ix, px}
    case False{}:
      enc.new(img, o, px, pv, ix)

def enc.f1(+p: U32, o: Out, ix: Ix, +pv: Px, x: Array<U32> & Px) -> Enc:
  (img, +px) = x
  enc.same(px.eq(px, pv), p, img, o, px, pv, ix)

def enc.px(+p: U32, e: Enc) -> Enc:
  Enc{img, o, ix, pv} = e
  enc.f1(p, o, ix, pv, rgba((p << 2n : U32), img))

def encode(k: Nat, +p: U32, e: Enc) -> Enc:
  match k:
    case 0n:
      e
    case 1n+q:
      encode(q, (p + 1 : U32), enc.px(p, e))

# a decoded op hands the input back beside the new pixel
def dec.set(out: Array<U32>, ix: Ix, run: U32, ip: U32, x: Array<U32> & Px) -> Dec:
  (inp, pv) = x
  Dec{inp, out, ix, pv, run, ip}

# QOI_OP_LUMA: vg = (b0 & 63) - 32, the red and blue deltas from b1
def dec.luma(+b0: U32, out: Array<U32>, ix: Ix, pv: Px, run: U32, ip: U32,
             x: Array<U32> & U32) -> Dec:
  Px{pr, pg, pb, pa} = pv
  (inp, +b1) = x
  +vg = ((b0 .&. 63) - 32 : U32)
  Dec{inp, out, ix,
    Px{((((pr + vg) + ((b1 >> 4n) .&. 15)) - 8) .&. 255 : U32), ((pg + vg) .&. 255 : U32),
      ((((pb + vg) + (b1 .&. 15)) - 8) .&. 255 : U32), pa}, run, ip}

# (b0 & 0xc0) === 0x80: the luma op; else QOI_OP_RUN, run = b0 & 63
def dec.t80(tag: Bool, +b0: U32, inp: Array<U32>, out: Array<U32>, ix: Ix, pv: Px, run: U32,
            +ip: U32) -> Dec:
  match tag:
    case True{}:
      dec.luma(b0, out, ix, pv, run, (ip + 1 : U32), inp[ip])
    case False{}:
      Dec{inp, out, ix, pv, (b0 .&. 63 : U32), ip}

# (b0 & 0xc0) === 0x40: QOI_OP_DIFF, each channel nudged by its 2 bits less 2
def dec.t40(tag: Bool, +b0: U32, inp: Array<U32>, out: Array<U32>, ix: Ix, pv: Px, run: U32,
            ip: U32) -> Dec:
  match tag:
    case True{}:
      Px{pr, pg, pb, pa} = pv
      Dec{inp, out, ix,
        Px{(((pr + ((b0 >> 4n) .&. 3)) - 2) .&. 255 : U32),
          (((pg + ((b0 >> 2n) .&. 3)) - 2) .&. 255 : U32),
          (((pb + (b0 .&. 3)) - 2) .&. 255 : U32), pa}, run, ip}
    case False{}:
      dec.t80(U32.is_eq((b0 .&. 192 : U32), 128), b0, inp, out, ix, pv, run, ip)

def dec.ix(inp: Array<U32>, out: Array<U32>, run: U32, ip: U32, x: Ix & Px) -> Dec:
  (ix, pv) = x
  Dec{inp, out, ix, pv, run, ip}

# (b0 & 0xc0) === 0x00: QOI_OP_INDEX, the pixel from the index at b0
def dec.t00(tag: Bool, +b0: U32, inp: Array<U32>, out: Array<U32>, ix: Ix, pv: Px, run: U32,
            ip: U32) -> Dec:
  match tag:
    case True{}:
      dec.ix(inp, out, run, ip, ix.get(b0, ix))
    case False{}:
      dec.t40(U32.is_eq((b0 .&. 192 : U32), 64), b0, inp, out, ix, pv, run, ip)

# b0 === 0xff: QOI_OP_RGBA, four bytes
def dec.ff(tag: Bool, +b0: U32, inp: Array<U32>, out: Array<U32>, ix: Ix, pv: Px, run: U32,
           +ip: U32) -> Dec:
  match tag:
    case True{}:
      dec.set(out, ix, run, (ip + 4 : U32), rgba(ip, inp))
    case False{}:
      dec.t00(U32.is_eq((b0 .&. 192 : U32), 0), b0, inp, out, ix, pv, run, ip)

# b0 === 0xfe: QOI_OP_RGB, three bytes, the alpha kept
def dec.fe(tag: Bool, +b0: U32, inp: Array<U32>, out: Array<U32>, ix: Ix, pv: Px, run: U32,
           +ip: U32) -> Dec:
  match tag:
    case True{}:
      Px{pr, pg, pb, pa} = pv
      dec.set(out, ix, run, (ip + 3 : U32), rgb(ip, pa, inp))
    case False{}:
      dec.ff(U32.is_eq(b0, 255), b0, inp, out, ix, pv, run, ip)

# h = hash(pixel); the index takes it
def dec.index(d: Dec) -> Dec:
  Dec{inp, out, ix, +pv, run, ip} = d
  Dec{inp, out, ix.set(hash(pv), pv, ix), pv, run, ip}

# b0 = inp[ip++], then the op it names
def dec.b0(out: Array<U32>, ix: Ix, pv: Px, run: U32, +ip: U32, x: Array<U32> & U32) -> Dec:
  (inp, +b0) = x
  dec.index(dec.fe(U32.is_eq(b0, 254), b0, inp, out, ix, pv, run, (ip + 1 : U32)))

# else if (ip < clen)
def dec.next(go: Bool, inp: Array<U32>, out: Array<U32>, ix: Ix, pv: Px, run: U32,
             +ip: U32) -> Dec:
  match go:
    case True{}:
      dec.b0(out, ix, pv, run, ip, inp[ip])
    case False{}:
      Dec{inp, out, ix, pv, run, ip}

# if (run > 0) run--
def dec.run(more: Bool, +clen: U32, inp: Array<U32>, out: Array<U32>, ix: Ix, pv: Px,
            +run: U32, +ip: U32) -> Dec:
  match more:
    case True{}:
      Dec{inp, out, ix, pv, (run - 1 : U32), ip}
    case False{}:
      dec.next((ip < clen : U32), inp, out, ix, pv, run, ip)

# out[o..o+3] = pr, pg, pb, pa
def dec.put(+p: U32, d: Dec) -> Dec:
  Dec{inp, out, ix, +pv, run, ip} = d
  Dec{inp, put4((p << 2n : U32), pv, out), ix, pv, run, ip}

def dec.px(+p: U32, +clen: U32, d: Dec) -> Dec:
  Dec{inp, out, ix, pv, +run, ip} = d
  dec.put(p, dec.run((run > 0 : U32), clen, inp, out, ix, pv, run, ip))

def decode(k: Nat, +p: U32, +clen: U32, d: Dec) -> Dec:
  match k:
    case 0n:
      d
    case 1n+q:
      decode(q, (p + 1 : U32), clen, dec.px(p, clen, d))

# ok = 0 where dec[i] !== img[i]
def check.f2(ok: U32, x: U32, dec: Array<U32>, r: Array<U32> & U32) -> (Array<U32> & Array<U32>) & U32:
  (img, y) = r
  ((dec, img), Bool.pick(U32, U32.is_ne(x, y), 0, ok))

def check.f1(+i: U32, ok: U32, img: Array<U32>, r: Array<U32> & U32) -> (Array<U32> & Array<U32>) & U32:
  (dec, x) = r
  check.f2(ok, x, dec, img[i])

def check.step(+i: U32, s: (Array<U32> & Array<U32>) & U32) -> (Array<U32> & Array<U32>) & U32:
  ((dec, img), ok) = s
  check.f1(i, ok, img, dec[i])

def check(k: Nat, +i: U32, s: (Array<U32> & Array<U32>) & U32) -> (Array<U32> & Array<U32>) & U32:
  match k:
    case 0n:
      s
    case 1n+q:
      check(q, (i + 1 : U32), check.step(i, s))

# h = mix(h, ok); img[j] = (img[j] + 1) & 255, j = (it % NPIX) << 2
def pass.bump(+j: U32, h: U32, comp: Array<U32>, dec: Array<U32>, ix: Ix,
              r: Array<U32> & U32) -> Qoi & U32:
  (img, x) = r
  (Qoi{img[j] <- ((x + 1) .&. 255 : U32), comp, dec, ix}, h)

def pass.mix(+it: U32, ok: U32, img: Array<U32>, dec: Array<U32>, ix: Ix,
             r: Array<U32> & U32) -> Qoi & U32:
  (comp, h) = r
  +j = (U32.mod(it, npix()) << 2n : U32)
  pass.bump(j, B.mix(h, ok), comp, dec, ix, img[j])

# h = mix(h, clen); h = mix(h, comp[i]) for i < clen
def pass.hash(+it: U32, h: U32, +clen: U32, comp: Array<U32>, ix: Ix,
              r: (Array<U32> & Array<U32>) & U32) -> Qoi & U32:
  ((dec, img), ok) = r
  pass.mix(it, ok, img, dec, ix, B.checksum.go(U32.to_nat(clen), 1, 0, (comp, B.mix(h, clen))))

def pass.check(+it: U32, h: U32, +clen: U32, img: Array<U32>, d: Dec) -> Qoi & U32:
  Dec{comp, dec, ix, pv, run, ip} = d
  pass.hash(it, h, clen, comp, ix, check(U32.to_nat(img_len()), 0, ((dec, img), 1)))

def pass.decode(+it: U32, h: U32, dec: Array<U32>, e: Enc) -> Qoi & U32:
  Enc{img, o, ix, pv} = e
  Out{comp, +clen, run} = o
  pass.check(it, h, clen, img,
    decode(U32.to_nat(npix()), 0, clen, Dec{comp, dec, ix.clear(64n, 0, ix), Px{0, 0, 0, 255}, 0, 0}))

def pass(+it: U32, r: Qoi & U32) -> Qoi & U32:
  (q, h) = r
  Qoi{img, comp, dec, ix} = q
  pass.decode(it, h, dec,
    encode(U32.to_nat(npix()), 0, Enc{img, Out{comp, 0, 0}, ix.clear(64n, 0, ix), Px{0, 0, 0, 255}}))

def run_kernel(k: Nat, +it: U32, r: Qoi & U32) -> Qoi & U32:
  match k:
    case 0n:
      r
    case 1n+q:
      run_kernel(q, (it + 1 : U32), pass(it, r))

def kernel(r: Qoi & U32) -> Qoi & U32:
  (q, h) = r
  run_kernel(10n, 0, (q, 0))

def checksum(r: Qoi & U32) -> U32:
  (q, h) = r
  h

def main() -> IO(Unit):
  img = mk(U32.to_nat(npix()), 0, 305419896, Px{128, 128, 128, 255}, [0 : U32*262144n])
  s = B.warm(~Qoi & U32, ~(r => r), ~kernel, 5n,
    (Qoi{img, [0 : U32*524288n], [0 : U32*262144n],
      Ix{[0 : U32*64n], [0 : U32*64n], [0 : U32*64n], [0 : U32*64n]}}, 0))
  do IO<Unit>:
    r : (Qoi & U32) & List<&2, U32> <- B.timed(~Qoi & U32, ~(r => r), ~kernel, 21n, s, [])
    B.finish(~Qoi & U32, ~checksum, (npix() * 10 : U32), 1, 21, r)
