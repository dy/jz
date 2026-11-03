import Base
import ../_lib/bench.bend as B
# arraydowngrade.bend: Bend port of arraydowngrade.js (Perry's
# bench_numeric_array_downgrade.ts, https://github.com/PerryTS/perry,
# benchmarks/suite, MIT; same values, passes and checksum): a quarter million
# integers stored one by one, an object and a string stored in the middle,
# then 25 passes that add 1 to every numeric slot on both sides of them.
#
# A JS value of several kinds is a datatype of three constructors (a number,
# the object `{ value: 7 }` as a record, a String) and the array an
# Array<Value>, read with Array.get and written with Array.set. A Bend array
# has a fixed power-of-two slot count and no push, so each run makes one of
# 2^18 slots and stores the 250,000 values in order, where the JS pushes them;
# the integers stay below 2^23, so U32 holds every value and sum the JS's
# doubles hold. `arr[i] = arr[i] + 1` is JS's `+` on a slot of any kind: a
# number adds, a string concatenates, an object concatenates its string form,
# so add_one matches every slot it updates; the passes never reach the string
# or the object. U32 has no NaN, so a sum's arm for a slot that holds no
# number, which the passes never read either, adds 0 where the JS would add
# NaN. The state is the hash of the timed runs' results and the count of runs
# made, the warm-up runs mixing nothing.

type Value is Data:
  Num{v: U32}
  Obj{value: U32}
  Str{s: String}

def size() -> U32:
  250000

def object_index() -> U32:
  125000

def string_index() -> U32:
  125001

# v + 1, JS's `+`
def add_one(v: Value) -> Value:
  match v:
    case Num{x}:
      Num{(x + 1 : U32)}
    case Obj{x}:
      Str{"[object Object]1"}
    case Str{s}:
      Str{s ++ "1"}

def num(v: Value) -> U32:
  match v:
    case Num{x}:
      x
    case Obj{x}:
      0
    case Str{s}:
      0

def field_value(v: Value) -> U32:
  match v:
    case Num{x}:
      0
    case Obj{x}:
      x
    case Str{s}:
      0

def is_empty(v: Value) -> Bool:
  match v:
    case Str{SNil{}}:
      True{}
    case _:
      False{}

# a[i] = Num{i} for the n slots from i
def fill(n: Nat, +i: U32, a: Array<Value>) -> Array<Value>:
  match n:
    case 0n:
      a
    case 1n+p:
      fill(p, (i + 1 : U32), Array.set(Value, a, i, Num{i}))

def build() -> Array<Value>:
  a = fill(U32.to_nat(size()), 0, [Num{0} : Value*262144n])
  b = Array.set(Value, a, object_index(), Obj{7})
  Array.set(Value, b, string_index(), Str{"numeric-array-downgrade-payload"})

# arr[i] = arr[i] + 1 for the n slots from i
def inc.set(+i: U32, r: Array<Value> & Value) -> Array<Value>:
  (a, v) = r
  Array.set(Value, a, i, add_one(v))

def inc(n: Nat, +i: U32, a: Array<Value>) -> Array<Value>:
  match n:
    case 0n:
      a
    case 1n+p:
      inc(p, (i + 1 : U32), inc.set(i, Array.get(Value, a, i)))

def add.num(cs: U32, r: Array<Value> & Value) -> Array<Value> & U32:
  (a, v) = r
  (a, (cs + num(v) : U32))

def add.field(cs: U32, r: Array<Value> & Value) -> Array<Value> & U32:
  (a, v) = r
  (a, (cs + field_value(v) : U32))

def add.three(+cs: U32, r: Array<Value> & Value) -> Array<Value> & U32:
  (a, v) = r
  (a, Bool.pick(U32, is_empty(v), cs, (cs + 3 : U32)))

# checksum + arr[0] + arr[arr.length - 1] + arr[OBJECT_INDEX].value, and 3
# more unless arr[STRING_INDEX] is ''
def tally.three(r: Array<Value> & U32) -> Array<Value> & U32:
  (a, cs) = r
  add.three(cs, Array.get(Value, a, string_index()))

def tally.field(r: Array<Value> & U32) -> Array<Value> & U32:
  (a, cs) = r
  tally.three(add.field(cs, Array.get(Value, a, object_index())))

def tally.last(r: Array<Value> & U32) -> Array<Value> & U32:
  (a, cs) = r
  tally.field(add.num(cs, Array.get(Value, a, (size() - 1 : U32))))

def tally(cs: U32, a: Array<Value>) -> Array<Value> & U32:
  tally.last(add.num(cs, Array.get(Value, a, 0)))

def pass(r: Array<Value> & U32) -> Array<Value> & U32:
  (a, cs) = r
  +rest = (size() - string_index() - 1 : U32)
  tally(cs, inc(U32.to_nat(rest), (string_index() + 1 : U32), inc(U32.to_nat(object_index()), 0, a)))

def passes(n: Nat, r: Array<Value> & U32) -> Array<Value> & U32:
  match n:
    case 0n:
      r
    case 1n+p:
      passes(p, pass(r))

def total(r: Array<Value> & U32) -> Array<Value> & U32:
  (a, cs) = r
  (a, (cs + size() : U32))

# the JS's mutateDowngradedArray: the array back beside checksum + arr.length
def mutate(a: Array<Value>) -> Array<Value> & U32:
  total(passes(25n, (a, 0)))

def run() -> U32:
  Pair.snd(Array<Value>, U32, mutate(build()))

# one run: its result mixed into h once the 3 warm-up runs are made
def kernel(s: U32 & U32) -> U32 & U32:
  (+h, +k) = s
  +cs = run()
  (Bool.pick(U32, (k >= 3 : U32), B.mix(h, cs), h), (k + 1 : U32))

# a slot as the JS folds it: a number as itself, the object by its field, the
# string by its length (in code points, as many as UTF-16 units here)
def slot(v: Value) -> U32:
  match v:
    case Num{x}:
      x
    case Obj{x}:
      x
    case Str{s}:
      U32.from_nat(String.length(s))

def fold.mix(h: U32, r: Array<Value> & Value) -> Array<Value> & U32:
  (a, v) = r
  (a, B.mix(h, slot(v)))

def fold.read(+i: U32, r: Array<Value> & U32) -> Array<Value> & U32:
  (a, h) = r
  fold.mix(h, Array.get(Value, a, i))

def fold.go(n: Nat, +i: U32, r: Array<Value> & U32) -> Array<Value> & U32:
  match n:
    case 0n:
      r
    case 1n+p:
      fold.go(p, (i + 1 : U32), fold.read(i, r))

# one more run's result, then every slot of its array
def fold(h: U32, r: Array<Value> & U32) -> U32:
  (a, cs) = r
  Pair.snd(Array<Value>, U32, fold.go(U32.to_nat(size()), 0, (a, B.mix(h, cs))))

def checksum(s: U32 & U32) -> U32:
  (h, k) = s
  fold(h, mutate(build()))

def main() -> IO(Unit):
  s = B.warm(~U32 & U32, ~(s => s), ~kernel, 3n, (2166136261, 0))
  do IO<Unit>:
    r : (U32 & U32) & List<&2, U32> <- B.timed(~U32 & U32, ~(s => s), ~kernel, 21n, s, [])
    B.finish(~U32 & U32, ~checksum, size(), 2, 21, r)
