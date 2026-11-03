import Base
import ../_lib/bench.bend as B
# json.bend: Bend port of json.js (same source, passes and checksum): the
# JSON text parsed every pass into a generic value tree, then walked by key,
# as JSON.parse and property reads do. The text is a String, read char by
# char; an object is Base's string-keyed Map, an array a List. Bend allows no
# mutual recursion, so the parser is one def taking the mode it is in (a
# value of each kind, the next array element or object member, a closed
# array or object), and its helpers answer the next mode beside the rest of
# the text. Bend checks that recursion ends: the parser and each scan
# (whitespace, a string's chars, a number's digits) carry a Nat fuel, the
# text's length, which bounds the parser's depth (each level reads a char)
# and every scan's trip count. Bend has no f64, so a number is an int32 in a
# U32, read digit by digit: every number in the text is an integer.

type Json is Data:
  JNull{}
  JBool{v: Bool}
  JNum{n: U32}
  JStr{s: String}
  JArr{xs: List<&2, Json>}
  JObj{m: Map<&2, Json>}

# what the parser reads next; a number's mode holds its first char, which
# its kind test read
type Mode is Type:
  MStr{}
  MNum{c: U32}
  MNull{}
  MTrue{}
  MFalse{}
  MArr{}
  MElem{acc: List<&2, Json>}
  MArrEnd{acc: List<&2, Json>}
  MObj{}
  MMember{m: Map<&2, Json>, key: String}
  MObjEnd{m: Map<&2, Json>}

# the text and its length, the parser's fuel
type Doc is Data:
  Doc{src: String, len: Nat}

def src() -> String:
  "{\"items\":[{\"id\":1,\"kind\":2,\"value\":10},{\"id\":2,\"kind\":3,\"value\":20},{\"id\":3,\"kind\":5,\"value\":30}],\"meta\":{\"scale\":7,\"bias\":11}}"

def is_ws(+c: U32) -> Bool:
  U32.is_eq(c, 32) || U32.is_eq(c, 9) || U32.is_eq(c, 10) || U32.is_eq(c, 13)

# Each scan of the text (whitespace, a string's chars, a number's digits)
# is a loop whose step answers the rest of the text beside its test's Bool;
# its fuel is the text's length, more than the chars it can take.

# skip whitespace: ' ', '\t', '\n', '\r'
def ws.if(sp: Bool, c: U32, t: String) -> String & Bool:
  match sp:
    case True{}:
      (t, True{})
    case False{}:
      (SCon{Chr{c}, t}, False{})

def ws.step(s: String) -> String & Bool:
  match s:
    case SNil{}:
      (SNil{}, False{})
    case SCon{Chr{+c}, t}:
      ws.if(is_ws(c), c, t)

def ws.go(f: Nat, r: String & Bool) -> String:
  match f:
    case 0n:
      (s, go) = r
      s
    case 1n+p:
      (s, go) = r
      match go:
        case False{}:
          s
        case True{}:
          ws.go(p, ws.step(s))

def ws(len: Nat, s: String) -> String:
  ws.go(len, (s, True{}))

# a string's chars after its opening quote, up to the closing one, beside
# the rest of the text; a backslash keeps the char after it as it is. The
# chars gather in reverse, then String.reverse puts them in order.
type Scan is Type:
  Scan{s: String, acc: String}

def str.esc(acc: String, t: String) -> Scan & Bool:
  match t:
    case SNil{}:
      (Scan{SNil{}, acc}, False{})
    case SCon{h, u}:
      (Scan{u, SCon{h, acc}}, True{})

def str.if(q: Bool, bs: Bool, c: U32, t: String, acc: String) -> Scan & Bool:
  match q bs:
    case True{} _:
      (Scan{t, acc}, False{})
    case False{} True{}:
      str.esc(acc, t)
    case False{} False{}:
      (Scan{t, SCon{Chr{c}, acc}}, True{})

def str.step(x: Scan) -> Scan & Bool:
  Scan{s, acc} = x
  match s:
    case SNil{}:
      (Scan{SNil{}, acc}, False{})
    case SCon{Chr{+c}, t}:
      str.if(U32.is_eq(c, 34), U32.is_eq(c, 92), c, t, acc)

def str.go(f: Nat, r: Scan & Bool) -> Scan:
  match f:
    case 0n:
      (x, go) = r
      x
    case 1n+p:
      (x, go) = r
      match go:
        case False{}:
          x
        case True{}:
          str.go(p, str.step(x))

def str.fin(x: Scan) -> String & String:
  Scan{rest, acc} = x
  (String.reverse(acc), rest)

def str(len: Nat, s: String) -> String & String:
  str.fin(str.go(len, (Scan{s, SNil{}}, True{})))

def str.val(r: String & String) -> Json & String:
  (cs, rest) = r
  (JStr{cs}, rest)

# n = n * 10 + digit, while the char is a digit
def num.if(d: Bool, c: U32, t: String, n: U32) -> (String & U32) & Bool:
  match d:
    case True{}:
      ((t, (n * 10 + (c - 48) : U32)), True{})
    case False{}:
      ((SCon{Chr{c}, t}, n), False{})

def num.step(r: String & U32) -> (String & U32) & Bool:
  (s, n) = r
  match s:
    case SNil{}:
      ((SNil{}, n), False{})
    case SCon{Chr{+c}, t}:
      num.if((c >= 48 : U32) && (c <= 57 : U32), c, t, n)

def num.go(f: Nat, r: (String & U32) & Bool) -> String & U32:
  match f:
    case 0n:
      (x, go) = r
      x
    case 1n+p:
      (x, go) = r
      match go:
        case False{}:
          x
        case True{}:
          num.go(p, num.step(x))

def num.pos(r: String & U32) -> Json & String:
  (s, n) = r
  (JNum{n}, s)

def num.neg(r: String & U32) -> Json & String:
  (s, n) = r
  (JNum{(0 - n : U32)}, s)

# a leading '-' negates the digits after it
def num.sign(neg: Bool, +len: Nat, c: U32, t: String) -> Json & String:
  match neg:
    case True{}:
      num.neg(num.go(len, ((t, 0), True{})))
    case False{}:
      num.pos(num.go(len, ((t, (c - 48 : U32)), True{})))

# a value's kind by its first char: '"', '{', '[', 'n', 't', 'f', else a number
def kind.f(f: Bool, c: U32, t: String) -> Mode & String:
  match f:
    case True{}:
      (MFalse{}, t)
    case False{}:
      (MNum{c}, t)

def kind.t(tr: Bool, +c: U32, t: String) -> Mode & String:
  match tr:
    case True{}:
      (MTrue{}, t)
    case False{}:
      kind.f(U32.is_eq(c, 102), c, t)

def kind.n(nl: Bool, +c: U32, t: String) -> Mode & String:
  match nl:
    case True{}:
      (MNull{}, t)
    case False{}:
      kind.t(U32.is_eq(c, 116), c, t)

def kind.a(ar: Bool, +c: U32, t: String) -> Mode & String:
  match ar:
    case True{}:
      (MArr{}, t)
    case False{}:
      kind.n(U32.is_eq(c, 110), c, t)

def kind.o(ob: Bool, +c: U32, t: String) -> Mode & String:
  match ob:
    case True{}:
      (MObj{}, t)
    case False{}:
      kind.a(U32.is_eq(c, 91), c, t)

def kind.s(st: Bool, +c: U32, t: String) -> Mode & String:
  match st:
    case True{}:
      (MStr{}, t)
    case False{}:
      kind.o(U32.is_eq(c, 123), c, t)

# the value at s, its whitespace skipped
def classify(s: String) -> Mode & String:
  match s:
    case SNil{}:
      (MNull{}, SNil{})
    case SCon{Chr{+c}, t}:
      kind.s(U32.is_eq(c, 34), c, t)

# after '[': an empty array closes at once
def arr.open.c(close: Bool, c: Char, t: String) -> Mode & String:
  match close:
    case True{}:
      (MArrEnd{Nil{}}, t)
    case False{}:
      (MElem{Nil{}}, SCon{c, t})

def arr.open(s: String) -> Mode & String:
  match s:
    case SNil{}:
      (MArrEnd{Nil{}}, SNil{})
    case SCon{Chr{+c}, t}:
      arr.open.c(U32.is_eq(c, 93), Chr{c}, t)

# after an element: ']' closes the array, else ',' and the next element
def arr.next.c(close: Bool, len: Nat, acc: List<&2, Json>, t: String) -> Mode & String:
  match close:
    case True{}:
      (MArrEnd{acc}, t)
    case False{}:
      (MElem{acc}, ws(len, t))

def arr.next.at(+len: Nat, acc: List<&2, Json>, s: String) -> Mode & String:
  match s:
    case SNil{}:
      (MArrEnd{acc}, SNil{})
    case SCon{Chr{+c}, t}:
      arr.next.c(U32.is_eq(c, 93), len, acc, t)

def arr.next(+len: Nat, acc: List<&2, Json>, r: Json & String) -> Mode & String:
  (v, s) = r
  arr.next.at(len, v <> acc, ws(len, s))

# a member's key: the quoted string, then ':' and its whitespace
def obj.key.str(+len: Nat, m: Map<&2, Json>, r: String & String) -> Mode & String:
  (key, s) = r
  (MMember{m, key}, ws(len, String.drop(ws(len, s), 1n)))

def obj.key(+len: Nat, m: Map<&2, Json>, s: String) -> Mode & String:
  obj.key.str(len, m, str(len, String.drop(ws(len, s), 1n)))

# after '{': an empty object closes at once
def obj.open.c(close: Bool, len: Nat, c: Char, t: String) -> Mode & String:
  match close:
    case True{}:
      (MObjEnd{Map.new(&2, Json)}, t)
    case False{}:
      obj.key(len, Map.new(&2, Json), SCon{c, t})

def obj.open(len: Nat, s: String) -> Mode & String:
  match s:
    case SNil{}:
      (MObjEnd{Map.new(&2, Json)}, SNil{})
    case SCon{Chr{+c}, t}:
      obj.open.c(U32.is_eq(c, 125), len, Chr{c}, t)

# after a member's value: '}' closes the object, else ',' and the next member
def obj.next.c(close: Bool, +len: Nat, m: Map<&2, Json>, t: String) -> Mode & String:
  match close:
    case True{}:
      (MObjEnd{m}, t)
    case False{}:
      obj.key(len, m, ws(len, t))

def obj.next.at(+len: Nat, m: Map<&2, Json>, s: String) -> Mode & String:
  match s:
    case SNil{}:
      (MObjEnd{m}, SNil{})
    case SCon{Chr{+c}, t}:
      obj.next.c(U32.is_eq(c, 125), len, m, t)

def obj.next(+len: Nat, m: Map<&2, Json>, key: String, r: Json & String) -> Mode & String:
  (v, s) = r
  obj.next.at(len, Map.set(&2, Json, m, key, v), ws(len, s))

# the value in mode k, then the rest of the text; len is the scans' fuel
def parse(+f: Nat, +len: Nat, r: Mode & String) -> Json & String:
  match f:
    case 0n:
      (k, s) = r
      (JNull{}, s)
    case 1n+p:
      (k, s) = r
      match k:
        case MStr{}:
          str.val(str(len, s))
        case MNum{+c}:
          num.sign(U32.is_eq(c, 45), len, c, s)
        case MNull{}:
          (JNull{}, String.drop(s, 3n))
        case MTrue{}:
          (JBool{True{}}, String.drop(s, 3n))
        case MFalse{}:
          (JBool{False{}}, String.drop(s, 4n))
        case MArr{}:
          parse(p, len, arr.open(ws(len, s)))
        case MElem{acc}:
          parse(p, len, arr.next(len, acc, parse(p, len, classify(ws(len, s)))))
        case MArrEnd{acc}:
          (JArr{List.reverse(&2, Json, acc)}, s)
        case MObj{}:
          parse(p, len, obj.open(len, ws(len, s)))
        case MMember{m, key}:
          parse(p, len, obj.next(len, m, key, parse(p, len, classify(ws(len, s)))))
        case MObjEnd{m}:
          (JObj{m}, s)

# o[key], undefined (null) when o is no object or lacks the key
def get.val(r: Map<&2, Json> & Json) -> Json:
  (m, v) = r
  v

def get(o: Json, key: String) -> Json:
  match o:
    case JObj{m}:
      get.val(Map.get(Json, JNull{}, m, key))
    case x:
      JNull{}

def num_i32(v: Json) -> U32:
  match v:
    case JNum{n}:
      n
    case x:
      0

# s += it.id * o.meta.scale + it.kind + it.value
def item(+it: Json, +o: Json, s: U32) -> U32:
  (s + (num_i32(get(it, "id")) * num_i32(get(get(o, "meta"), "scale")))
    + num_i32(get(it, "kind")) + num_i32(get(it, "value")) : U32)

def walk.items(xs: List<&2, Json>, +o: Json, s: U32) -> U32:
  match xs:
    case Nil{}:
      s
    case it <> t:
      walk.items(t, o, item(it, o, s))

def walk.list(items: Json, +o: Json, s: U32) -> U32:
  match items:
    case JArr{xs}:
      walk.items(xs, o, s)
    case x:
      s

# s = o.meta.bias, then every item of o.items
def walk.root(+o: Json) -> U32:
  walk.list(get(o, "items"), o, num_i32(get(get(o, "meta"), "bias")))

def walk(r: Json & String) -> U32:
  (o, rest) = r
  walk.root(o)

# h = mix(h, s) for each JSON.parse(SRC) and its walk
def passes(k: Nat, +src: String, +len: Nat, h: U32) -> U32:
  match k:
    case 0n:
      h
    case 1n+p:
      passes(p, src, len, B.mix(h, walk(parse(len, len, classify(ws(len, src))))))

def kernel(r: Doc & U32) -> Doc & U32:
  (d, h) = r
  Doc{+src, +len} = d
  (Doc{src, len}, passes(512n, src, len, 2166136261))

def checksum(r: Doc & U32) -> U32:
  (d, h) = r
  h

def main() -> IO(Unit):
  +text = src()
  s = B.warm(~Doc & U32, ~(r => r), ~kernel, 5n, (Doc{text, String.length(text)}, 0))
  do IO<Unit>:
    r : (Doc & U32) & List<&2, U32> <- B.timed(~Doc & U32, ~(r => r), ~kernel, 21n, s, [])
    B.finish(~Doc & U32, ~checksum, 512, 4, 21, r)
