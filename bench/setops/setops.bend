import Base
import ../_lib/bench.bend as B
# setops.bend: Bend port of setops.js (same corpus, windows and checksum):
# near-duplicate detection over tokenized documents with Base's Set of
# Strings. Each document becomes a Set of its words minus a stop-word Set
# (has, add), every word joins a vocabulary union, and each document meets
# the eight after it: the smaller Set's words probe the larger one, the
# union by inclusion-exclusion, Jaccard in thousandths, and a pair at 600 or
# more pays for a set difference both ways (a copy, then del of the other's
# words). A loop over a Set's words walks Set.to_list. Bend's values are
# immutable, so a copy of a Set is the same value used twice (a reference
# count), and a del on it rebuilds only the path it changes. Base's
# Set.size walks the whole Set, so a pair reads each Set's size once where
# the JS reads the property twice. Documents are Lists of Strings, the Sets
# an Array<Set()>; a window's bound j < NDOCS is a test beside its count of 8.

# the corpus: the documents and the stop words, read by every run
type Corpus is Data:
  Corpus{docs: List<&2, List<&2, String>>, stop: List<&2, String>}

# vocab.size, score, dupes and diff
type Res is Data:
  Res{vocab: U32, score: U32, dupes: U32, diff: U32}

type Acc is Data:
  Acc{score: U32, dupes: U32, diff: U32}

# the sets' build: the stop Set, the vocabulary and the document Sets
type Bs is Type:
  Bs{stop: Set(), vocab: Set(), sets: Array<Set()>}

# the corpus build: the words, the seed and a document's tokens, reversed
type Bd is Type:
  Bd{words: Array<String>, s: U32, acc: List<&2, String>}

type Dd is Type:
  Dd{words: Array<String>, s: U32, docs: List<&2, List<&2, String>>, prev: List<&2, String>}

def ndocs() -> U32:
  256

# seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
def next(+s: U32) -> U32:
  +s1 = (s .^. (s << 13n) : U32)
  +s2 = (s1 .^. (s1 >> 17n) : U32)
  (s2 .^. (s2 << 5n) : U32)

# len chars 97 + next() % 26, then the tail (the word's index)
def spell.con(c: U32, r: String & U32) -> String & U32:
  (w, s) = r
  (SCon{Chr{c}, w}, s)

def spell(k: Nat, +s: U32, tail: String) -> String & U32:
  match k:
    case 0n:
      (tail, s)
    case 1n+p:
      +s1 = next(s)
      spell.con((97 + U32.mod(s1, 26) : U32), spell(p, s1, tail))

def word.put(+i: U32, a: Array<String>, r: String & U32) -> Array<String> & U32:
  (w, s) = r
  (Array.set(String, a, i, w), s)

# words[i] = 3 + next() % 7 letters, then i
def word.step(+i: U32, r: Array<String> & U32) -> Array<String> & U32:
  (a, s) = r
  +s1 = next(s)
  word.put(i, a, spell(U32.to_nat((3 + U32.mod(s1, 7) : U32)), s1, U32.show(i)))

def words(k: Nat, +i: U32, r: Array<String> & U32) -> Array<String> & U32:
  match k:
    case 0n:
      r
    case 1n+p:
      words(p, (i + 1 : U32), word.step(i, r))

# the minimum of two uniform draws: the seed beside the word index
def pick(+s: U32) -> U32 & U32:
  +s1 = next(s)
  +s2 = next(s1)
  +a = U32.mod(s1, 1024)
  +b = U32.mod(s2, 1024)
  (s2, Bool.pick(U32, (a < b : U32), a, b))

def take.word(s: U32, acc: List<&2, String>, x: Array<String> & String) -> Bd:
  (words, w) = x
  Bd{words, s, w <> acc}

def take.pick(words: Array<String>, acc: List<&2, String>, r: U32 & U32) -> Bd:
  (s, i) = r
  take.word(s, acc, Array.get(String, words, i))

# an edited copy: next() % 10 === 0 ? words[pick()] : prev[k]
def edit.if(re: Bool, t: String, words: Array<String>, +s: U32, acc: List<&2, String>) -> Bd:
  match re:
    case True{}:
      take.pick(words, acc, pick(s))
    case False{}:
      Bd{words, s, t <> acc}

def edit.step(t: String, b: Bd) -> Bd:
  Bd{words, s, acc} = b
  +s1 = next(s)
  edit.if(U32.is_eq(U32.mod(s1, 10), 0), t, words, s1, acc)

def edit(prev: List<&2, String>, b: Bd) -> Bd:
  match prev:
    case Nil{}:
      b
    case t <> rest:
      edit(rest, edit.step(t, b))

def fresh.step(b: Bd) -> Bd:
  Bd{words, s, acc} = b
  take.pick(words, acc, pick(s))

def fresh(k: Nat, b: Bd) -> Bd:
  match k:
    case 0n:
      b
    case 1n+p:
      fresh(p, fresh.step(b))

# every eighth document is an edited copy of the one before; the rest are
# 24 + next() % 73 picked words
def doc.new(ed: Bool, prev: List<&2, String>, b: Bd) -> Bd:
  match ed:
    case True{}:
      edit(prev, b)
    case False{}:
      Bd{words, s, acc} = b
      +s1 = next(s)
      fresh(U32.to_nat((24 + U32.mod(s1, 73) : U32)), Bd{words, s1, acc})

def docs.fin(docs: List<&2, List<&2, String>>, b: Bd) -> Dd:
  Bd{words, s, acc} = b
  +doc = List.reverse(&2, String, acc)
  Dd{words, s, doc <> docs, doc}

def docs.step(+d: U32, x: Dd) -> Dd:
  Dd{words, s, docs, prev} = x
  docs.fin(docs, doc.new(U32.is_eq(U32.mod(d, 8), 7), prev, Bd{words, s, Nil{}}))

def docs(k: Nat, +d: U32, x: Dd) -> Dd:
  match k:
    case 0n:
      x
    case 1n+p:
      docs(p, (d + 1 : U32), docs.step(d, x))

# words.slice(0, NSTOP)
def stops.put(acc: List<&2, String>, x: Array<String> & String) -> Array<String> & List<&2, String>:
  (words, w) = x
  (words, w <> acc)

def stops(k: Nat, +i: U32, r: Array<String> & List<&2, String>) -> Array<String> & List<&2, String>:
  match k:
    case 0n:
      r
    case 1n+p:
      (words, acc) = r
      stops(p, (i - 1 : U32), stops.put(acc, Array.get(String, words, i)))

def corpus.fin(x: Dd) -> Corpus:
  Dd{words, s, docs, prev} = x
  Corpus{List.reverse(&2, List<&2, String>, docs), Pair.snd(Array<String>, List<&2, String>,
    stops(32n, 31, (words, Nil{})))}

def corpus(r: Array<String> & U32) -> Corpus:
  (words, s) = r
  corpus.fin(docs(U32.to_nat(ndocs()), 0, Dd{words, s, Nil{}, Nil{}}))

# if (!stop.has(w)) s.add(w)
def doc.add(keep: Bool, t: String, s: Set()) -> Set():
  match keep:
    case True{}:
      Set.add(s, t)
    case False{}:
      s

def doc.keep(s: Set(), +t: String, r: Set() & Bool) -> Set() & Set():
  (stop, has) = r
  (stop, doc.add(Bool.not(has), t, s))

def doc.tok(+t: String, r: Set() & Set()) -> Set() & Set():
  (stop, s) = r
  doc.keep(s, t, Set.has(stop, t))

def doc.set(toks: List<&2, String>, r: Set() & Set()) -> Set() & Set():
  match toks:
    case Nil{}:
      r
    case t <> rest:
      doc.set(rest, doc.tok(t, r))

# for (const w of s) vocab.add(w)
def vocab.add(ws: List<&2, String>, v: Set()) -> Set():
  match ws:
    case Nil{}:
      v
    case w <> t:
      vocab.add(t, Set.add(v, w))

def sets.put(+d: U32, vocab: Set(), sets: Array<Set()>, r: Set() & Set()) -> Bs:
  (stop, +s) = r
  Bs{stop, vocab.add(Set.to_list(s), vocab), Array.set(Set(), sets, d, s)}

def sets.one(+d: U32, doc: List<&2, String>, r: Bs) -> Bs:
  Bs{stop, vocab, sets} = r
  sets.put(d, vocab, sets, doc.set(doc, (stop, Set.new())))

def sets.build(docs: List<&2, List<&2, String>>, +d: U32, r: Bs) -> Bs:
  match docs:
    case Nil{}:
      r
    case doc <> rest:
      sets.build(rest, (d + 1 : U32), sets.one(d, doc, r))

# for (const w of small) if (large.has(w)) inter++
def inter.add(n: U32, x: Set() & Bool) -> Set() & U32:
  (large, has) = x
  match has:
    case True{}:
      (large, (n + 1 : U32))
    case False{}:
      (large, n)

def inter.step(+w: String, r: Set() & U32) -> Set() & U32:
  (large, n) = r
  inter.add(n, Set.has(large, w))

def inter.go(ws: List<&2, String>, r: Set() & U32) -> Set() & U32:
  match ws:
    case Nil{}:
      r
    case w <> t:
      inter.go(t, inter.step(w, r))

# small = a.size < b.size ? a : b, large the other
def inter(lt: Bool, a: Set(), b: Set()) -> U32:
  match lt:
    case True{}:
      Pair.snd(Set(), U32, inter.go(Set.to_list(a), (b, 0)))
    case False{}:
      Pair.snd(Set(), U32, inter.go(Set.to_list(b), (a, 0)))

# onlyA = new Set(a); for (const w of b) onlyA.delete(w)
def minus(ws: List<&2, String>, s: Set()) -> Set():
  match ws:
    case Nil{}:
      s
    case w <> t:
      minus(t, Set.del(s, w))

# score += jac; a duplicate pays for the difference both ways
def pair.dupe(dup: Bool, +a: Set(), +b: Set(), +jac: U32, acc: Acc) -> Acc:
  match dup:
    case True{}:
      Acc{score, dupes, diff} = acc
      +only_a = minus(Set.to_list(b), a)
      +only_b = minus(Set.to_list(a), b)
      Acc{(score + jac : U32), (dupes + 1 : U32),
        (diff + U32.from_nat(Set.size(only_a)) + U32.from_nat(Set.size(only_b)) : U32)}
    case False{}:
      Acc{score, dupes, diff} = acc
      Acc{(score + jac : U32), dupes, diff}

# jac = union === 0 ? 0 : (inter * 1000 / union) | 0
def jac(zero: Bool, inter: U32, union: U32) -> U32:
  match zero:
    case True{}:
      0
    case False{}:
      U32.div((inter * 1000 : U32), union)

def pair(+a: Set(), +b: Set(), acc: Acc) -> Acc:
  +na = U32.from_nat(Set.size(a))
  +nb = U32.from_nat(Set.size(b))
  +i = inter((na < nb : U32), a, b)
  +u = (na + nb - i : U32)
  +j = jac(U32.is_eq(u, 0), i, u)
  pair.dupe((j >= 600 : U32), a, b, j, acc)

def win.f1(+j: U32, +a: Set(), acc: Acc, y: Array<Set()> & Set()) -> (Array<Set()> & Acc) & Bool:
  (sets, b) = y
  ((sets, pair(a, b, acc)), ((j + 1 : U32) < ndocs() : U32))

def win.step(+j: U32, +a: Set(), x: Array<Set()> & Acc) -> (Array<Set()> & Acc) & Bool:
  (sets, acc) = x
  win.f1(j, a, acc, Array.get(Set(), sets, j))

# for (j = i + 1; j <= i + WINDOW && j < NDOCS; j++)
def win(k: Nat, +j: U32, +a: Set(), r: (Array<Set()> & Acc) & Bool) -> Array<Set()> & Acc:
  match k:
    case 0n:
      (x, go) = r
      x
    case 1n+p:
      (x, go) = r
      match go:
        case False{}:
          x
        case True{}:
          win(p, (j + 1 : U32), a, win.step(j, a, x))

def pairs.f1(+i: U32, acc: Acc, y: Array<Set()> & Set()) -> Array<Set()> & Acc:
  (sets, a) = y
  +j = (i + 1 : U32)
  win(8n, j, a, ((sets, acc), (j < ndocs() : U32)))

def pairs.one(+i: U32, x: Array<Set()> & Acc) -> Array<Set()> & Acc:
  (sets, acc) = x
  pairs.f1(i, acc, Array.get(Set(), sets, i))

def pairs(k: Nat, +i: U32, x: Array<Set()> & Acc) -> Array<Set()> & Acc:
  match k:
    case 0n:
      x
    case 1n+p:
      pairs(p, (i + 1 : U32), pairs.one(i, x))

def compare.fin(vocab: Set(), x: Array<Set()> & Acc) -> Res:
  (sets, acc) = x
  Acc{score, dupes, diff} = acc
  Res{U32.from_nat(Set.size(vocab)), score, dupes, diff}

def compare.pairs(b: Bs) -> Res:
  Bs{stop, vocab, sets} = b
  compare.fin(vocab, pairs(U32.to_nat(ndocs()), 0, (sets, Acc{0, 0, 0})))

# stop = new Set(stopWords); a Set per document; then the windows
def compare(docs: List<&2, List<&2, String>>, stop: List<&2, String>) -> Res:
  compare.pairs(sets.build(docs, 0,
    Bs{Set.from_list(stop), Set.new(), [Set.new() : Set()*256n]}))

def kernel(s: Corpus & Res) -> Corpus & Res:
  (c, r) = s
  Corpus{+docs, +stop} = c
  (Corpus{docs, stop}, compare(docs, stop))

def checksum(s: Corpus & Res) -> U32:
  (c, r) = s
  Res{vocab, score, dupes, diff} = r
  B.mix(B.mix(B.mix(B.mix(2166136261, vocab), score), dupes), diff)

def main() -> IO(Unit):
  c = corpus(words(1024n, 0, ([SNil{} : String*1024n], 1831565813)))
  s = B.warm(~Corpus & Res, ~(r => r), ~kernel, 5n, (c, Res{0, 0, 0, 0}))
  do IO<Unit>:
    r : (Corpus & Res) & List<&2, U32> <- B.timed(~Corpus & Res, ~(r => r), ~kernel, 21n, s, [])
    B.finish(~Corpus & Res, ~checksum, ndocs(), 3, 21, r)
