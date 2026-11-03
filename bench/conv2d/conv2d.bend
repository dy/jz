import Base
import ../_lib/bench.bend as B
# conv2d.bend: Bend port of conv2d.js (same tensors, passes, perturbation and
# checksum): a quantized int8 3x3 convolution, 4 input channels to 16 output
# channels over a 34x34 image, requantized by an arithmetic shift, ReLU and a
# clamp to 127. Bend has no signed integer: an int8 is a U32 sign-extended in
# two's complement, so products and sums keep int32's bits, the sign tests
# read bit 31, and the perturbation wraps the byte as Int8Array does.

type Conv is Type:
  Conv{inp: Array<U32>, wt: Array<U32>, bias: Array<U32>, out: Array<U32>}

type Mac is Type:
  Mac{inp: Array<U32>, wt: Array<U32>, acc: U32}

def cin() -> U32:
  4

def h() -> U32:
  34

def w() -> U32:
  34

def ow() -> U32:
  32

def in_len() -> U32:
  4624

def out_len() -> U32:
  16384

# x >> 24 of an int32: the sign fills the top 24 bits
def sar24(+x: U32) -> U32:
  Bool.pick(U32, (x >= 2147483648 : U32), (x >> 24n .|. 4294967040 : U32), (x >> 24n : U32))

# int8 fill: x = imul(x, 1103515245) + 12345; arr[i] = x >> 24
def fill_i8(k: Nat, +i: U32, +x: U32, a: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      a
    case 1n+p:
      +y = (x * 1103515245 + 12345 : U32)
      fill_i8(p, (i + 1 : U32), y, a[i] <- sar24(y))

# bias: (x >> 20) & 1023
def fill_bias(k: Nat, +i: U32, +x: U32, a: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      a
    case 1n+p:
      +y = (x * 1103515245 + 12345 : U32)
      fill_bias(p, (i + 1 : U32), y, a[i] <- (y >> 20n .&. 1023 : U32))

# acc += inp[irow + kx] * wt[wrow + kx]
def mac.f2(acc: U32, x: U32, inp: Array<U32>, r: Array<U32> & U32) -> Mac:
  (wt, y) = r
  Mac{inp, wt, (acc + x * y : U32)}

def mac.f1(+wi: U32, acc: U32, wt: Array<U32>, r: Array<U32> & U32) -> Mac:
  (inp, x) = r
  mac.f2(acc, x, inp, wt[wi])

def mac(+ii: U32, +wi: U32, m: Mac) -> Mac:
  Mac{inp, wt, acc} = m
  mac.f1(wi, acc, wt, inp[ii])

def kxs(k: Nat, +kx: U32, +irow: U32, +wrow: U32, m: Mac) -> Mac:
  match k:
    case 0n:
      m
    case 1n+p:
      kxs(p, (kx + 1 : U32), irow, wrow, mac((irow + kx : U32), (wrow + kx : U32), m))

# irow = inCh + (oy + ky) * W + ox; wrow = wCh + ky * K
def kys(k: Nat, +ky: U32, +in_ch: U32, +w_ch: U32, +oy: U32, +ox: U32, m: Mac) -> Mac:
  match k:
    case 0n:
      m
    case 1n+p:
      kys(p, (ky + 1 : U32), in_ch, w_ch, oy, ox,
        kxs(3n, 0, (in_ch + (oy + ky) * w() + ox : U32), (w_ch + ky * 3 : U32), m))

# inCh = ic * H * W; wCh = ((oc * CIN) + ic) * K * K
def ics(k: Nat, +ic: U32, +oc: U32, +oy: U32, +ox: U32, m: Mac) -> Mac:
  match k:
    case 0n:
      m
    case 1n+p:
      ics(p, (ic + 1 : U32), oc, oy, ox,
        kys(3n, 0, (ic * h() * w() : U32), ((oc * cin() + ic) * 9 : U32), oy, ox, m))

# q = acc >> SHIFT; ReLU; clamp to 127
def requant(+acc: U32) -> U32:
  Bool.pick(U32, (acc >= 2147483648 : U32), 0, U32.min((acc >> 11n : U32), 127))

def pixel.out(+o: U32, bias: Array<U32>, out: Array<U32>, m: Mac) -> Conv:
  Mac{inp, wt, acc} = m
  Conv{inp, wt, bias, out[o] <- requant(acc)}

def pixel(+oc: U32, +b: U32, +oy: U32, +ox: U32, c: Conv) -> Conv:
  Conv{inp, wt, bias, out} = c
  pixel.out((oc * 1024 + oy * ow() + ox : U32), bias, out, ics(4n, 0, oc, oy, ox, Mac{inp, wt, b}))

def oxs(k: Nat, +ox: U32, +oc: U32, +b: U32, +oy: U32, c: Conv) -> Conv:
  match k:
    case 0n:
      c
    case 1n+p:
      oxs(p, (ox + 1 : U32), oc, b, oy, pixel(oc, b, oy, ox, c))

def oys(k: Nat, +oy: U32, +oc: U32, +b: U32, c: Conv) -> Conv:
  match k:
    case 0n:
      c
    case 1n+p:
      oys(p, (oy + 1 : U32), oc, b, oxs(32n, 0, oc, b, oy, c))

# b = bias[oc], then the channel's 32x32 outputs
def channel(+oc: U32, inp: Array<U32>, wt: Array<U32>, out: Array<U32>, r: Array<U32> & U32) -> Conv:
  (bias, b) = r
  oys(32n, 0, oc, b, Conv{inp, wt, bias, out})

def ocs(k: Nat, +oc: U32, c: Conv) -> Conv:
  match k:
    case 0n:
      c
    case 1n+p:
      Conv{inp, wt, bias, out} = c
      ocs(p, (oc + 1 : U32), channel(oc, inp, wt, out, bias[oc]))

# h = mix(h, checksumU8(out)); inp[j] = inp[j] + 1 as an int8, j = it % IN_LEN
def pass.bump(+j: U32, h: U32, wt: Array<U32>, bias: Array<U32>, out: Array<U32>,
              r: Array<U32> & U32) -> Conv & U32:
  (inp, x) = r
  (Conv{inp[j] <- (((x + 1 .&. 255) .^. 128) - 128 : U32), wt, bias, out}, h)

def pass.hash(+j: U32, h: U32, inp: Array<U32>, wt: Array<U32>, bias: Array<U32>,
              r: Array<U32> & U32) -> Conv & U32:
  (out, cs) = r
  pass.bump(j, B.mix(h, cs), wt, bias, out, inp[j])

def pass.conv(+j: U32, h: U32, c: Conv) -> Conv & U32:
  Conv{inp, wt, bias, out} = c
  pass.hash(j, h, inp, wt, bias, B.hash_u8(U32.to_nat(out_len()), out))

def pass(+it: U32, r: Conv & U32) -> Conv & U32:
  (c, h) = r
  pass.conv(U32.mod(it, in_len()), h, ocs(16n, 0, c))

def run_kernel(k: Nat, +it: U32, r: Conv & U32) -> Conv & U32:
  match k:
    case 0n:
      r
    case 1n+p:
      run_kernel(p, (it + 1 : U32), pass(it, r))

def kernel(r: Conv & U32) -> Conv & U32:
  (c, h) = r
  run_kernel(24n, 0, (c, 0))

def checksum(r: Conv & U32) -> U32:
  (c, h) = r
  h

def main() -> IO(Unit):
  inp = fill_i8(4624n, 0, 305419896, [0 : U32*8192n])
  wt = fill_i8(576n, 0, 733200887, [0 : U32*1024n])
  bias = fill_bias(16n, 0, 1373874641, [0 : U32*16n])
  s = B.warm(~Conv & U32, ~(r => r), ~kernel, 5n, (Conv{inp, wt, bias, [0 : U32*16384n]}, 0))
  do IO<Unit>:
    r : (Conv & U32) & List<&2, U32> <- B.timed(~Conv & U32, ~(r => r), ~kernel, 21n, s, [])
    B.finish(~Conv & U32, ~checksum, (16384 * 36 * 24 : U32), 1, 21, r)
