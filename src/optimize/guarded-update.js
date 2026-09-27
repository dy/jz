// A data-dependent last conjunct folds into the update it guards.
//
//   if (child + 1 < n && a[child] < a[child + 1]) child++
//
// The first test is a bound the predictor learns; the second compares two
// loaded values and goes either way. Emitted as one branch over the whole
// conjunction, the update pays a misprediction whenever the data decides
// (heapsort's child pick: about half the time). With the bound kept as the
// branch and the comparison made a value,
//
//   (if A (then (local.set $x (select V (local.get $x) B))))
//
// the update costs a compare and a conditional move, and `x + 1` under a
// comparison is `x + B`. B runs where it ran before, once, under A; only V is
// new work on the path where B fails, so V is a few register operations that
// read no memory and cannot trap. B reads memory (that is what makes it
// data-dependent) and holds no branch; the address temps it tees are its own:
// V now runs before B, so it reads none of them, and none is the target.
//
// Speed tiers: the update becomes unconditional, a latency-for-predictability
// trade.

const isArr = Array.isArray

// Operations V may hold: register arithmetic that cannot trap.
const CHEAP = new Set([
  'local.get', 'i32.const', 'i64.const', 'f64.const', 'f32.const',
  'i32.add', 'i32.sub', 'i32.mul', 'i32.and', 'i32.or', 'i32.xor', 'i32.shl', 'i32.shr_s', 'i32.shr_u',
  'i64.add', 'i64.sub', 'i64.and', 'i64.or', 'i64.xor', 'i64.shl', 'i64.shr_s', 'i64.shr_u',
  'f64.add', 'f64.sub', 'f64.mul', 'f64.neg', 'f64.abs',
])
const COMPARE = /^(?:i32|i64|f64|f32)\.(?:eq|ne|lt|gt|le|ge)(?:_[su])?$|^(?:i32|i64)\.eqz$/
const LOAD = /^(?:i32|i64|f32|f64)\.load/
// Operations B may hold: comparisons over loads and register arithmetic.
const valueOp = op => CHEAP.has(op) || COMPARE.test(op) || LOAD.test(op) || op === 'local.tee' ||
  op === 'f64.convert_i32_s' || op === 'f64.convert_i32_u' || op === 'i32.wrap_i64' || op === 'i64.extend_i32_s' || op === 'i64.extend_i32_u'

const every = (n, ok) => !isArr(n) || (ok(n[0]) && n.every((x, i) => i === 0 || every(x, ok)))
const some = (n, hit) => isArr(n) && (hit(n[0]) || n.some((x, i) => i > 0 && some(x, hit)))
const size = n => isArr(n) ? n.reduce((s, x) => s + size(x), 0) : 1
const names = (n, op, out = new Set()) => {
  if (!isArr(n)) return out
  if (n[0] === op) out.add(n[1])
  for (let i = 1; i < n.length; i++) names(n[i], op, out)
  return out
}

const isConst = (n, v) => isArr(n) && n[0] === 'i32.const' && Number(n[1]) === v
const armOf = (n, tag) => isArr(n) && n[0] === tag && n.length === 2 ? n[1] : null

/** `(if (result i32) A (then B) (else (i32.const 0)))` as [A, B], or null. */
const conjunction = c => {
  if (!isArr(c) || c[0] !== 'if' || c.length !== 5 || c[1]?.[0] !== 'result' || c[1][1] !== 'i32') return null
  const b = armOf(c[3], 'then'), z = armOf(c[4], 'else')
  return b && isConst(z, 0) ? [c[2], b] : null
}

const rewrite = node => {
  if (!isArr(node)) return
  for (let i = 1; i < node.length; i++) rewrite(node[i])
  if (node[0] !== 'if' || node.length !== 3) return
  const set = isArr(node[2]) && node[2][0] === 'then' && node[2].length === 2 ? node[2][1] : null
  if (!isArr(set) || set[0] !== 'local.set' || set.length !== 3 || typeof set[1] !== 'string') return
  const pair = conjunction(node[1])
  if (!pair) return
  const [a, b] = pair, x = set[1], v = set[2]
  if (!COMPARE.test(b[0]) || !every(b, valueOp) || !some(b, op => LOAD.test(op))) return
  if (!isArr(v) || !every(v, op => CHEAP.has(op)) || size(v) > 12) return
  const teed = names(b, 'local.tee')
  if (teed.has(x)) return
  for (const r of names(v, 'local.get')) if (teed.has(r)) return
  const get = ['local.get', x]
  const step = v[0] === 'i32.add' && v.length === 3 && isArr(v[1]) && v[1][0] === 'local.get' && v[1][1] === x && isConst(v[2], 1)
  node[1] = a
  node[2] = ['then', ['local.set', x, step ? ['i32.add', get, b] : ['select', v, get, b]]]
}

/** Fold each data-dependent last conjunct of `fn` into the local update it guards. */
export function foldGuardedUpdates(fn) {
  if (isArr(fn) && fn[0] === 'func') rewrite(fn)
}
