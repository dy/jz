import Base
import ../_lib/bench.bend as B
# dict.bend: Bend port of dict.js (same keys, table, passes and checksum): an
# open-addressing integer hash table with linear probing, cleared, filled
# with 8192 keys and probed for each per pass. A probe reads keys[h] and
# answers the table with two Bools, the slot is empty and the slot holds the
# key, which the probe loop matches on. Bend checks that a loop ends: a
# probe loop carries a Nat fuel of CAP + 1 steps, more than a table at load
# factor 0.5 can take.

type Dict is Type:
  Dict{keys: Array<U32>, vals: Array<U32>, src: Array<U32>}

def cap() -> U32:
  16384

def mask() -> U32:
  16383

def nkeys() -> U32:
  8192

def empty() -> U32:
  4294967295

# Deterministic positive keys: XorShift32 masked to 31 bits.
def fill(k: Nat, +i: U32, +s: U32, a: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      a
    case 1n+p:
      +s1 = (s .^. (s << 13n) : U32)
      +s2 = (s1 .^. (s1 >> 17n) : U32)
      +s3 = (s2 .^. (s2 << 5n) : U32)
      fill(p, (i + 1 : U32), s3, a[i] <- (s3 .&. 2147483647 : U32))

def hash(k: U32) -> U32:
  (k * 2654435761 .&. mask() : U32)

# keys[h]: the table, then (keys[h] === EMPTY, keys[h] === k)
def probe.f1(k: U32, r: Array<U32> & U32) -> Array<U32> & (Bool & Bool):
  (keys, +x) = r
  (keys, (U32.is_eq(x, empty()), U32.is_eq(x, k)))

def probe(k: U32, +h: U32, keys: Array<U32>) -> Array<U32> & (Bool & Bool):
  probe.f1(k, keys[h])

def insert(f: Nat, +k: U32, v: U32, +h: U32, vals: Array<U32>, src: Array<U32>,
           r: Array<U32> & (Bool & Bool)) -> Dict:
  match f:
    case 0n:
      (keys, t) = r
      Dict{keys, vals, src}
    case 1n+p:
      (keys, (miss, hit)) = r
      match miss hit:
        case True{} _:
          Dict{keys[h] <- k, vals[h] <- v, src}
        case False{} True{}:
          Dict{keys, vals[h] <- v, src}
        case False{} False{}:
          +g = (h + 1 .&. mask() : U32)
          insert(p, k, v, g, vals, src, probe(k, g, keys))

def lookup.val(keys: Array<U32>, src: Array<U32>, r: Array<U32> & U32) -> Dict & U32:
  (vals, v) = r
  (Dict{keys, vals, src}, v)

def lookup(f: Nat, +k: U32, +h: U32, vals: Array<U32>, src: Array<U32>,
           r: Array<U32> & (Bool & Bool)) -> Dict & U32:
  match f:
    case 0n:
      (keys, t) = r
      (Dict{keys, vals, src}, empty())
    case 1n+p:
      (keys, (miss, hit)) = r
      match miss hit:
        case True{} _:
          (Dict{keys, vals, src}, empty())
        case False{} True{}:
          lookup.val(keys, src, vals[h])
        case False{} False{}:
          +g = (h + 1 .&. mask() : U32)
          lookup(p, k, g, vals, src, probe(k, g, keys))

def clear(k: Nat, +i: U32, a: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      a
    case 1n+p:
      clear(p, (i + 1 : U32), a[i] <- empty())

# insert(keys, vals, src[i], src[i] + it)
def put.f1(+it: U32, keys: Array<U32>, vals: Array<U32>, r: Array<U32> & U32) -> Dict:
  (src, +k) = r
  +h = hash(k)
  insert(U32.to_nat((cap() + 1 : U32)), k, (k + it : U32), h, vals, src, probe(k, h, keys))

def put(+it: U32, +i: U32, d: Dict) -> Dict:
  Dict{keys, vals, src} = d
  put.f1(it, keys, vals, src[i])

def puts(k: Nat, +it: U32, +i: U32, d: Dict) -> Dict:
  match k:
    case 0n:
      d
    case 1n+p:
      puts(p, it, (i + 1 : U32), put(it, i, d))

# h = mix(h, lookup(keys, vals, src[(i * 7) & (NKEYS - 1)]))
def get.mix(h: U32, r: Dict & U32) -> Dict & U32:
  (d, v) = r
  (d, B.mix(h, v))

def get.f1(h: U32, keys: Array<U32>, vals: Array<U32>, r: Array<U32> & U32) -> Dict & U32:
  (src, +k) = r
  +g = hash(k)
  get.mix(h, lookup(U32.to_nat((cap() + 1 : U32)), k, g, vals, src, probe(k, g, keys)))

def get(+i: U32, r: Dict & U32) -> Dict & U32:
  (d, h) = r
  Dict{keys, vals, src} = d
  get.f1(h, keys, vals, src[(i * 7 .&. nkeys() - 1 : U32)])

def gets(k: Nat, +i: U32, r: Dict & U32) -> Dict & U32:
  match k:
    case 0n:
      r
    case 1n+p:
      gets(p, (i + 1 : U32), get(i, r))

def pass(+it: U32, r: Dict & U32) -> Dict & U32:
  (d, h) = r
  Dict{keys, vals, src} = d
  +n = U32.to_nat(nkeys())
  gets(n, 0, (puts(n, it, 0, Dict{clear(U32.to_nat(cap()), 0, keys), vals, src}), h))

def run_kernel(k: Nat, +it: U32, r: Dict & U32) -> Dict & U32:
  match k:
    case 0n:
      r
    case 1n+p:
      run_kernel(p, (it + 1 : U32), pass(it, r))

def kernel(r: Dict & U32) -> Dict & U32:
  (d, h) = r
  run_kernel(60n, 0, (d, 2166136261))

def checksum(r: Dict & U32) -> U32:
  (d, h) = r
  h

def main() -> IO(Unit):
  src = fill(U32.to_nat(nkeys()), 0, 305441741, [0 : U32*8192n])
  s = B.warm(~Dict & U32, ~(r => r), ~kernel, 5n, (Dict{[0 : U32*16384n], [0 : U32*16384n], src}, 0))
  do IO<Unit>:
    r : (Dict & U32) & List<&2, U32> <- B.timed(~Dict & U32, ~(r => r), ~kernel, 21n, s, [])
    B.finish(~Dict & U32, ~checksum, (nkeys() * 60 : U32), 2, 21, r)
