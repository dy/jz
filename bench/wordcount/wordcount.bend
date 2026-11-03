import Base
import ../_lib/bench.bend as B
# wordcount.bend: Bend port of wordcount.js (same vocabulary, token stream,
# probes, passes and checksum): word frequencies in a string-keyed map. The
# words are Strings, the counts Base's Map, a fresh one per pass as
# `counts = {}` is: each token reads its count (0 when absent) and sets it
# one higher, and the probes read 64 counts into the hash.

type Wc is Type:
  Wc{words: Array<String>, toks: Array<U32>, probes: Array<String>}

type Tally is Type:
  Tally{words: Array<String>, toks: Array<U32>, m: Map<&2, U32>}

type Lookup is Type:
  Lookup{probes: Array<String>, m: Map<&2, U32>, h: U32}

def nwords() -> Nat:
  512n

def n() -> Nat:
  16384n

# x = imul(x, 0x9e3779b1) + j; the char 97 + ((x >>> 16) % 26), len times
def spell(k: Nat, +j: U32, +x: U32) -> String:
  match k:
    case 0n:
      SNil{}
    case 1n+p:
      +y = (x * 2654435761 + j : U32)
      SCon{Chr{(97 + U32.mod((y >> 16n : U32), 26) : U32)}, spell(p, (j + 1 : U32), y)}

# Deterministic vocabulary: 512 words of 3-8 lowercase chars from XorShift32.
def vocab(k: Nat, +i: U32, +s: U32, a: Array<String>) -> Array<String>:
  match k:
    case 0n:
      a
    case 1n+p:
      +s1 = (s .^. (s << 13n) : U32)
      +s2 = (s1 .^. (s1 >> 17n) : U32)
      +s3 = (s2 .^. (s2 << 5n) : U32)
      +len = (3 + U32.mod((s3 >> 8n : U32), 6) : U32)
      vocab(p, (i + 1 : U32), s3, Array.set(String, a, i, spell(U32.to_nat(len), 0, s3)))

# Skewed token stream: half the traffic hits 16 hot words.
def tok(cold: Bool, +s: U32) -> U32:
  match cold:
    case False{}:
      (s >> 4n .&. 15 : U32)
    case True{}:
      (s >> 4n .&. 511 : U32)

def tokens(k: Nat, +i: U32, +s: U32, a: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      a
    case 1n+p:
      +s1 = (s .^. (s << 13n) : U32)
      +s2 = (s1 .^. (s1 >> 17n) : U32)
      +s3 = (s2 .^. (s2 << 5n) : U32)
      tokens(p, (i + 1 : U32), s3, a[i] <- tok(U32.is_ne((s3 .&. 8 : U32), 0), s3))

# Probe every 8th word, then 8 absent keys ("zz0".."zz7"), whose count reads 0.
def probe.word(+j: U32, probes: Array<String>, r: Array<String> & String) -> Array<String> & Array<String>:
  (words, w) = r
  (words, Array.set(String, probes, j, w))

def probe.step(+j: U32, r: Array<String> & Array<String>) -> Array<String> & Array<String>:
  (words, probes) = r
  probe.word(j, probes, Array.get(String, words, (j * 8 .&. 511 : U32)))

def probe.words(k: Nat, +j: U32, r: Array<String> & Array<String>) -> Array<String> & Array<String>:
  match k:
    case 0n:
      r
    case 1n+p:
      probe.words(p, (j + 1 : U32), probe.step(j, r))

def probe.absent(k: Nat, +j: U32, probes: Array<String>) -> Array<String>:
  match k:
    case 0n:
      probes
    case 1n+p:
      probe.absent(p, (j + 1 : U32), Array.set(String, probes, (56 + j : U32), "zz" ++ U32.show(j)))

# counts[w] = (counts[w] | 0) + 1, w = words[toks[i]]
def count.set(+w: String, r: Map<&2, U32> & U32) -> Map<&2, U32>:
  (m, c) = r
  Map.set(&2, U32, m, w, (c + 1 : U32))

def count.word(toks: Array<U32>, m: Map<&2, U32>, r: Array<String> & String) -> Tally:
  (words, +w) = r
  Tally{words, toks, count.set(w, Map.get(U32, 0, m, w))}

def count.tok(words: Array<String>, m: Map<&2, U32>, r: Array<U32> & U32) -> Tally:
  (toks, t) = r
  count.word(toks, m, Array.get(String, words, t))

def count(k: Nat, +i: U32, c: Tally) -> Tally:
  match k:
    case 0n:
      c
    case 1n+p:
      Tally{words, toks, m} = c
      count(p, (i + 1 : U32), count.tok(words, m, toks[i]))

# h = mix(h, counts[probes[j]] | 0)
def look.mix(h: U32, probes: Array<String>, r: Map<&2, U32> & U32) -> Lookup:
  (m, c) = r
  Lookup{probes, m, B.mix(h, c)}

def look.word(h: U32, m: Map<&2, U32>, r: Array<String> & String) -> Lookup:
  (probes, p) = r
  look.mix(h, probes, Map.get(U32, 0, m, p))

def look(k: Nat, +j: U32, l: Lookup) -> Lookup:
  match k:
    case 0n:
      l
    case 1n+p:
      Lookup{probes, m, h} = l
      look(p, (j + 1 : U32), look.word(h, m, Array.get(String, probes, j)))

def pass.fin(words: Array<String>, toks: Array<U32>, l: Lookup) -> Wc & U32:
  Lookup{probes, m, h} = l
  (Wc{words, toks, probes}, h)

def pass.look(h: U32, probes: Array<String>, c: Tally) -> Wc & U32:
  Tally{words, toks, m} = c
  pass.fin(words, toks, look(64n, 0, Lookup{probes, m, h}))

def pass(r: Wc & U32) -> Wc & U32:
  (w, h) = r
  Wc{words, toks, probes} = w
  pass.look(h, probes, count(n(), 0, Tally{words, toks, Map.new(&2, U32)}))

def passes(k: Nat, r: Wc & U32) -> Wc & U32:
  match k:
    case 0n:
      r
    case 1n+p:
      passes(p, pass(r))

def kernel(r: Wc & U32) -> Wc & U32:
  (w, h) = r
  passes(16n, (w, 2166136261))

def checksum(r: Wc & U32) -> U32:
  (w, h) = r
  h

def run(toks: Array<U32>, r: Array<String> & Array<String>) -> IO(Unit):
  (words, probes) = r
  s = B.warm(~Wc & U32, ~(r => r), ~kernel, 5n,
    (Wc{words, toks, probe.absent(8n, 0, probes)}, 0))
  do IO<Unit>:
    r : (Wc & U32) & List<&2, U32> <- B.timed(~Wc & U32, ~(r => r), ~kernel, 21n, s, [])
    B.finish(~Wc & U32, ~checksum, (16384 * 16 : U32), 512, 21, r)

def main() -> IO(Unit):
  words = vocab(nwords(), 0, 305441741, [SNil{} : String*512n])
  toks = tokens(n(), 0, 625341585, [0 : U32*16384n])
  run(toks, probe.words(56n, 0, (words, [SNil{} : String*64n])))
