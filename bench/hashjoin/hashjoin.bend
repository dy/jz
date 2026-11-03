import Base
import ../_lib/bench.bend as B
# hashjoin.bend: Bend port of hashjoin.js (same relations, table, passes and
# checksum): a probe-dominated hash join, an open-addressing table with
# linear probing cleared and built on 8192 rows each pass, then 65536 probe
# rows streamed through it and their matched payloads summed. A probe reads
# keys[h] and answers the table with two Bools, the slot is empty and the
# slot holds the key, which the probe loop matches on. Bend checks that a
# loop ends: a probe loop carries a Nat fuel of CAP + 1 steps, more than a
# table at load factor 0.5 can take.

type Tab is Type:
  Tab{keys: Array<U32>, vals: Array<U32>}

type Hj is Type:
  Hj{keys: Array<U32>, vals: Array<U32>, build: Array<U32>, probes: Array<U32>}

# the probe pass: the table, the probe rows and the sum
type Pr is Type:
  Pr{tab: Tab, probes: Array<U32>, sum: U32}

def cap() -> U32:
  16384

def mask() -> U32:
  16383

def nbuild() -> U32:
  8192

def nprobe() -> U32:
  65536

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

# probes[i] = build[(i >>> 1) & (BUILD - 1)] for every even i: half the
# probes are build keys
def real.put(+i: U32, probes: Array<U32>, r: Array<U32> & U32) -> Array<U32> & Array<U32>:
  (build, x) = r
  (build, probes[i] <- x)

def real.step(+i: U32, r: Array<U32> & Array<U32>) -> Array<U32> & Array<U32>:
  (build, probes) = r
  real.put(i, probes, build[((i >> 1n) .&. (nbuild() - 1) : U32)])

def real(k: Nat, +i: U32, r: Array<U32> & Array<U32>) -> Array<U32> & Array<U32>:
  match k:
    case 0n:
      r
    case 1n+p:
      real(p, (i + 2 : U32), real.step(i, r))

def hash(k: U32) -> U32:
  (k * 2654435761 .&. mask() : U32)

# keys[h]: the table, then (keys[h] === EMPTY, keys[h] === k)
def probe.f1(k: U32, r: Array<U32> & U32) -> Array<U32> & (Bool & Bool):
  (keys, +x) = r
  (keys, (U32.is_eq(x, empty()), U32.is_eq(x, k)))

def probe(k: U32, +h: U32, keys: Array<U32>) -> Array<U32> & (Bool & Bool):
  probe.f1(k, keys[h])

def insert(f: Nat, +k: U32, v: U32, +h: U32, vals: Array<U32>,
           r: Array<U32> & (Bool & Bool)) -> Tab:
  match f:
    case 0n:
      (keys, t) = r
      Tab{keys, vals}
    case 1n+p:
      (keys, (miss, hit)) = r
      match miss hit:
        case True{} _:
          Tab{keys[h] <- k, vals[h] <- v}
        case False{} True{}:
          Tab{keys, vals[h] <- v}
        case False{} False{}:
          +g = (h + 1 .&. mask() : U32)
          insert(p, k, v, g, vals, probe(k, g, keys))

def lookup.val(keys: Array<U32>, r: Array<U32> & U32) -> Tab & U32:
  (vals, v) = r
  (Tab{keys, vals}, v)

def lookup(f: Nat, +k: U32, +h: U32, vals: Array<U32>, r: Array<U32> & (Bool & Bool)) -> Tab & U32:
  match f:
    case 0n:
      (keys, t) = r
      (Tab{keys, vals}, 0)
    case 1n+p:
      (keys, (miss, hit)) = r
      match miss hit:
        case True{} _:
          (Tab{keys, vals}, 0)
        case False{} True{}:
          lookup.val(keys, vals[h])
        case False{} False{}:
          +g = (h + 1 .&. mask() : U32)
          lookup(p, k, g, vals, probe(k, g, keys))

def clear(k: Nat, +i: U32, a: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      a
    case 1n+p:
      clear(p, (i + 1 : U32), a[i] <- empty())

# insert(keys, vals, build[i], (build[i] + it) | 0)
def put.f1(+it: U32, keys: Array<U32>, vals: Array<U32>, r: Array<U32> & U32) -> Tab & Array<U32>:
  (build, +k) = r
  +h = hash(k)
  (insert(U32.to_nat((cap() + 1 : U32)), k, (k + it : U32), h, vals, probe(k, h, keys)), build)

def put(+it: U32, +i: U32, s: Tab & Array<U32>) -> Tab & Array<U32>:
  (t, build) = s
  Tab{keys, vals} = t
  put.f1(it, keys, vals, build[i])

def puts(k: Nat, +it: U32, +i: U32, s: Tab & Array<U32>) -> Tab & Array<U32>:
  match k:
    case 0n:
      s
    case 1n+p:
      puts(p, it, (i + 1 : U32), put(it, i, s))

# sum = (sum + probe(keys, vals, probes[i])) | 0
def get.sum(sum: U32, probes: Array<U32>, r: Tab & U32) -> Pr:
  (t, v) = r
  Pr{t, probes, (sum + v : U32)}

def get.f1(sum: U32, keys: Array<U32>, vals: Array<U32>, r: Array<U32> & U32) -> Pr:
  (probes, +k) = r
  +h = hash(k)
  get.sum(sum, probes, lookup(U32.to_nat((cap() + 1 : U32)), k, h, vals, probe(k, h, keys)))

def get(+i: U32, p: Pr) -> Pr:
  Pr{t, probes, sum} = p
  Tab{keys, vals} = t
  get.f1(sum, keys, vals, probes[i])

def gets(k: Nat, +i: U32, p: Pr) -> Pr:
  match k:
    case 0n:
      p
    case 1n+q:
      gets(q, (i + 1 : U32), get(i, p))

# h = mix(h, sum)
def pass.fin(h: U32, build: Array<U32>, p: Pr) -> Hj & U32:
  Pr{t, probes, sum} = p
  Tab{keys, vals} = t
  (Hj{keys, vals, build, probes}, B.mix(h, sum))

def pass.probe(h: U32, probes: Array<U32>, s: Tab & Array<U32>) -> Hj & U32:
  (t, build) = s
  pass.fin(h, build, gets(U32.to_nat(nprobe()), 0, Pr{t, probes, 0}))

# clear the table, build it, stream the probes through it
def pass(+it: U32, r: Hj & U32) -> Hj & U32:
  (j, h) = r
  Hj{keys, vals, build, probes} = j
  pass.probe(h, probes,
    puts(U32.to_nat(nbuild()), it, 0, (Tab{clear(U32.to_nat(cap()), 0, keys), vals}, build)))

def run_kernel(k: Nat, +it: U32, r: Hj & U32) -> Hj & U32:
  match k:
    case 0n:
      r
    case 1n+p:
      run_kernel(p, (it + 1 : U32), pass(it, r))

def kernel(r: Hj & U32) -> Hj & U32:
  (j, h) = r
  run_kernel(24n, 0, (j, 2166136261))

def checksum(r: Hj & U32) -> U32:
  (j, h) = r
  h

def run(r: Array<U32> & Array<U32>) -> IO(Unit):
  (build, probes) = r
  s = B.warm(~Hj & U32, ~(r => r), ~kernel, 5n,
    (Hj{[0 : U32*16384n], [0 : U32*16384n], build, probes}, 0))
  do IO<Unit>:
    r : (Hj & U32) & List<&2, U32> <- B.timed(~Hj & U32, ~(r => r), ~kernel, 21n, s, [])
    B.finish(~Hj & U32, ~checksum, (nprobe() * 24 : U32), 2, 21, r)

def main() -> IO(Unit):
  build = fill(U32.to_nat(nbuild()), 0, 305441741, [0 : U32*8192n])
  probes = fill(U32.to_nat(nprobe()), 0, 2654435769, [0 : U32*65536n])
  run(real(32768n, 0, (build, probes)))
