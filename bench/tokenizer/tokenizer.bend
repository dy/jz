import Base
import ../_lib/bench.bend as B
# tokenizer.bend: Bend port of tokenizer.js (same source, prefixes and
# checksum): a branchy lexer classifying each character as digit,
# identifier, punctuation or whitespace, accumulating integer tokens and
# FNV-mixing the token stream. The source is BASE 512 times, its char codes
# in an Array<U32> (charCodeAt). Run i scans the prefix of length n - (i & 7),
# so the state carries the run index beside the source and the
# last checksum.

type Lex is Type:
  Lex{src: Array<U32>, run: U32, cs: U32}

type Tok is Data:
  Tok{h: U32, num: U32, in_num: Bool, in_id: Bool, toks: U32}

def base() -> String:
  "let alpha_12 = beta + 12345; if (alpha_12 >= 99) { total = total + alpha_12; }\n"

def n() -> U32:
  40448

# the source: BASE's char codes, 512 times over
def load(s: String, +i: U32, a: Array<U32>) -> Array<U32> & U32:
  match s:
    case SNil{}:
      (a, i)
    case SCon{Chr{c}, t}:
      load(t, (i + 1 : U32), a[i] <- c)

def repeat.step(r: Array<U32> & U32) -> Array<U32> & U32:
  (a, i) = r
  load(base(), i, a)

def repeat(k: Nat, r: Array<U32> & U32) -> Array<U32> & U32:
  match k:
    case 0n:
      r
    case 1n+p:
      repeat(p, repeat.step(r))

def is_alpha(+c: U32) -> Bool:
  ((c >= 65 : U32) && (c <= 90 : U32)) || ((c >= 97 : U32) && (c <= 122 : U32)) || U32.is_eq(c, 95)

# a non-digit ends a number token: h = mix(h, number); tokens++
def flush(t: Tok) -> Tok:
  Tok{h, +num, in_num, in_id, +toks} = t
  match in_num:
    case True{}:
      Tok{B.mix(h, num), 0, False{}, in_id, (toks + 1 : U32)}
    case False{}:
      Tok{h, num, False{}, in_id, toks}

# an identifier character: its first one mixes in as a token
def ident(+c: U32, t: Tok) -> Tok:
  Tok{h, num, in_num, in_id, +toks} = t
  match in_id:
    case False{}:
      Tok{B.mix(h, c), num, in_num, True{}, (toks + 1 : U32)}
    case True{}:
      Tok{h, num, in_num, True{}, toks}

# punctuation (c > 32) mixes in as a token; whitespace does not
def punct(gt: Bool, +c: U32, t: Tok) -> Tok:
  match gt:
    case True{}:
      Tok{h, num, in_num, in_id, toks} = t
      Tok{B.mix(h, c), num, in_num, False{}, (toks + 1 : U32)}
    case False{}:
      Tok{h, num, in_num, in_id, toks} = t
      Tok{h, num, in_num, False{}, toks}

def word(alpha: Bool, +c: U32, t: Tok) -> Tok:
  match alpha:
    case True{}:
      ident(c, t)
    case False{}:
      punct((c > 32 : U32), c, t)

def step(digit: Bool, +c: U32, t: Tok) -> Tok:
  match digit:
    case True{}:
      Tok{h, num, in_num, in_id, toks} = t
      Tok{h, (num * 10 + (c - 48) : U32), True{}, in_id, toks}
    case False{}:
      word(is_alpha(c), c, flush(t))

def char(t: Tok, x: Array<U32> & U32) -> Array<U32> & Tok:
  (src, +c) = x
  (src, step((c >= 48 : U32) && (c <= 57 : U32), c, t))

def read(+i: U32, r: Array<U32> & Tok) -> Array<U32> & Tok:
  (src, t) = r
  char(t, src[i])

def scan(k: Nat, +i: U32, r: Array<U32> & Tok) -> Array<U32> & Tok:
  match k:
    case 0n:
      r
    case 1n+p:
      scan(p, (i + 1 : U32), read(i, r))

# the end: a trailing number is a token; then h = mix(h, tokens)
def close.fin(src: Array<U32>, t: Tok) -> Array<U32> & U32:
  Tok{h, num, in_num, in_id, toks} = t
  (src, B.mix(h, toks))

def close(r: Array<U32> & Tok) -> Array<U32> & U32:
  (src, t) = r
  close.fin(src, flush(t))

def run.fin(+i: U32, r: Array<U32> & U32) -> Lex:
  (src, h) = r
  Lex{src, (i + 1 : U32), h}

# cs = scan(src, n - (i & 7)), run i
def kernel(s: Lex) -> Lex:
  Lex{src, +i, cs} = s
  run.fin(i, close(scan(U32.to_nat((n() - (i .&. 7) : U32)), 0,
    (src, Tok{2166136261, 0, False{}, False{}, 0}))))

def checksum(s: Lex) -> U32:
  Lex{src, i, cs} = s
  cs

# the timed runs count from 0 again, as the warm-up runs did
def rewind(s: Lex) -> Lex:
  Lex{src, i, cs} = s
  Lex{src, 0, cs}

def run(r: Array<U32> & U32) -> IO(Unit):
  (src, len) = r
  s = rewind(B.warm(~Lex, ~(s => s), ~kernel, 5n, Lex{src, 0, 0}))
  do IO<Unit>:
    r : Lex & List<&2, U32> <- B.timed(~Lex, ~(s => s), ~kernel, 21n, s, [])
    B.finish(~Lex, ~checksum, n(), 5, 21, r)

def main() -> IO(Unit):
  run(repeat(512n, ([0 : U32*65536n], 0)))
