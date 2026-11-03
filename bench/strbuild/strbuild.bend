import Base
import ../_lib/bench.bend as B
# strbuild.bend: Bend port of strbuild.js (same rows, passes and checksum):
# each row formatted as a fresh String, `i,name,value\n`, by `++` and
# U32.show, then every char code mixed into the hash. Bend has no signed
# integer: the value column is an int32 in a U32, shifted arithmetically
# (s >> 4 keeps the sign bit) and shown with its minus sign.

type Rows is Type:
  Rows{names: Array<String>, code: Array<U32>, vals: Array<U32>}

def n() -> U32:
  4096

def names() -> List<&2, String>:
  ["alpha", "bravo", "carol", "delta", "echo", "fox", "golf", "hotel",
   "india", "jazz", "kilo", "lima", "mike", "nova", "oscar", "papa"]

def table(xs: List<&2, String>, +i: U32, a: Array<String>) -> Array<String>:
  match xs:
    case Nil{}:
      a
    case x <> t:
      table(t, (i + 1 : U32), Array.set(String, a, i, x))

# s >> 4 on an int32: the sign bit fills the top 4 bits
def sar4(+s: U32) -> U32:
  Bool.pick(U32, (s >= 2147483648 : U32), (s >> 4n .|. 4026531840 : U32), (s >> 4n : U32))

# Deterministic rows: XorShift32; low bits pick the name, the rest is the value.
def fill(k: Nat, +i: U32, +s: U32, r: Array<U32> & Array<U32>) -> Array<U32> & Array<U32>:
  match k:
    case 0n:
      r
    case 1n+p:
      (code, vals) = r
      +s1 = (s .^. (s << 13n) : U32)
      +s2 = (s1 .^. (s1 >> 17n) : U32)
      +s3 = (s2 .^. (s2 << 5n) : U32)
      fill(p, (i + 1 : U32), s3, (code[i] <- (s3 .&. 15 : U32), vals[i] <- sar4(s3)))

def show.sign(neg: Bool, +v: U32) -> String:
  match neg:
    case True{}:
      "-" ++ U32.show((0 - v : U32))
    case False{}:
      U32.show(v)

def show(+v: U32) -> String:
  show.sign((v >= 2147483648 : U32), v)

def mix.chars(s: String, h: U32) -> U32:
  match s:
    case SNil{}:
      h
    case SCon{Chr{c}, t}:
      mix.chars(t, B.mix(h, c))

# line = i + ',' + NAMES[code[i]] + ',' + ((vals[i] + it) | 0) + '\n'
def row.f3(+i: U32, it: U32, name: String, h: U32, names: Array<String>,
           code: Array<U32>, r: Array<U32> & U32) -> Rows & U32:
  (vals, v) = r
  (Rows{names, code, vals},
    mix.chars(U32.show(i) ++ "," ++ name ++ "," ++ show((v + it : U32)) ++ "\n", h))

def row.f2(+i: U32, it: U32, h: U32, code: Array<U32>, vals: Array<U32>,
           r: Array<String> & String) -> Rows & U32:
  (names, name) = r
  row.f3(i, it, name, h, names, code, vals[i])

def row.f1(+i: U32, +it: U32, h: U32, names: Array<String>, vals: Array<U32>,
           r: Array<U32> & U32) -> Rows & U32:
  (code, k) = r
  row.f2(i, it, h, code, vals, Array.get(String, names, k))

def row(+it: U32, +i: U32, r: Rows & U32) -> Rows & U32:
  (rows, h) = r
  Rows{names, code, vals} = rows
  row.f1(i, it, h, names, vals, code[i])

def rows(k: Nat, +it: U32, +i: U32, r: Rows & U32) -> Rows & U32:
  match k:
    case 0n:
      r
    case 1n+p:
      rows(p, it, (i + 1 : U32), row(it, i, r))

def passes(k: Nat, +it: U32, r: Rows & U32) -> Rows & U32:
  match k:
    case 0n:
      r
    case 1n+p:
      passes(p, (it + 1 : U32), rows(U32.to_nat(n()), it, 0, r))

def kernel(r: Rows & U32) -> Rows & U32:
  (rows, h) = r
  passes(4n, 0, (rows, 2166136261))

def checksum(r: Rows & U32) -> U32:
  (rows, h) = r
  h

def run(names: Array<String>, r: Array<U32> & Array<U32>) -> IO(Unit):
  (code, vals) = r
  s = B.warm(~Rows & U32, ~(r => r), ~kernel, 5n, (Rows{names, code, vals}, 0))
  do IO<Unit>:
    r : (Rows & U32) & List<&2, U32> <- B.timed(~Rows & U32, ~(r => r), ~kernel, 21n, s, [])
    B.finish(~Rows & U32, ~checksum, (n() * 4 : U32), 3, 21, r)

def main() -> IO(Unit):
  run(table(names(), 0, [SNil{} : String*16n]),
    fill(U32.to_nat(n()), 0, 305441741, ([0 : U32*4096n], [0 : U32*4096n])))
