// The local rewrites of WAT (src/optimize/rules.js, the table, and the rules that stay code
// beside it). First, programs whose rewrite answered wrong, each against Node at the
// configurations it was wrong at (their classes' populations: test/rules-population.js).
// Then the checker: every row of the table, its two trees assembled with watr for each tuple
// of constants its condition admits and run over a grid of arguments, compared by the row's
// relation; and every rule that stays code, its own function run on patterns and the tree it
// leaves compared the same way. Checked means run on that grid, not proven.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { compile as assemble } from 'watr'
import { agree, compileInProcess } from './util.js'
import { ctx } from '../src/ctx.js'
import { resetTape, fromWat, toWat } from '../src/ir/tape.js'
import { TABLE, EXACT, NAN, FEWER_TRAPS, NO_WRAP, AFTER_TRAP, rulesOf, rewriteBy, immediate } from '../src/optimize/rules.js'
import { fusedRewrite, boolConvertToSelect, foldV128Memargs, refoldMemargs, foldLoadCasts, holdWordNumbers, lowerToInt32Tails } from '../src/optimize/peephole.js'
import { guardToInt32 } from '../src/optimize/to-int32.js'
import { foldWrappedWords, narrowInts } from '../src/optimize/int-narrow.js'
import { fold } from '../src/optimize/fold.js'
import { truncChoice } from '../src/optimize/trunc-choice.js'
import { maskOperands } from '../src/optimize/mask-operands.js'
import { foldShiftRemainder } from '../src/optimize/shift-remainder.js'
import { unsignedDivision } from '../src/optimize/unsigned-div.js'
import { selectBits } from '../src/optimize/select-bits.js'
import { selectArms } from '../src/optimize/select-arms.js'
import { narrowFloat32 } from '../src/optimize/float32.js'
import { stripDeadCanons } from '../src/optimize/nan-canon.js'

const CONFIGS = [false, 2, 'size', 'speed']

test('rules: two shifts left merge with each count taken mod 32', () => {
  // (x << -1) << 1 is (x << 31) << 1, 0 at x = 1; the counts summed raw were 0, a shift by nothing
  const src = 'export let f = (x) => { x = x | 0; return ((x << -1) << 1) | 0 }'
  for (const optimize of CONFIGS) for (const x of [1, -1, 3]) agree(src, 'f', [x], { optimize })
  const src2 = 'export let f = (x) => { x = x | 0; return ((x << 2) << -1) | 0 }'
  for (const optimize of CONFIGS) agree(src2, 'f', [5], { optimize })
})

test('rules: a Boolean added to -0 gives +0', () => {
  // -0 + (a < b) is +0 where the test fails; the speed tier's select kept the -0
  const src = 'export let f = (x, a, b) => { a = a | 0; b = b | 0; return x + (a < b) }'
  for (const optimize of CONFIGS) for (const args of [[-0, 1, 0], [-0, 0, 1], [0, 1, 0]]) agree(src, 'f', args, { optimize })
})

test('rules: a ternary of a Boolean and a Number under a constant condition, compared', () => {
  // the unrolled counter makes `i % 2^32` a literal; the arm taken was compared by its bits unboxed
  const src = 'export let f = (c) => { let r = 0; for (let i = 0; i < 3; i++) { r += (((i % 4294967296) ? (c !== i) : 0.5) !== 1) } return r }'
  for (const optimize of CONFIGS) for (const c of [1, 2, NaN]) agree(src, 'f', [c], { optimize })
})

// ── the grids ─────────────────────────────────────────────────────────────

let seed = 0x2545F491
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296
const POW2 = Array.from({ length: 32 }, (_, k) => 2 ** k)
const I32 = [...new Set([0, 1, -1, 2, -2, 3, 7, 15, 17, 31, 33, 63, 127, 255, 256, 65535, 65536, 0x7fffffff, -0x80000000, 0x7ffffffe, -0x7fffffff, 0x12345678, 0xdeadbeef | 0,
  ...POW2.map(p => p | 0), ...POW2.map(p => (p - 1) | 0), ...POW2.map(p => -p | 0)])]
const randI32 = () => rnd() < 0.5 ? (rnd() * 4294967296) | 0 : ((rnd() * 2000) | 0) - 1000
const I64 = [0n, 1n, -1n, 2n, 255n, 0x7fffffffn, 0x80000000n, 0xffffffffn, 0x100000000n, -0x80000000n, 0x7fffffffffffffffn, -0x8000000000000000n,
  0x4338000000000000n, 1n << 52n, 0x7ff8000000000000n, -0x0008000000000000n, 0x7ff0000000000000n, 0x123456789abcdefn]
const randI64 = () => BigInt.asIntN(64, (BigInt((rnd() * 4294967296) >>> 0) << 32n) | BigInt((rnd() * 4294967296) >>> 0))
const f64 = new Float64Array(1), i64 = new BigInt64Array(f64.buffer)
const bitsOf = (x) => (f64[0] = x, i64[0])
// (a float travels as its bits, so a NaN's payload and sign are inputs too)
const F64 = [...[0, -0, 1, -1, 0.5, -0.5, 1.5, -1.5, 2, 3, 2 ** 31, 2 ** 31 - 1, -(2 ** 31), 2 ** 32, 2 ** 32 - 1, 2 ** 52, 2 ** 53, 2 ** 63, -(2 ** 63),
  5e-324, -5e-324, 1.7976931348623157e308, Infinity, -Infinity, 0.1, 6755399441055744, 4294967295.5].map(bitsOf),
  0x7ff8000000000000n, -0x0008000000000000n, 0x7ff0000000000001n, 0x7ff8000100000000n, 0x7ffc000000000123n]
const randF64 = () => bitsOf(rnd() < 0.5 ? (rnd() - 0.5) * 2 ** (rnd() * 80 - 20) : ((rnd() * 4294967296) | 0) + (rnd() < 0.5 ? 0 : 0.5))
// (an address: the ends of the one page of memory, and past them)
const ADDR = [0, 1, 4, 7, 8, 1024, 65524, 65528, 65529, 65531, 65532, 65533, 65535, 65536, -1, -4, -8, 0x7fffffff, -0x80000000]
// (a NaN box: null, undefined, a pointer of each tag)
const BOX = [...I64, 0x7ff8000100000000n, 0x7ff8000200000000n,
  ...Array.from({ length: 16 }, (_, t) => BigInt.asIntN(64, 0x7ff8000000000000n | (BigInt(t) << 47n) | (0x1234n << 32n) | 0x100n))]
const GRID = { i32: [I32, randI32], i64: [I64, randI64], f64: [F64, randF64], addr: [ADDR, randI32], box: [BOX, randI64] }
// The argument tuples of a parameter list (`only`: a parameter's edges instead of its type's):
// every combination of the edges where they are few, else of their first few, then random tuples.
function* args(types, only) {
  const all = types.map((t, i) => only?.[i] ?? GRID[t][0]), n = all.reduce((a, s) => a * s.length, 1)
  const sets = n <= 3000 ? all : all.map(s => s.slice(0, Math.max(4, Math.floor(3000 ** (1 / types.length)))))
  const idx = sets.map(() => 0), total = sets.reduce((a, s) => a * s.length, 1)
  for (let c = 0; c < total; c++) {
    yield idx.map((k, i) => sets[i][k])
    for (let i = idx.length - 1; i >= 0; i--) { if (++idx[i] < sets[i].length) break; idx[i] = 0 }
  }
  for (let e = 0; e < (types.length ? 64 : 0); e++) yield types.map((t, i) => only?.[i] ? only[i][(rnd() * only[i].length) | 0] : GRID[t][1]())
}
// The spellings a constant's immediate takes, as the compiler's IR holds them (numbers, and the
// strings a parsed helper keeps: a sign, hex, `_`, a word spelled past 2^31).
const SPELLED = {
  'i32.const': [0, 1, -1, 2, 3, 4, 5, 7, 8, 16, 30, 31, 32, 33, 63, 64, -31, -32, -33, 255, 256, 511, 65535, 65536, 0x7fffffff, -0x80000000,
    0x40000000, 0x12345678, 4294967295, 2147483648, 4294967264, '0xffffffff', '0x80000000', '-1', '1_000'],
  'i64.const': [0n, 1n, -1n, 0x7ff8000000000000n, -0x0008000000000000n, 0x100000000n, 0xffffffffn, 0x7ff8000100000001n, '0x7FF8000000000000', '0x4338000000000000', '-0x8000000000000000', '18442240474082181120'],
  'f64.const': [0, -0, 1, 2, -2, 0.5, 2 ** 31, Infinity, '2', 'nan:0x7ff8000000000001', 'inf', '-0'],
}

// ── instances of a pattern ────────────────────────────────────────────────

const isHole = (p) => typeof p === 'string' && p[0] === '?'
// The type of operand `i` of `op` (`addr` an address, `box` a NaN box a helper reads).
const operandType = (op, i) => {
  if (op === 'call') return 'box'
  const t = op.slice(0, 3), name = op.slice(4)
  if (/load|store/.test(name)) return i === 1 ? 'addr' : t
  const conv = name.match(/_(i32|i64|f32|f64)(?:_[su])?$/)
  return conv ? conv[1] : t
}
const resultType = (op) => op === 'call' ? 'i32' : /\.(eqz|eq|ne|lt|gt|le|ge)(_[su])?$/.test(op) ? 'i32' : op.slice(0, 3)
// Where a pattern has a subtree hole of a type: a parameter of it, and the shapes a row's
// condition reads (an extended word under an i64 or, a float constant under a doubling).
const SHAPES = {
  i32: [['$p', 'i32']], addr: [['$p', 'addr']], box: [['$p', 'box']],
  i64: [['$p', 'i64'], ['i64.extend_i32_s', ['$p', 'i32']], ['i64.extend_i32_u', ['$p', 'i32']]],
  f64: [['$p', 'f64'], ['f64.const', 0.5], ['f64.const', -0]],
}
const MEMARGS = [[], ['offset=8'], ['offset=65532'], ['align=4'], ['offset=4', 'align=8']]
// Every instance of pattern `p` at a position of `type`: holes filled with parameters, shapes and constants.
const expand = (p, type) => {
  if (isHole(p)) return SHAPES[type]
  if (!Array.isArray(p)) return [p]
  if (isHole(p[0])) return expand(p[1], type)
  const op = p[0]
  if (SPELLED[op] && isHole(p[1])) return SPELLED[op].map(k => [op, k])
  if (op === 'local.get') return [['$p', type]]
  let out = [[op]]
  for (let i = 1; i < p.length; i++) {
    const c = p[i]
    const subs = isHole(c) && c[1] === '*' ? MEMARGS.map(m => [...m, ['$p', 'addr']])
      : typeof c === 'string' && c[0] === '$' ? [[c]] : expand(c, operandType(op, i)).map(s => [s])
    out = out.flatMap(x => subs.map(s => [...x, ...s]))
  }
  return out
}
// An instance with its parameters numbered: `$p` placeholders become reads of `$x0`, `$x1`...
const numbered = (inst) => {
  const params = []
  const walk = (n) => !Array.isArray(n) ? n : n[0] === '$p' ? (params.push(n[1]), ['local.get', `$x${params.length - 1}`]) : n.map(walk)
  return { tree: walk(inst), params }
}
// (a copy keeps the emitter's mark a code rule reads: `wordOf`, the operand a truncation truncates)
const clone = (n) => {
  if (!Array.isArray(n)) return n
  const m = n.map(clone)
  if (n.wordOf !== undefined && n.wordOf === n[1]) m.wordOf = m[1]
  return m
}

// ── running two trees over the grid ───────────────────────────────────────

// A function of parameters `params` returning `tree` as integer bits: a float parameter
// arrives as its bits, a float result leaves as its bits.
const WIRE = { i32: 'i32', addr: 'i32', i64: 'i64', box: 'i64', f64: 'i64', f32: 'i32' }
const PLAIN = { i32: 'i32', addr: 'i32', i64: 'i64', box: 'i64', f64: 'f64', f32: 'f32' }
const FROM_BITS = { f64: 'f64.reinterpret_i64', f32: 'f32.reinterpret_i32' }, TO_BITS = { f64: 'i64.reinterpret_f64', f32: 'i32.reinterpret_f32' }
const func = (name, params, result, tree, locals = []) => ['func', `$${name}`, ['export', `"${name}"`],
  ...params.map((t, i) => ['param', FROM_BITS[t] ? `$w${i}` : `$x${i}`, WIRE[t]]), ...(result ? [['result', WIRE[result]]] : []),
  ...params.flatMap((t, i) => FROM_BITS[t] ? [['local', `$x${i}`, t]] : []), ...locals,
  ...params.flatMap((t, i) => FROM_BITS[t] ? [['local.set', `$x${i}`, [FROM_BITS[t], ['local.get', `$w${i}`]]]] : []),
  TO_BITS[result] ? [TO_BITS[result], tree] : tree]
// The runtime's helpers by name, as jz writes them (module/core.js).
let runtime = null
const helperText = (names) => {
  if (!runtime) { compileInProcess('export let f = (x) => x', {}); runtime = ctx.core.stdlib }
  return names.map(h => typeof runtime[h] === 'function' ? runtime[h]() : runtime[h]).join('\n')
}
const DATA = '"' + Array.from({ length: 64 }, (_, i) => '\\' + ((i * 37 + 11) & 255).toString(16).padStart(2, '0')).join('') + '"'
const printTree = (n) => Array.isArray(n) ? '(' + n.map(printTree).join(' ') + ')' : typeof n === 'bigint' ? String(n) : Object.is(n, -0) ? '-0' : n === Infinity ? 'inf' : n === -Infinity ? '-inf' : String(n)
// One module of functions (each `[name, params, result, tree, locals]`) over one page of memory
// holding a pattern at its two ends, beside the runtime helpers named.
const instance = (funcs, helpers = []) => {
  const parts = [['memory', 1], ['export', '"memory"', ['memory', 0]], ['data', ['i32.const', 65472], DATA], ['data', ['i32.const', 0], DATA],
    ['global', '$g', ['mut', 'i32'], ['i32.const', 0]], ...funcs.map(([n, p, r, t, l]) => func(n, p, r, clone(t), clone(l)))]
  const wat = `(module ${helperText(helpers)} ${parts.map(printTree).join(' ')})`
  return new WebAssembly.Instance(new WebAssembly.Module(assemble(wat))).exports
}
// Pairs of trees as one module: `[params, result, a, b, localsA, localsB]` each, exported as a<i>, b<i>.
const instantiate = (pairs, helpers) => instance(pairs.flatMap(([p, r, a, b, la, lb], i) => [[`a${i}`, p, r, a, la], [`b${i}`, p, r, b, lb ?? la]]), helpers)
const call = (f, a) => { try { return { v: f(...a) } } catch (e) { if (e instanceof WebAssembly.RuntimeError) return { trap: true }; throw e } }
const nanBits = (v, result) => result === 'f64' ? typeof v === 'bigint' && (v & 0x7ff0000000000000n) === 0x7ff0000000000000n && (v & 0xfffffffffffffn) !== 0n
  : result === 'f32' && ((v >>> 0) & 0x7f800000) === 0x7f800000 && (v & 0x7fffff) !== 0
// Whether outcomes `x` (pattern) and `y` (replacement) agree by `relation`; a removed trap is counted.
const agrees = (relation, result, x, y, count) => {
  if (relation === FEWER_TRAPS && x.trap && !y.trap) { count.removed++; return true }
  if (x.trap || y.trap) return !!x.trap === !!y.trap
  return x.v === y.v || (relation === NAN && nanBits(x.v, result) && nanBits(y.v, result))
}
// The first input of pair `i` on which its trees disagree, or null; `admit` restricts the inputs.
const differs = (ex, i, relation, params, result, count, only, admit) => {
  for (const a of args(params, only)) {
    if (admit && !admit(a)) { count.outside++; continue }
    count.inputs++
    if (!agrees(relation, result, call(ex[`a${i}`], a), call(ex[`b${i}`], a), count)) return a
  }
  return null
}
const counts = () => ({ inputs: 0, removed: 0, outside: 0 })

// ── the table ─────────────────────────────────────────────────────────────

const show = (n) => printTree(n)
const RUNTIME = ['__ptr_type', '__ptr_aux', '__is_null', '__is_nullish']
for (const row of TABLE) {
  const [name, relation, match] = row
  test(`rules: the table's row ${name} (${relation})`, () => {
    const result = resultType(match[0])
    const one = rulesOf([row]), free = rulesOf([[...row.slice(0, 4), null, row[5]]])
    const admitted = [], refused = []
    for (const inst of expand(match, result)) {
      const { tree, params } = numbered(inst)
      const out = rewriteBy(one, clone(tree))
      if (out !== null) { admitted.push([params, result, tree, out]); continue }
      const any = rewriteBy(free, clone(tree))
      if (Array.isArray(any)) refused.push([params, result, tree, any])
    }
    ok(admitted.length > 0, `${name}: no instance on the grid is admitted`)
    const helpers = match[0] === 'call' ? RUNTIME : [], count = counts()
    const ex = instantiate(admitted, helpers)
    for (let i = 0; i < admitted.length; i++) {
      const [params, , a, b] = admitted[i], bad = differs(ex, i, relation, params, result, count)
      ok(bad === null, `${name}: ${show(a)} => ${show(b)}` + (bad === null ? '' : ` differs at (${bad})`))
      if (bad !== null) break
    }
    // (a tuple the condition refuses where both sides agree: reported, not failed)
    let agreeing = 0
    if (refused.length) {
      let rx = null
      try { rx = instantiate(refused, helpers) } catch {}
      if (rx) for (let i = 0; i < refused.length; i++) if (differs(rx, i, relation, refused[i][0], result, counts()) === null) agreeing++
    }
    ok(true, `${name}: ${admitted.length} instances admitted over ${count.inputs} inputs` + (count.removed ? `, a trap removed on ${count.removed}` : '') +
      (refused.length ? `; the condition refuses ${refused.length}, of which ${agreeing} agree on the grid` : ''))
    if (agreeing) console.log(`# rules: ${name}'s condition refuses ${agreeing} of ${refused.length} instances on which both trees agree`)
  })
}

// ── the rules that stay code ──────────────────────────────────────────────

// A rule that stays code, run on patterns: `pass` rewrites `(func $f (param $x0 …) … body)` in
// place (with `module`, a module holding it), and each body is compared with what the pass
// leaves of it, by `relation`, over the grid of the parameters' types (`only`: the edges of
// each parameter instead; `admit`, of the tree the pass leaves, the inputs its relation compares). A result of
// null is a body of stores: its memory is compared where neither side traps (AFTER_TRAP).
const HEADER = new Set(['param', 'result', 'local', 'export', 'type'])
const code = (name, relation, pass, params, result, bodies, opts = {}) => test(`rules: the code rule ${name} (${relation})`, () => {
  const { locals = [], module = false, helpers = [], only, admit } = opts
  const pairs = []
  for (const [label, body] of bodies) {
    const fn = ['func', '$f', ...params.map((t, i) => ['param', `$x${i}`, PLAIN[t]]), ...(result ? [['result', PLAIN[result]]] : []), ...clone(locals), clone(body)]
    const m = ['module', fn]
    pass(module ? m : fn)
    const out = module ? m.find(x => Array.isArray(x) && x[0] === 'func') : fn
    const stmts = out.filter((x, i) => i >= 2 && !(Array.isArray(x) && HEADER.has(x[0]))), decls = out.filter(x => Array.isArray(x) && x[0] === 'local')
    const after = stmts.length === 1 ? stmts[0] : ['block', ...(result ? [['result', PLAIN[result]]] : []), ...stmts]
    if (printTree(after) === printTree(body) && printTree(decls) === printTree(locals)) continue
    pairs.push([params, result, body, after, locals, decls, label])
  }
  ok(pairs.length > 0, `${name}: no pattern rewritten`)
  const count = counts()
  if (result === null) {
    // (a body of stores: each side an instance of its own, its memory's two ends compared after each call)
    for (const [p, , a, b, la, lb, label] of pairs) {
      const A = instance([['f', p, null, a, la]]), B = instance([['f', p, null, b, lb]])
      let bad = null
      for (const x of args(p, only)) {
        const ma = new Uint8Array(A.memory.buffer), mb = new Uint8Array(B.memory.buffer)
        ma.fill(0xAA, 0, 64); mb.fill(0xAA, 0, 64); ma.fill(0xAA, 65472); mb.fill(0xAA, 65472)
        const ra = call(A.f, x), rb = call(B.f, x)
        count.inputs++
        if (!!ra.trap !== !!rb.trap || (!ra.trap && (ma.some((v, k) => v !== mb[k])))) { bad = x; break }
      }
      ok(bad === null, `${name} (${label}): ${show(a)} => ${show(b)}` + (bad === null ? '' : ` differs at (${bad})`))
    }
  } else {
    const ex = instantiate(pairs, helpers)
    for (let i = 0; i < pairs.length; i++) {
      const [p, r, a, b, , , label] = pairs[i], bad = differs(ex, i, relation, p, r, count, only, admit?.(b, label))
      ok(bad === null, `${name} (${label}): ${show(a)} => ${show(b)}` + (bad === null ? '' : ` differs at (${bad})`))
      if (bad !== null) break
    }
  }
  ok(true, `${name}: ${pairs.length} of ${bodies.length} patterns rewritten, over ${count.inputs} inputs` + (count.outside ? ` (${count.outside} outside the relation's domain)` : '') + (count.removed ? `, a trap removed on ${count.removed}` : ''))
})
const g = (i) => ['local.get', `$x${i}`], c = (k) => ['i32.const', k], f = (k) => ['f64.const', k]
const table = (fn) => { const out = []; fn((label, body) => out.push([label, body])); return out }
const walk = (fn) => fusedRewrite(fn)
const F32 = [0, -0, 1, -1, 0.5, 1.5, 3.4028234663852886e38, -3.4028234663852886e38, 1e-45, -1e-45, 1.1754943508222875e-38, 16777216, 16777217, 0.1, Infinity, -Infinity, NaN, 2 ** 31]
const f32Bits = (x) => { const b = new Float32Array([x]); return new Int32Array(b.buffer)[0] }
GRID.f32 = [F32.map(f32Bits).concat([0x7fc00001, 0x7f800001 | 0, 0xffc00000 | 0]), () => f32Bits(Math.fround((rnd() - 0.5) * 2 ** (rnd() * 60 - 30)))]

// fusedRewrite's walk: two tests of one word against a range's ends, every spelling of each end
{
  const CS = [0, 1, -1, 5, 65, 90, 255, 0x7fffffff, -0x80000000, -100]
  const lows = (A) => [['i32.ge_s', g(0), c(A)], ['i32.gt_s', g(0), c(A - 1)], ['i32.le_s', c(A), g(0)], ['i32.lt_s', c(A - 1), g(0)]]
  const highs = (B) => [['i32.le_s', g(0), c(B)], ['i32.lt_s', g(0), c(B + 1)], ['i32.ge_s', c(B), g(0)], ['i32.gt_s', c(B + 1), g(0)]]
  const near = [...new Set([...I32.slice(0, 30), ...CS.flatMap(k => [(k - 1) | 0, k, (k + 1) | 0])])]
  code('range checks (foldRangeChecks)', EXACT, walk, ['i32'], 'i32', table(a => {
    for (const A of CS) for (const B of CS) for (const l of lows(A)) for (const h of highs(B)) a(`[${A}, ${B}]`, ['i32.and', l, h])
    for (const A of [0, -5]) a(`chain ${A}`, ['i32.and', ['i32.and', ['i32.ge_s', g(0), c(A)], ['i32.lt_s', g(0), c(10)]], ['i32.ne', g(0), c(3)]])
  }), { only: [near] })
  const le = (A, W) => ['i32.le_u', ['i32.sub', g(0), c(A)], c(W)]
  const AS = [0, 1, 8, 32, 65, 97, 128, 48, 0x7ffffff0], WS = [0, 1, 7, 25, 31]
  code('range unions (foldRangeUnions)', EXACT, walk, ['i32'], 'i32', table(a => {
    for (const A of AS) for (const W of WS) for (const A2 of AS) for (const W2 of WS) a(`[${A}, +${W}] | [${A2}, +${W2}]`, ['i32.or', le(A, W), le(A2, W2)])
    for (const C of [1, 8, 32]) for (const A2 of AS) a(`< ${C} | [${A2}, +${C - 1}]`, ['i32.or', ['i32.lt_u', g(0), c(C)], le(A2, C - 1)])
  }), { only: [[...I32.slice(0, 20), ...Array.from({ length: 200 }, (_, i) => i), 0x7ffffff0, 0x7fffffff]] })
}
// fusedRewrite's walk: a comparison of converted words as a word comparison (ir/numeric.js foldIntCompare)
{
  const cv = (s, e) => [s ? 'f64.convert_i32_s' : 'f64.convert_i32_u', e]
  const words = [['plain', g(1)], ['load8_u', ['i32.load8_u', c(0)]], ['and', ['i32.and', g(1), c(0x7fffffff)]], ['shr_u 1', ['i32.shr_u', g(1), c(1)]],
    ['shr_u 32', ['i32.shr_u', g(1), c(32)]], ['const 5', c(5)], ['const -5', c(-5)], ['const 2^31', c(-0x80000000)], ['const 4294967295', c(4294967295)]]
  code('integer comparison (foldIntCompare)', EXACT, walk, ['i32', 'i32'], 'i32', table(a => {
    for (const op of ['eq', 'ne', 'lt', 'gt', 'le', 'ge']) for (const s1 of [true, false]) for (const s2 of [true, false]) for (const [wn, w] of words) {
      a(`f64.${op} ${s1 ? 's' : 'u'}(x) ${s2 ? 's' : 'u'}(${wn})`, [`f64.${op}`, cv(s1, g(0)), cv(s2, w)])
      a(`f64.${op} ${s2 ? 's' : 'u'}(${wn}) ${s1 ? 's' : 'u'}(x)`, [`f64.${op}`, cv(s2, w), cv(s1, g(0))])
    }
    for (const op of ['eq', 'lt', 'ge']) for (const s of [true, false]) for (const K of [0, -1, 2147483648, 4294967295, 0.5, -0, NaN, 4294967296])
      a(`f64.${op} ${s ? 's' : 'u'}(x) ${K}`, [`f64.${op}`, cv(s, g(0)), f(K)])
  }), { only: [I32.slice(0, 40), I32.slice(0, 40)] })
}
// fusedRewrite's walk: an f64 `if` of pure arms as a select; a test that says which arm ran
{
  const arms = [['neg', ['f64.neg', g(0)]], ['x', g(0)], ['sum', ['f64.add', g(0), g(1)]], ['conv', ['f64.convert_i32_s', g(2)]], ['const', f(3)]]
  const conds = [['bit', ['i32.and', g(2), c(1)]], ['lt', ['f64.lt', g(0), g(1)]]]
  code('if to select', EXACT, walk, ['f64', 'f64', 'i32'], 'f64', table(a => {
    for (const [an, A] of arms) for (const [bn, B] of arms) for (const [cn, C] of conds) a(`${cn} ? ${an} : ${bn}`, ['if', ['result', 'f64'], C, ['then', A], ['else', B]])
  }), { only: [F64.slice(0, 16), F64.slice(0, 16), [0, 1, -1, 2]] })
  const sset = (v) => ['global.set', '$g', ['i32.add', ['global.get', '$g'], c(v)]]
  code('a test of which arm ran', EXACT, walk, ['i32'], 'i32', table(a => {
    for (const last of [1, 2, -1, 0]) for (const other of [0, 1])
      a(`last ${last} else ${other}`, ['block', ['result', 'i32'], ['global.set', '$g', c(0)], ['if', ['if', ['result', 'i32'], g(0), ['then', sset(1), c(last)], ['else', c(other)]], ['then', sset(10)]], ['global.get', '$g']])
  }))
}
// fusedRewrite's walk: ToInt32 of an integer expression as its word, the exact conversion's guard
// dropped where a range shows |x| < 2^63 (random f64 trees over words and a float)
{
  const T = ['local.get', '$t']
  const forms = {
    exact: (E) => ['select', ['i32.wrap_i64', ['i64.trunc_sat_f64_s', ['local.tee', '$t', E]]], c(0), ['f64.ne', T, f(Infinity)]],
    call: (E) => ['call', '$__to_int32', E],
    guarded: (E) => ['if', ['result', 'i32'], ['f64.lt', ['f64.abs', ['local.tee', '$t', E]], f(2 ** 63)], ['then', ['i32.wrap_i64', ['i64.trunc_sat_f64_s', T]]], ['else', ['call', '$__to_int32', T]]],
  }
  const R = (n) => (rnd() * n) | 0
  const leaves = [() => ['f64.convert_i32_s', g(0)], () => ['f64.convert_i32_u', g(1)], () => ['f64.convert_i32_s', g(1)], () => ['f64.const', [0, 1, -1, 3, 0.5, 2 ** 31, 2 ** 32, 1e15, 2 ** 53, -0][R(10)]],
    () => ['f64.convert_i32_u', ['i32.and', g(0), c(255)]], () => g(2)]
  const tree = (d) => {
    if (d === 0 || rnd() < 0.2) return leaves[R(leaves.length)]()
    const k = R(9), sub = () => tree(d - 1)
    return k < 3 ? [['f64.add', 'f64.sub', 'f64.mul'][k], sub(), sub()] : k === 3 ? ['f64.neg', sub()] : k === 4 ? [['f64.floor', 'f64.ceil', 'f64.trunc', 'f64.nearest'][R(4)], sub()]
      : k === 5 ? ['f64.div', sub(), f([3, -3, 2, 0.5][R(4)])] : k === 6 ? ['select', sub(), sub(), ['i32.lt_s', g(0), g(1)]]
      : k === 7 ? ['if', ['result', 'f64'], ['i32.and', g(0), c(1)], ['then', sub()], ['else', sub()]] : [['f64.min', 'f64.max'][R(2)], sub(), sub()]
  }
  for (const [form, mk] of Object.entries(forms))
    code(`ToInt32 folds, ${form} form`, EXACT, walk, ['i32', 'i32', 'f64'], 'i32', Array.from({ length: 250 }, (_, i) => [`#${i}`, mk(tree(4))]),
      { locals: [['local', '$t', 'f64']], helpers: ['__to_int32'], only: [I32.slice(0, 12), I32.slice(0, 8), [0, -0, 1, -1, 2 ** 31, 1e19, 2 ** 63, 2.5, NaN, Infinity].map(bitsOf)] })
}
// The domain of NO_WRAP for the tree a memarg fold leaves: the inputs where its access adds
// the offset to the address below 2^32 (an address of parameters, constants, sums and shifts).
const value = (n, a) => n[0] === 'local.get' ? a[Number(n[1].slice(2))] | 0 : n[0] === 'i32.const' ? immediate('i32.const', n[1])
  : n[0] === 'i32.add' ? (value(n[1], a) + value(n[2], a)) | 0 : n[0] === 'i32.shl' ? value(n[1], a) << value(n[2], a) : NaN
const access = (n) => !Array.isArray(n) ? null : /\.(load|store)/.test(n[0]) ? n : n.slice(1).map(access).find(Boolean) ?? null
const noWrap = (tree) => {
  const n = access(tree)
  let k = 1, offset = 0
  for (; typeof n[k] === 'string'; k++) if (n[k].startsWith('offset=')) offset = Number(n[k].slice(7))
  return (a) => (value(n[k], a) >>> 0) + offset < 2 ** 32
}
// fusedRewrite's walk: the constant of an address in its memarg, equal where the address sum does not wrap
{
  const KS = [0, 1, 4, 8, 100, 65528, 65535, 65536, 0x7fffffff, 4294967295, 2147483648, -4]
  const LOADS = ['i32.load', 'i64.load', 'f64.load', 'i32.load8_u', 'i32.load16_s']
  for (const ld of LOADS) {
    const result = ld.slice(0, 3)
    code(`memarg offset of ${ld}`, NO_WRAP, walk, ['addr'], result, table(a => {
      for (const K of KS) { a(K, [ld, ['i32.add', g(0), c(K)]]); a(K, [ld, ['i32.add', c(K), g(0)]]) }
      a('offset 8', [ld, 'offset=8', ['i32.add', g(0), c(16)]])
    }), { admit: noWrap })
  }
}
// fusedRewrite: byte stores of one word as its wider store, equal up to memory after a trap
{
  const W = g(1), at = (k) => ['i32.add', g(0), c(k)]
  code('merged byte stores (mergeByteStores)', AFTER_TRAP, walk, ['addr', 'i32'], null, [
    ['2 x store8', ['block', ['i32.store8', g(0), W], ['i32.store8', at(1), ['i32.shr_u', W, c(8)]]]],
    ['2 x store8 offset', ['block', ['i32.store8', 'offset=2', g(0), W], ['i32.store8', 'offset=3', g(0), ['i32.shr_u', W, c(8)]]]],
    ['4 x store8', ['block', ['i32.store8', g(0), W], ['i32.store8', at(1), ['i32.shr_u', W, c(8)]], ['i32.store8', at(2), ['i32.shr_u', W, c(16)]], ['i32.store8', at(3), ['i32.shr_u', W, c(24)]]]],
    ['4 x store8 masked', ['block', ['i32.store8', g(0), ['i32.and', W, c(255)]], ['i32.store8', at(1), ['i32.and', ['i32.shr_u', W, c(8)], c(255)]], ['i32.store8', at(2), ['i32.and', ['i32.shr_u', W, c(16)], c(255)]], ['i32.store8', at(3), ['i32.and', ['i32.shr_u', W, c(24)], c(255)]]]],
    ['2 x store16', ['block', ['i32.store16', g(0), W], ['i32.store16', at(2), ['i32.shr_u', W, c(16)]]]],
    ['2 x store8 shr_s', ['block', ['i32.store8', g(0), W], ['i32.store8', at(1), ['i32.shr_s', W, c(8)]]]],
    ['shl address', ['block', ['i32.store8', ['i32.shl', g(0), c(2)], W], ['i32.store8', ['i32.add', ['i32.shl', g(0), c(2)], c(1)], ['i32.shr_u', W, c(8)]]]],
  ])
}
// fusedRewrite's walk: the runtime's truthiness, inline (valueTruthyIR), against its body
code('truthiness inline', EXACT, walk, ['box'], 'i32', [['local', ['block', ['result', 'i32'], ['local.set', '$v', ['f64.reinterpret_i64', g(0)]], ['call', '$__is_truthy', ['i64.reinterpret_f64', ['local.get', '$v']]]]]],
  { locals: [['local', '$v', 'f64']], helpers: ['__is_truthy'], only: [[...BOX, ...F64, 0x7ff8000000000000n | (4n << 47n), 0x7ff8000000000000n | (4n << 47n) | 0x100n]] })
// fusedRewrite's walk: the low word of a pointer made by $__mkptr, as the offset it was made from (abi/number.js)
code('mkptr offset (nanboxF64.peephole)', EXACT, walk, ['i32', 'i32'], 'i32', [
  ['call', ['i32.wrap_i64', ['i64.reinterpret_f64', ['call', '$__mkptr', c(4), g(1), g(0)]]]],
  ['block', ['i32.wrap_i64', ['i64.reinterpret_f64', ['block', ['result', 'f64'], ['global.set', '$g', g(1)], ['call', '$__mkptr', c(1), c(0), g(0)]]]]],
], { helpers: ['__mkptr'] })
// watr's simplifyCast, which the walk asks: cast round trips of depth two over every type
{
  const CASTS = { i32: ['i64.extend_i32_s', 'i64.extend_i32_u', 'f64.convert_i32_s', 'f64.convert_i32_u', 'f32.reinterpret_i32', 'f64.convert_i32_u'],
    i64: ['i32.wrap_i64', 'f64.reinterpret_i64', 'f64.convert_i64_s'], f64: ['i64.reinterpret_f64', 'i32.trunc_sat_f64_s', 'i32.trunc_sat_f64_u', 'i64.trunc_sat_f64_s', 'f32.demote_f64', 'f64.floor', 'f64.trunc'],
    f32: ['i32.reinterpret_f32', 'f64.promote_f32'] }
  const out = (op) => op.slice(0, 3)
  for (const t of ['i32', 'f64']) {
    const trees = []
    for (const a of CASTS[t]) for (const b of CASTS[out(a)] || []) trees.push([`${b}(${a})`, [b, [a, g(0)]], out(b)])
    for (const r of ['i32', 'i64', 'f64']) {
      const of = trees.filter(x => x[2] === r)
      if (of.some(([, b]) => { const fn = ['func', '$f', ['param', '$x0', t], ['result', r], clone(b)]; fusedRewrite(fn); return printTree(fn[4]) !== printTree(b) }))
        code(`cast round trips from ${t} to ${r} (simplifyCast)`, EXACT, walk, [t], r, of.map(([l, b]) => [l, b]))
    }
  }
}
// boolConvertToSelect: a Boolean added or subtracted as a select of the two sums
{
  const conds = [['lt', ['i32.lt_s', g(1), g(2)]], ['eqz', ['i32.eqz', g(1)]], ['f64.lt', ['f64.lt', g(0), f(1)]]]
  code('a Boolean addend as a select (boolConvertToSelect)', NAN, boolConvertToSelect, ['f64', 'i32', 'i32'], 'f64', table(a => {
    for (const [cn, C] of conds) for (const cv of ['f64.convert_i32_s', 'f64.convert_i32_u']) {
      a(`x - ${cn}`, ['f64.sub', g(0), [cv, C]]); a(`x + ${cn}`, ['f64.add', g(0), [cv, C]]); a(`${cn} + x`, ['f64.add', [cv, C], g(0)])
    }
  }), { only: [F64, [0, 1, -1, 2], [0, 1, -1, 2]] })
}
// foldV128Memargs and refoldMemargs: the memarg fold of the lane lift's accesses and of narrowed addresses
code('memarg offset of a v128 access (foldV128Memargs)', NO_WRAP, foldV128Memargs, ['addr'], 'i32', table(a => {
  for (const K of [0, 4, 16, 65520, 4294967295, -16]) { a(K, ['i32x4.extract_lane', 1, ['v128.load', ['i32.add', g(0), c(K)]]]); a(K, ['i32x4.extract_lane', 2, ['v128.load', ['i32.add', c(K), g(0)]]]) }
}), { admit: noWrap })
{
  const KS = [0, 1, 4, 8, 100, -1, -4, -8, 0x7fffffff, -0x80000000, 4294967295, 65528], SS = [0, 2, 3, 31]
  const trees = []
  for (const ld of ['i32.load', 'f64.load']) for (const K of KS) for (const S of SS) {
    const scaled = ['i32.shl', ['i32.add', g(0), c(K)], c(S)]
    trees.push([`(x + ${K}) << ${S}`, [ld, scaled]], [`((x + ${K}) << ${S}) + y`, [ld, ['i32.add', scaled, g(1)]]], [`y + ((x + ${K}) << ${S}) + ${K}`, [ld, ['i32.add', ['i32.add', g(1), scaled], c(K)]]])
  }
  for (const r of ['i32', 'f64'])
    code(`memarg offset of a narrowed address, ${r} (refoldMemargs)`, NO_WRAP, refoldMemargs, ['addr', 'addr'], r, trees.filter(([, t]) => t[0].startsWith(r)), { admit: noWrap })
}
// foldLoadCasts: an f64 local only loaded and read as bits, an i64 local
code('a local of loaded bits (foldLoadCasts)', EXACT, foldLoadCasts, ['addr', 'addr'], 'i64', [
  ['loaded, read as bits', ['block', ['result', 'i64'], ['local.set', '$l', ['f64.load', g(0)]], ['i64.add', ['i64.reinterpret_f64', ['local.get', '$l']], ['i64.reinterpret_f64', ['local.get', '$l']]]]],
  ['two loads', ['block', ['result', 'i64'], ['local.set', '$l', ['f64.load', g(0)]], ['if', ['i32.eqz', g(1)], ['then', ['local.set', '$l', ['f64.load', 'offset=8', g(1)]]]], ['i64.reinterpret_f64', ['local.get', '$l']]]],
], { locals: [['local', '$l', 'f64']] })
// holdWordNumbers: an i32 local of exact word truncations read only converted back, the number (emit's mark `wordOf`, supplied)
{
  const word = (x) => { const t = ['i32.trunc_sat_f64_s', x]; t.wordOf = x; return t }
  code('a word held as its number (holdWordNumbers)', EXACT, holdWordNumbers, ['f64', 'f64'], 'f64', [
    ['one write', ['block', ['result', 'f64'], ['local.set', '$w', word(g(0))], ['f64.add', ['f64.convert_i32_s', ['local.get', '$w']], f(0.25)]]],
    ['two writes', ['block', ['result', 'f64'], ['local.set', '$w', word(g(0))], ['if', ['f64.lt', g(1), f(0)], ['then', ['local.set', '$w', word(g(1))]]], ['f64.convert_i32_s', ['local.get', '$w']]]],
  ], { locals: [['local', '$w', 'i32']], only: [[0, 1, -1, 7, 2 ** 31 - 1, -(2 ** 31), 100000].map(bitsOf), [0, -1, 3, -(2 ** 31)].map(bitsOf)] })
}
// lowerToInt32Tails: the exact conversion inline below 2^63, the runtime's kernel past it
code('ToInt32 tails inline (lowerToInt32Tails)', EXACT, lowerToInt32Tails, ['f64'], 'i32', [
  ['leaf', ['call', '$__to_int32', g(0)]], ['expression', ['call', '$__to_int32', ['f64.mul', g(0), f(3)]]],
], { helpers: ['__to_int32'] })
// guardToInt32 (to-int32.js): the truncations in their magnitude and their 1.5·2^52 forms
for (const add of [false, true]) {
  const x = g(0), MAGIC = f(6755399441055744)
  const pass = (m) => guardToInt32(m, add)
  // (the exact form holds for |x| < 2^63, README "Bitwise operands under 2^63")
  code(`ToInt32 exact form, ${add ? 'add' : 'magnitude'} mode (guardToInt32)`, EXACT, pass, ['f64'], 'i32', [
    ['exact', ['select', ['i32.wrap_i64', ['i64.trunc_sat_f64_s', x]], c(0), ['f64.ne', x, f(Infinity)]]],
  ], { module: true, admit: () => (a) => { i64[0] = a[0]; return !(Math.abs(f64[0]) >= 2 ** 63) } })
  if (add) code('ToInt32 truncations, add mode (guardToInt32)', EXACT, pass, ['f64'], 'i32', [
    ['wide', ['i32.wrap_i64', ['i64.trunc_sat_f64_s', x]]],
    ['key test', ['f64.eq', ['f64.convert_i32_s', ['i32.wrap_i64', ['i64.trunc_sat_f64_s', x]]], x]],
  ], { module: true })
  // (a NaN's sign and payload aside: the sum's low word is read only where the test of its exponent passes, no NaN's)
  if (add) code('ToInt32 rounding plus 1.5·2^52, add mode (guardToInt32)', NAN, pass, ['f64'], 'f64', ['f64.trunc', 'f64.floor', 'f64.ceil', 'f64.nearest'].map(o => [o, ['f64.add', [o, x], MAGIC]]), { module: true })
}
// foldWrappedWords (int-narrow.js): a wrapped word operation, a word rounded back through 1.5·2^52
{
  const e = (k) => ['i64.extend_i32_s', g(k)], eu = (k) => ['i64.extend_i32_u', g(k)], MAGIC = f(6755399441055744)
  code('wrapped word operations (foldWrappedWords)', EXACT, foldWrappedWords, ['i32', 'i32'], 'i32', table(a => {
    for (const op of ['i64.add', 'i64.sub', 'i64.mul']) {
      a(`${op} s s`, ['i32.wrap_i64', [op, e(0), e(1)]]); a(`${op} s u`, ['i32.wrap_i64', [op, e(0), eu(1)]])
      for (const k of [0, 1, -1, 0x7fffffff, -0x7fffffff, 2147483648, 4294967295, -2147483648]) a(`${op} s ${k}`, ['i32.wrap_i64', [op, e(0), ['i64.const', k]]])
    }
  }), { module: true })
  const cs = [['s', ['f64.convert_i32_s', g(0)]], ['u', ['f64.convert_i32_u', g(0)]], ['trunc s', ['f64.trunc', ['f64.convert_i32_s', g(0)]]]]
  code('a word rounded back (foldWrappedWords)', EXACT, foldWrappedWords, ['i32'], 'i32', cs.map(([n, k]) => [n, ['i32.wrap_i64', ['i64.reinterpret_f64', ['f64.add', k, MAGIC]]]]), { module: true })
  code('a wide word rounded back (foldWrappedWords)', EXACT, foldWrappedWords, ['i32'], 'i64', cs.slice(0, 2).map(([n, k]) => [n, ['i64.sub', ['i64.reinterpret_f64', ['f64.add', k, MAGIC]], ['i64.const', '0x4338000000000000']]]), { module: true })
}
// fold (fold.js), on the tape: constant comparisons, a finite value against NaN or an infinity, and/or/eqz/select of constants
{
  const onTape = (fn) => { resetTape(); const id = fromWat(fn); fold(id); const out = toWat(id); fn.length = 0; fn.push(...out) }
  const KS = [0, -0, 1, -1, 2.5, NaN, Infinity, -Infinity, 1e300, 5e-324]
  code('constant comparisons (fold)', EXACT, onTape, [], 'i32', table(a => { for (const op of ['eq', 'ne', 'lt', 'gt', 'le', 'ge']) for (const x of KS) for (const y of KS) a(`${op} ${x} ${y}`, [`f64.${op}`, f(x), f(y)]) }))
  code('a finite value against NaN or an infinity (fold)', EXACT, onTape, ['i32', 'f64'], 'i32', table(a => {
    for (const op of ['f64.eq', 'f64.ne']) for (const k of [Infinity, -Infinity, NaN, 'nan:0x7ff8000200000000']) for (const v of [['f64.convert_i32_s', g(0)], ['f64.convert_i32_u', g(0)], f(3), g(1), f(Infinity)]) {
      a(`${op} ${printTree(v)} ${k}`, [op, v, f(k)]); a(`${op} ${k} ${printTree(v)}`, [op, f(k), v])
    }
  }))
  code('and, or, eqz and select of constants (fold)', EXACT, onTape, ['i32', 'i32'], 'i32', table(a => {
    for (const op of ['i32.and', 'i32.or']) for (const k of [0, -1, 1, 255]) for (const x of [g(0), ['i32.lt_s', g(0), c(0)], ['i32.eqz', g(0)], ['i32.load8_u', c(0)]]) { a(`${op} x ${k}`, [op, x, c(k)]); a(`${op} ${k} x`, [op, c(k), x]) }
    for (const k of [0, 1, -1]) { a(`eqz ${k}`, ['i32.eqz', c(k)]); a(`select ${k}`, ['select', g(0), g(1), c(k)]); a(`select of a division ${k}`, ['select', ['i32.div_s', g(0), g(1)], g(1), c(k)]); a(`select of a remainder ${k}`, ['select', g(0), ['i32.rem_u', g(0), g(1)], c(k)]) }
  }))
}
// the passes after watr: trunc-choice, mask-operands, shift-remainder, unsigned division by intervals
{
  const x = g(0)
  for (const t of ['f64', 'f32']) code(`a rounding chosen by sign as the truncation, ${t} (truncChoice)`, EXACT, truncChoice, [t], t, table(a => {
    for (const cmp of ['lt', 'le', 'gt', 'ge']) for (const [A, B] of [['ceil', 'floor'], ['floor', 'ceil'], ['trunc', 'floor']]) {
      a(`select ${cmp} ${A}/${B}`, ['select', [`${t}.${A}`, x], [`${t}.${B}`, x], [`${t}.${cmp}`, x, [`${t}.const`, 0]]])
      a(`if ${cmp} ${A}/${B}`, ['if', ['result', t], [`${t}.${cmp}`, x, [`${t}.const`, 0]], ['then', [`${t}.${A}`, x]], ['else', [`${t}.${B}`, x]]])
    }
  }), { module: true })
  const ys = [['byte', ['i32.and', g(1), c(255)]], ['load8_u', ['i32.load8_u', c(0)]], ['flag', ['i32.lt_s', g(1), g(2)]], ['shr_u 24', ['i32.shr_u', g(1), c(24)]], ['plain', g(1)], ['const 0x1ff', c(0x1ff)], ['const -1', c(-1)]]
  code('mask operands ((x op y) & M, maskOperands)', EXACT, maskOperands, ['i32', 'i32', 'i32'], 'i32', table(a => {
    for (const op of ['i32.xor', 'i32.or']) for (const M of [255, 65535]) for (const [yn, y] of ys) for (const [zn, z] of ys) { a(`(x ${op} ${yn}) & ${M}`, ['i32.and', [op, x, y], c(M)]); a(`${M} & (${yn} ${op} ${zn})`, ['i32.and', c(M), [op, y, z]]) }
  }), { module: true })
  code('a remainder by a power of two (foldShiftRemainder)', EXACT, foldShiftRemainder, ['i32', 'i32'], 'i32', table(a => {
    for (const sh of ['i32.shr_u', 'i32.shr_s']) for (const k of [1, 8, 24, 31]) {
      a(`${sh} ${k}`, ['i32.sub', x, ['i32.shl', [sh, x, c(k)], c(k)]]); a(`mul ${sh} ${k}`, ['i32.sub', x, ['i32.mul', [sh, x, c(k)], c(2 ** k | 0)]])
      a(`mismatched ${sh} ${k}`, ['i32.sub', x, ['i32.shl', [sh, x, c(k)], c(k - 1)]])
      a(`quotient held ${sh} ${k}`, ['block', ['result', 'i32'], ['local.set', '$q', [sh, x, c(k)]], ['i32.sub', x, ['i32.shl', ['local.get', '$q'], c(k)]]])
      a(`x written between ${sh} ${k}`, ['block', ['result', 'i32'], ['local.set', '$q', [sh, x, c(k)]], ['local.set', '$x0', ['i32.add', x, c(1)]], ['i32.sub', x, ['i32.shl', ['local.get', '$q'], c(k)]]])
    }
  }), { locals: [['local', '$q', 'i32']] })
  const xs = [['x & 0x7fffffff', ['i32.and', x, c(0x7fffffff)]], ['load8_u', ['i32.load8_u', c(0)]], ['shr_u 1', ['i32.shr_u', x, c(1)]], ['plain', x], ['shr_u 32', ['i32.shr_u', x, c(32)]]]
  const ds = [['3', c(3)], ['1', c(1)], ['-3', c(-3)], ['0', c(0)], ['(y & 255) | 1', ['i32.or', ['i32.and', g(1), c(255)], c(1)]], ['plain', g(1)], ['2^31', c(-0x80000000)]]
  code('a division of non-negative words as unsigned (unsignedDivision)', EXACT, unsignedDivision, ['i32', 'i32'], 'i32', table(a => {
    for (const op of ['i32.div_s', 'i32.rem_s']) for (const [xn, X] of xs) for (const [dn, D] of ds) a(`${xn} ${op} ${dn}`, [op, X, D])
  }), { module: true })
}
// select-bits and select-arms (after watr): a float select as an integer one, two arms as one tree over selects
{
  const conds = [['bit', ['i32.and', g(2), c(1)]], ['lt', ['f64.lt', g(0), g(1)]], ['ge', ['f64.ge', g(0), g(1)]], ['ne', ['f64.ne', g(0), g(1)]]]
  const arms = [['x, y', g(0), g(1)], ['y, x', g(1), g(0)], ['x, -x', g(0), ['f64.neg', g(0)]], ['x, 0.5', g(0), f(0.5)], ['-0, y', f(-0), g(1)]]
  for (const simd of [true, false]) code(`a float select by its bits, simd ${simd} (selectBits)`, EXACT, (m) => selectBits(m, { simd }), ['f64', 'f64', 'i32'], 'f64', table(a => {
    for (const [cn, C] of conds) for (const [an, A, B] of arms) a(`${cn} ? ${an}`, ['select', A, B, C])
  }), { module: true, only: [F64, F64.slice(0, 20), [0, 1, 2]] })
  const R = (n) => (rnd() * n) | 0, leaves = [g(0), g(1), f(0.5), f(-0.5), f(0), f(-0), f(3.25)]
  const pair = (d, holes) => {
    if (d === 0 || rnd() < 0.25) { if (rnd() < 0.5 && holes.n < 2) { holes.n++; return [leaves[R(7)], leaves[R(7)]] } const l = leaves[R(7)]; return [l, l] }
    const k = R(6), [a1, b1] = pair(d - 1, holes)
    if (k < 3) { const op = ['f64.add', 'f64.sub', 'f64.mul'][k], [a2, b2] = pair(d - 1, holes); return [[op, a1, a2], [op, b1, b2]] }
    if (k === 3) { const o = ['f64.trunc', 'f64.floor', 'f64.neg', 'f64.abs', 'f64.sqrt'][R(5)]; return [[o, a1], [o, b1]] }
    if (k === 4) { const kk = [0.5, 1, 0, -0][R(4)]; return [['f64.add', a1, f(-kk)], ['f64.sub', b1, f(kk)]] }
    return [['f64.ceil', a1], ['f64.floor', b1]]
  }
  code('two arms as one tree over selects (selectArms)', EXACT, selectArms, ['f64', 'f64'], 'f64', Array.from({ length: 600 }, (_, i) => {
    const [A, B] = pair(3, { n: 0 }), C = [['f64.lt', g(0), f(0)], ['f64.gt', g(0), g(1)], ['i32.and', ['i32.trunc_sat_f64_s', g(1)], c(1)]][R(3)]
    return [`#${i}`, ['if', ['result', 'f64'], C, ['then', A], ['else', B]]]
  }), { module: true, only: [F64.slice(0, 24), F64.slice(0, 24)] })
}
// narrowInts (int-narrow.js): Number arithmetic its intervals show integral as integer arithmetic, a
// test they answer as its answer, a truncation they bound without its guard, an f64 local of integers
// as an integer local. The facts are the pass's own intervals of the function, over random trees of
// words (masked to bound them, or whole), sums, differences, products, selects and tests of them.
for (const words of ['wide', 'add']) {
  const R = (n) => (rnd() * n) | 0
  const leaf = () => [['f64.convert_i32_s', ['i32.and', g(0), c([255, 65535, 7][R(3)])]], ['f64.convert_i32_u', ['i32.shr_u', g(1), c([1, 8, 20][R(3)])]],
    ['f64.convert_i32_s', g(0)], ['f64.convert_i32_s', g(1)], f([0, 1, -1, 3, 1000, 2 ** 31, 2 ** 40][R(7)]), ['local.get', '$a']][R(6)]
  const num = (d) => {
    if (d === 0 || rnd() < 0.25) return leaf()
    const k = R(6), sub = () => num(d - 1)
    return k < 3 ? [['f64.add', 'f64.sub', 'f64.mul'][k], sub(), sub()] : k === 3 ? ['select', sub(), sub(), test(d - 1)]
      : k === 4 ? ['if', ['result', 'f64'], test(d - 1), ['then', sub()], ['else', sub()]] : ['f64.neg', sub()]
  }
  const test = (d) => [['f64.lt', 'f64.ge', 'f64.eq', 'f64.ne'][R(4)], num(Math.min(d, 1)), num(Math.min(d, 1))]
  const tops = [
    (e) => ['block', ['result', 'f64'], ['local.set', '$a', ['f64.convert_i32_s', ['i32.and', g(1), c(1023)]]], e],
    (e) => ['block', ['result', 'i32'], ['local.set', '$a', ['f64.convert_i32_s', ['i32.and', g(1), c(1023)]]], ['i32.wrap_i64', ['i64.trunc_sat_f64_s', e]]],
    (e) => ['block', ['result', 'i32'], ['local.set', '$a', ['f64.convert_i32_s', ['i32.and', g(1), c(1023)]]], ['i32.trunc_sat_f64_s', e]],
    (e) => ['block', ['result', 'i32'], ['local.set', '$a', ['f64.convert_i32_s', ['i32.and', g(1), c(1023)]]], test(2)],
  ]
  tops.forEach((top, t) => code(`integer arithmetic of Numbers, ${['a Number', 'a wide truncation', 'a word truncation', 'a test'][t]}, words ${words} (narrowInts)`, EXACT,
    (fn) => narrowInts(fn, null, true, words), ['i32', 'i32'], t ? 'i32' : 'f64', Array.from({ length: 150 }, (_, i) => [`#${i}`, top(num(3))]),
    { locals: [['local', '$a', 'f64']], only: [I32.slice(0, 30), I32.slice(0, 30)] }))
}
// narrowFloat32: a float operation on promoted f32s, demoted, as the f32 operation
{
  const P = (i) => ['f64.promote_f32', g(i)]
  code('f32 arithmetic through f64 (narrowFloat32)', NAN, narrowFloat32, ['f32', 'f32'], 'f32', table(a => {
    for (const op of ['add', 'sub', 'mul', 'div', 'min', 'max', 'copysign']) a(op, ['f32.demote_f64', [`f64.${op}`, P(0), P(1)]])
    for (const op of ['sqrt', 'neg', 'abs', 'floor', 'ceil', 'trunc', 'nearest']) a(op, ['f32.demote_f64', [`f64.${op}`, P(0)]])
    for (const op of ['add', 'mul']) for (const k of [0.5, 0.1, 3, 1e39, 16777217, NaN]) a(`${op} ${k}`, ['f32.demote_f64', [`f64.${op}`, P(0), f(k)]])
    for (const o1 of ['add', 'mul', 'div']) for (const o2 of ['add', 'sub']) a(`${o2}(${o1})`, ['f32.demote_f64', [`f64.${o2}`, [`f64.${o1}`, P(0), P(1)], P(0)]])
  }), {})
  code('f32 comparisons through f64 (narrowFloat32)', EXACT, narrowFloat32, ['f32', 'f32'], 'i32', ['eq', 'ne', 'lt', 'gt', 'le', 'ge'].map(op => [op, [`f64.${op}`, P(0), P(1)]]))
}
// stripDeadCanons (nan-canon.js): a NaN's canonicalization dropped where no consumer reads its bits
{
  const L = (n) => ['local.get', n], X = ['f64.reinterpret_i64', g(0)], bits = (e) => ['i64.reinterpret_f64', e]
  const canon = (e, t) => ['block', ['result', 'f64'], ['local.set', t, e], ['select', f('nan'), L(t), ['f64.ne', L(t), L(t)]]]
  const trees = []
  for (const op of ['f64.add', 'f64.mul', 'f64.min']) trees.push([`canon(${op}(canon x, y))`, bits(canon([op, canon(X, '$t1'), g(1)], '$t2'))])
  for (const op of ['f64.neg', 'f64.abs', 'f64.floor']) trees.push([`${op}(canon x)`, bits([op, canon(X, '$t1')])])
  trees.push(['copysign(canon x, y)', bits(['f64.copysign', canon(X, '$t1'), g(1)])], ['lt(canon x, y)', ['i64.extend_i32_u', ['f64.lt', canon(X, '$t1'), g(1)]]],
    ['trunc(canon x)', ['i64.trunc_sat_f64_s', canon(X, '$t1')]], ['through a local', ['block', ['result', 'i64'], ['local.set', '$u', canon(X, '$t1')], bits(canon(['f64.add', L('$u'), g(1)], '$t2'))]])
  code('canonical NaNs no consumer reads (stripDeadCanons)', EXACT, stripDeadCanons, ['box', 'f64'], 'i64', trees,
    { locals: [['local', '$t1', 'f64'], ['local', '$t2', 'f64'], ['local', '$u', 'f64']], only: [[...BOX, BigInt.asIntN(64, 0xfff8000000000001n), 0x7ff4000000000000n], F64.slice(0, 12)] })
}
