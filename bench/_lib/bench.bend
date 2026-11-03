import Base
# Shared timing, checksum and output for the .bend bench kernels: the Bend
# sibling of bench.h, bench.zig, bench.goose and bench.tov. A case imports it
# as a module (`import ../_lib/bench.bend as B`) and prints the one
# `median_us=… checksum=… samples=… stages=… runs=…` line bench.mjs parses.
#
# U32 arithmetic wraps, so the FNV step is the plain U32 multiply of
# benchlib.js's Math.imul. A byte or an i32 lives in a U32 word, an
# Array<U32> slot.

# Microseconds on the monotonic clock, wrapping at 2^32: a sample is the U32
# difference of two reads. Base's IO.now counts whole milliseconds, too coarse
# for one sample, so the clock is an effect of this module's own.
def now_us() -> IO(U32):
  import "./bend-clock.c"
  import "./bend-clock.js"

def mix(h: U32, x: U32) -> U32:
  ((h .^. x) * 16777619 : U32)

# FNV-style hash over every stride-th word of a[0..n) (benchlib.js
# checksumU32 at stride 128, checksumU8 at stride 1); n counts the steps. A
# read hands the array back beside its word, so the hash rides with the array
# and each read's pair goes to the next stage as a parameter.
def checksum.mix(h: U32, r: Array<U32> & U32) -> Array<U32> & U32:
  (a, x) = r
  (a, mix(h, x))

def checksum.read(+i: U32, s: Array<U32> & U32) -> Array<U32> & U32:
  (a, h) = s
  checksum.mix(h, a[i])

def checksum.go(n: Nat, +stride: U32, +i: U32, s: Array<U32> & U32) ->
  Array<U32> & U32:
  match n:
    case 0n:
      s
    case 1n+p:
      checksum.go(p, stride, (i + stride : U32), checksum.read(i, s))

# checksumU8 of a buffer still in use: the buffer back beside its hash
def hash_u8(n: Nat, a: Array<U32>) -> Array<U32> & U32:
  checksum.go(n, 1, 0, (a, 2166136261))

def checksum_u8(n: Nat, a: Array<U32>) -> U32:
  Pair.snd(Array<U32>, U32, hash_u8(n, a))

# n words hash their ceil(n / 128) sampled ones
def checksum_u32(n: Nat, a: Array<U32>) -> U32:
  +k = Nat.div(Nat.add(n, 127n), 128n)
  Pair.snd(Array<U32>, U32, checksum.go(k, 128, 0, (a, 2166136261)))

# Middle sample, the samples already whole microseconds (benchlib.js medianUs).
def median.at(xs: List<&2, U32>, k: Nat) -> U32:
  match xs k:
    case Nil{} _:
      0
    case h <> t 0n:
      h
    case h <> t 1n+p:
      median.at(t, p)

def median(xs: List<&2, U32>) -> U32:
  +ys = List.sort(~U32, ~(a => b => U32.is_le(a, b)), xs)
  median.at(ys, Nat.div(Nat.sub(List.length(&2, U32, ys), 1n), 2n))

# The run protocol of every case: warm-up runs, then timed runs, each a
# kernel k over the case's state s after prep readies it outside the clock
# (the identity for a kernel that needs none). The timed runs answer the
# state and the samples, newest first.
def warm(~S: Type, ~prep: S -> S, ~k: S -> S, n: Nat, s: S) -> S:
  match n:
    case 0n:
      s
    case 1n+p:
      warm(~S, ~prep, ~k, p, k(prep(s)))

def timed(~S: Type, ~prep: S -> S, ~k: S -> S, n: Nat, s: S,
          acc: List<&2, U32>) -> IO(S & List<&2, U32>):
  match n:
    case 0n:
      IO.pure(S & List<&2, U32>, (s, acc))
    case 1n+p:
      do IO<S & List<&2, U32>>:
        r : S = prep(s)
        t0 : U32 <- now_us()
        q : S = k(r)
        t1 : U32 <- now_us()
        out : S & List<&2, U32> <- timed(~S, ~prep, ~k, p, q, (t1 - t0 : U32) <> acc)
        return out

def print_result(median: U32, checksum: U32, samples: U32, stages: U32,
                 runs: U32) -> IO(Unit):
  IO.print("median_us=" ++ U32.show(median) ++ " checksum=" ++
    U32.show(checksum) ++ " samples=" ++ U32.show(samples) ++ " stages=" ++
    U32.show(stages) ++ " runs=" ++ U32.show(runs))

# The report of a case's timed runs: the median sample and the checksum sum
# reads from the final state.
def finish(~S: Type, ~sum: S -> U32, samples: U32, stages: U32, runs: U32,
           r: S & List<&2, U32>) -> IO(Unit):
  (s, xs) = r
  print_result(median(xs), sum(s), samples, stages, runs)
