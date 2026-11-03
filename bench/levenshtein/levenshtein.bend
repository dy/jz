import Base
import ../_lib/bench.bend as B
# levenshtein.bend: Bend port of levenshtein.js (same strings, perturbation,
# evaluations and checksum): edit distance with one rolling row of LB+1
# cells, diag carrying the upper-left cell across the inner loop. Each cell
# reads prev[j], b[j-1] and prev[j-1] in a chain of stage defs, every read's
# pair the next stage's parameter, and writes prev[j].

type Lev is Type:
  Lev{a: Array<U32>, b: Array<U32>, prev: Array<U32>}

type Row is Type:
  Row{b: Array<U32>, prev: Array<U32>, diag: U32}

def la() -> U32:
  512

def lb() -> U32:
  512

# Deterministic strings over an 8-letter alphabet: XorShift32.
def fill(k: Nat, +i: U32, +s: U32, a: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      a
    case 1n+p:
      +s1 = (s .^. (s << 13n) : U32)
      +s2 = (s1 .^. (s1 >> 17n) : U32)
      +s3 = (s2 .^. (s2 << 5n) : U32)
      fill(p, (i + 1 : U32), s3, a[i] <- U32.mod(s3, 8))

# m = min(up + 1, prev[j-1] + 1, sub); prev[j] = m; diag = up
def cell.f3(+j: U32, +up: U32, sub: U32, b: Array<U32>, r: Array<U32> & U32) -> Row:
  (prev, left) = r
  Row{b, prev[j] <- U32.min(U32.min((up + 1 : U32), (left + 1 : U32)), sub), up}

# sub = diag + (ai === b[j-1] ? 0 : 1)
def cell.f2(+j: U32, ai: U32, diag: U32, +up: U32, prev: Array<U32>, r: Array<U32> & U32) -> Row:
  (b, bj) = r
  cell.f3(j, up, (diag + Bool.to_u32(U32.is_ne(ai, bj)) : U32), b, prev[(j - 1 : U32)])

def cell.f1(+j: U32, ai: U32, diag: U32, b: Array<U32>, r: Array<U32> & U32) -> Row:
  (prev, up) = r
  cell.f2(j, ai, diag, up, prev, b[(j - 1 : U32)])

def cell(+j: U32, ai: U32, s: Row) -> Row:
  Row{b, prev, diag} = s
  cell.f1(j, ai, diag, b, prev[j])

def cells(k: Nat, +j: U32, +ai: U32, s: Row) -> Row:
  match k:
    case 0n:
      s
    case 1n+p:
      cells(p, (j + 1 : U32), ai, cell(j, ai, s))

# row i: diag = prev[0]; prev[0] = i (one swap); ai = a[i-1]; then its cells
def row.fin(a: Array<U32>, s: Row) -> Lev:
  Row{b, prev, diag} = s
  Lev{a, b, prev}

def row.f2(+ai: U32, a: Array<U32>, b: Array<U32>, r: Array<U32> & U32) -> Lev:
  (prev, diag) = r
  row.fin(a, cells(U32.to_nat(lb()), 1, ai, Row{b, prev, diag}))

def row.f1(+i: U32, b: Array<U32>, prev: Array<U32>, r: Array<U32> & U32) -> Lev:
  (a, ai) = r
  row.f2(ai, a, b, Array.swap(U32, prev, 0, i))

def row(+i: U32, s: Lev) -> Lev:
  Lev{a, b, prev} = s
  row.f1(i, b, prev, a[(i - 1 : U32)])

def rows(k: Nat, +i: U32, s: Lev) -> Lev:
  match k:
    case 0n:
      s
    case 1n+p:
      rows(p, (i + 1 : U32), row(i, s))

# prev[j] = j for j in 0..LB
def init(k: Nat, +j: U32, a: Array<U32>) -> Array<U32>:
  match k:
    case 0n:
      a
    case 1n+p:
      init(p, (j + 1 : U32), a[j] <- j)

def dist.fin(a: Array<U32>, b: Array<U32>, r: Array<U32> & U32) -> Lev & U32:
  (prev, d) = r
  (Lev{a, b, prev}, d)

def dist.read(s: Lev) -> Lev & U32:
  Lev{a, b, prev} = s
  dist.fin(a, b, prev[lb()])

def dist(s: Lev) -> Lev & U32:
  Lev{a, b, prev} = s
  dist.read(rows(U32.to_nat(la()), 1, Lev{a, b, init(U32.to_nat((lb() + 1 : U32)), 0, prev)}))

# one evaluation: a[j] = (a[j] + 1) % ALPHA, j = it % LA; h = mix(h, distance)
def eval.mix(h: U32, r: Lev & U32) -> Lev & U32:
  (s, d) = r
  (s, B.mix(h, d))

def eval.f1(+j: U32, h: U32, b: Array<U32>, prev: Array<U32>, r: Array<U32> & U32) -> Lev & U32:
  (a, x) = r
  eval.mix(h, dist(Lev{a[j] <- U32.mod((x + 1 : U32), 8), b, prev}))

def eval(+it: U32, r: Lev & U32) -> Lev & U32:
  (s, h) = r
  Lev{a, b, prev} = s
  +j = U32.mod(it, la())
  eval.f1(j, h, b, prev, a[j])

def run_kernel(k: Nat, +it: U32, r: Lev & U32) -> Lev & U32:
  match k:
    case 0n:
      r
    case 1n+p:
      run_kernel(p, (it + 1 : U32), eval(it, r))

def kernel(r: Lev & U32) -> Lev & U32:
  (s, h) = r
  run_kernel(8n, 0, (s, 2166136261))

def checksum(r: Lev & U32) -> U32:
  (s, h) = r
  h

def main() -> IO(Unit):
  a = fill(512n, 0, 305441741, [0 : U32*512n])
  b = fill(512n, 0, 2654435769, [0 : U32*512n])
  s = B.warm(~Lev & U32, ~(r => r), ~kernel, 5n, (Lev{a, b, [0 : U32*1024n]}, 0))
  do IO<Unit>:
    r : (Lev & U32) & List<&2, U32> <- B.timed(~Lev & U32, ~(r => r), ~kernel, 21n, s, [])
    B.finish(~Lev & U32, ~checksum, (la() * lb() * 8 : U32), 2, 21, r)
