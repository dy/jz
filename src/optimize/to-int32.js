// ToInt32 of a number of unknown range, as the IR writes it: the low word of
// its 64-bit truncation, Infinity taken to zero
//   (select (i32.wrap_i64 (i64.trunc_sat_f64_s x)) (i32.const 0) (f64.ne x inf))
// exact for every number. On x64 V8 runs the 64-bit truncation at several times
// the cost of the 32-bit one (bench/lowering.mjs), and a number nearly always
// lies inside the 32-bit range, where the 32-bit truncation is the integer. One
// test of the magnitude takes that path and keeps the exact form for the rest
// (NaN fails the test and reads zero there).
// With `add` (wordTruncation: 'add') the path is wider and has no conversion at
// all: within ±2^51 the truncation plus 1.5·2^52 holds the integer in its low
// bits. The sum itself is the test: it is exact, with the exponent 52, exactly
// where the truncation lies in [-2^51, 2^51), and NaN, ±Infinity and anything
// past read another. Testing its bits takes integer instructions where a test
// of the magnitude took two floating-point ones (the absolute value and its
// comparison), and a floating-point loop issues those on the pipes its own
// arithmetic queues for: V8's arm64 code runs a pixel's ToInt32 in three
// floating-point instructions instead of five (bench/lowering.mjs). The same
// test guards every other 64-bit truncation, and an element key's exactness
// test takes the sum's bits as its word.
// The rounding in that sum is what x64 charges for: `roundsd` writes the low half
// of its destination and keeps the upper one, so it waits on whatever last wrote that
// register, and V8 picks the destination without regard to that. Where the number
// dies at the rounding, V8 rounds it in its own register; where it lives on, in a
// loop the register is often the iteration's last result, and the next index waits
// for it: resample ran 2.4× slower on every x64 model, none of it on arm64. (The
// magnitude test escaped this by accident: the register the rounding took held the
// test's own operand, the absolute value or the bound, written just before.) So a
// number read after its rounding is rounded through its negation, a value made to
// die there, and a number made for its conversion takes the truncation into its own
// local, the test's other arm reading that in its place.
// It runs after watr: every pass before reads the exact form. The functions are
// then whole, with the bodies watr inlined, and their intervals
// (optimize/int-range.js) bound what a helper's parameter could not: a number
// within ±2^51 that is never NaN takes the add with no test (a saturating
// truncation too, where its interval keeps it inside the word), and an integer
// takes it with no truncation.

import { intRanges } from './int-range.js'

const isArr = Array.isArray
const isInf = n => isArr(n) && n[0] === 'f64.const' && (n[1] === Infinity || /^\+?inf$/i.test(String(n[1])))
const isZero = n => isArr(n) && n[0] === 'i32.const' && Number(n[1]) === 0

/** The local the exact form reads its number from, where `n` is that form. */
const exactForm = n => {
  if (!isArr(n) || n[0] !== 'select' || n.length !== 4 || !isZero(n[2])) return null
  const [, w, , c] = n
  if (!isArr(w) || w[0] !== 'i32.wrap_i64' || !isArr(w[1]) || w[1][0] !== 'i64.trunc_sat_f64_s') return null
  if (!isArr(c) || c[0] !== 'f64.ne' || !isInf(c[2]) || !isArr(c[1]) || c[1][0] !== 'local.get') return null
  const x = w[1][1], name = c[1][1]
  return isArr(x) && (x[0] === 'local.tee' || x[0] === 'local.get') && x[1] === name ? { x, name } : null
}

const MAGIC = () => ['f64.const', 6755399441055744], NEAR = 2 ** 51
const isMagic = n => isArr(n) && n[0] === 'f64.const' && Number(n[1]) === 6755399441055744
const isRead = n => isArr(n) && (n[0] === 'local.get' || n[0] === 'local.tee')
// each rounding's image under negation: -floor(x) is ceil(-x), and the sum subtracts it
const MIRROR = { 'f64.trunc': 'f64.trunc', 'f64.nearest': 'f64.nearest', 'f64.floor': 'f64.ceil', 'f64.ceil': 'f64.floor' }
// Whether x stays in its register past a rounding of it: a read of a local, or a
// write of one something else reads. (`s.read`: the locals so read, guardToInt32.)
const outlives = (x, s) => isRead(x) && (x[0] === 'local.get' || s.read.has(x[1]) || isRead(x[2]))
// `op` of x plus 1.5·2^52: that of x's negation subtracted where x outlives the rounding
const rounded = (op, x, s, add = MAGIC()) => outlives(x, s) ? ['f64.sub', add, [MIRROR[op], ['f64.neg', x]]] : ['f64.add', [op, x], add]
// the sum for x (`whole`: x is an integer already, its own truncation)
const sum = (x, s, whole) => whole ? ['f64.add', x, MAGIC()] : rounded('f64.trunc', x, s)
// the integer of x (|x| < 2^51, no NaN) in its word or its 64 bits, by the add
const added = (x, w, s, whole = false) => {
  const bits = ['i64.reinterpret_f64', sum(x, s, whole)]
  return w === 'i32' ? ['i32.wrap_i64', bits] : ['i64.sub', bits, ['i64.const', '0x4338000000000000']]
}
// Whether x truncates into [-2^51, 2^51), the bits of its truncation plus 1.5·2^52 teed
// into the i64 local `b`: the sum then lies in [2^52, 2^53), exact, and its exponent field
// reads 0x433 (52 biased); a sum anywhere else, NaN or ±Infinity reads another. A local
// nothing else reads takes the truncation, so the number dies at the rounding: the arm
// the test fails to reads that local, and its forms answer alike for x and x's truncation.
const inNear = (b, x, s, whole = false) => {
  if (!whole && x[0] === 'local.tee' && !outlives(x, s)) x = ['local.tee', x[1], ['f64.trunc', x[2]]], whole = true
  return ['i64.eq', ['i64.shr_u', ['local.tee', b, ['i64.reinterpret_f64', sum(x, s, whole)]], ['i64.const', 52]], ['i64.const', 0x433]]
}
// what `inNear` holds in `b`, as the word or the 64 bits
const nearWord = (b, w) => w === 'i32' ? ['i32.wrap_i64', ['local.get', b]] : ['i64.sub', ['local.get', b], ['i64.const', '0x4338000000000000']]
// the word or 64 bits a truncation keeps, where `n` is one: [operand slot, width]
const wideOf = n => isArr(n) && n[0] === 'i32.wrap_i64' && isArr(n[1]) && n[1][0] === 'i64.trunc_sat_f64_s' ? { of: n[1], w: 'i32' }
  : isArr(n) && n[0] === 'i64.trunc_sat_f64_s' ? { of: n, w: 'i64' } : null
// the range a saturating truncation keeps inside its word, by its signedness
const SAT = new Map([['i32.trunc_sat_f64_s', [-(2 ** 31) - 1, 2 ** 31]], ['i32.trunc_sat_f64_u', [-1, 2 ** 32]]])
// a number never NaN strictly inside (lo, hi)
const inside = (v, lo, hi) => !!v && !v.nan && v.lo > lo && v.hi < hi

const isSum = n => n[0] === 'f64.add' && n.length === 3 && isMagic(n[2]) && isArr(n[1]) && n[1][0] in MIRROR && n[1].length === 2

/** Lower `n`'s conversions; `s` is { add, temp, at, read } (`at`: the operand's interval or null). */
const lower = (n, s) => {
  if (!isArr(n)) return n
  const f = exactForm(n)
  if (f) {
    const v = s.at(f.x)
    if (f.x[0] === 'local.tee') f.x[2] = lower(f.x[2], s)
    if (inside(v, -NEAR, NEAR)) return s.add ? added(f.x, 'i32', s, v.int) : ['i32.wrap_i64', ['i64.trunc_sat_f64_s', f.x]]
    const get = () => ['local.get', f.name]
    const exact = ['select', ['i32.wrap_i64', ['i64.trunc_sat_f64_s', get()]], ['i32.const', 0], ['f64.ne', get(), ['f64.const', Infinity]]]
    // (new nodes throughout: the form may be shared, and its other reader keeps its tee)
    if (s.add) { const b = s.temp('i64'); return ['if', ['result', 'i32'], inNear(b, f.x, s, v?.int), ['then', nearWord(b, 'i32')], ['else', exact]] }
    return ['if', ['result', 'i32'], ['f64.lt', ['f64.abs', f.x], ['f64.const', 2147483648]], ['then', ['i32.trunc_sat_f64_s', get()]], ['else', exact]]
  }
  // A 64-bit truncation, or the word of one, with `add`: the add where its
  // interval keeps it within ±2^51, else the add where a test finds it there and
  // the truncation itself past it (NaN fails the test and truncates to zero there).
  const wide = s.add && wideOf(n)
  if (wide) {
    const v = s.at(wide.of[1])
    const x = wide.of[1] = lower(wide.of[1], s)
    if (inside(v, -NEAR, NEAR)) return added(x, wide.w, s, v.int)
    const t = isArr(x) && (x[0] === 'local.get' || x[0] === 'local.tee') ? x[1] : s.temp()
    const get = () => ['local.get', t], first = isArr(x) && x[0] === 'local.get' ? x : ['local.tee', t, x[0] === 'local.tee' ? x[2] : x]
    const b = s.temp('i64')
    return ['if', ['result', wide.w], inNear(b, first, s, v?.int), ['then', nearWord(b, wide.w)],
      ['else', wide.w === 'i32' ? ['i32.wrap_i64', ['i64.trunc_sat_f64_s', get()]] : ['i64.trunc_sat_f64_s', get()]]]
  }
  // A saturating truncation whose interval stays inside the word saturates nowhere: the add.
  const sat = s.add && SAT.get(n[0])
  if (sat && n.length === 2) {
    const v = s.at(n[1])
    n[1] = lower(n[1], s)
    return inside(v, sat[0], sat[1]) ? added(n[1], 'i32', s, v.int) : n
  }
  // A sum narrowing wrote before watr, on a rounding its interval bounded.
  if (s.add && isSum(n)) {
    const [, r, add] = n
    r[1] = lower(r[1], s)
    return rounded(r[0], r[1], s, add)
  }
  for (let i = 0; i < n.length; i++) n[i] = lower(n[i], s)
  return n
}

// An element key's test, as keyIndex writes it: the key is an i32 integer
// exactly when its word, converted back, equals it
//   (f64.eq (f64.convert_i32_s [(local.tee $i] (i32.wrap_i64 (i64.trunc_sat_f64_s x)))) x)
// Any word that equals x for every i32 integer x answers alike, and x plus
// 1.5·2^52 read as bits is one: exact for those, while a fraction rounds, and
// NaN, ±Infinity and anything past ±2^51 leave a word no conversion maps back
// to x. The word itself stays the element's index only where the test holds
// (every read of it a `select` on the test's own local).
const sameRead = (a, b) => isArr(a) && isArr(b) && b[0] === 'local.get' && (a[0] === 'local.get' || a[0] === 'local.tee') && a[1] === b[1]
const keyTest = n => {
  if (!isArr(n) || n[0] !== 'f64.eq' || n.length !== 3) return null
  for (const [c, b] of [[n[1], n[2]], [n[2], n[1]]]) {
    if (!isArr(c) || c[0] !== 'f64.convert_i32_s') continue
    const tee = isArr(c[1]) && c[1][0] === 'local.tee' ? c[1] : null, w = tee ? tee[2] : c[1]
    if (!isArr(w) || w[0] !== 'i32.wrap_i64' || !isArr(w[1]) || w[1][0] !== 'i64.trunc_sat_f64_s' || !sameRead(w[1][1], b)) continue
    return { holder: tee ?? c, at: tee ? 2 : 1, word: tee?.[1] ?? null, x: w[1][1] }
  }
  return null
}

// `(f64.eq (f64.convert_i64_s (local.get w)) (local.get x))`, either way round: { w, x, conv }
const wideTest = n => {
  if (!isArr(n) || n[0] !== 'f64.eq' || n.length !== 3) return null
  for (const [c, b] of [[n[1], n[2]], [n[2], n[1]]]) {
    if (!isArr(c) || c[0] !== 'f64.convert_i64_s' || !isArr(c[1]) || c[1][0] !== 'local.get' || !isArr(b) || b[0] !== 'local.get') continue
    return { w: c[1][1], x: b[1], conv: c }
  }
  return null
}

const exactKeys = fn => {
  // each local's writes, and the reads with their parents
  const writes = new Map(), reads = new Map(), tests = []
  const wide = []   // a wide key's tests
  const walk = (n, parent) => {
    if (!isArr(n)) return
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') writes.set(n[1], [...writes.get(n[1]) ?? [], n])
    else if (n[0] === 'local.get' && typeof n[1] === 'string') reads.set(n[1], [...reads.get(n[1]) ?? [], parent])
    const t = keyTest(n)
    if (t) tests.push({ ...t, test: n, held: (parent?.[0] === 'local.set' || parent?.[0] === 'local.tee') && parent[2] === n ? parent[1] : null })
    const k = wideTest(n)
    if (k) wide.push(k)
    for (const c of n) walk(c, n)
  }
  for (let i = 2; i < fn.length; i++) walk(fn[i], fn)
  const wideKeys = new Set(wide.map(k => k.w)), wideTests = new Set(wide.map(k => k.conv))
  // (a word and its test's local travel together, loop copies included: every
  // write of either is such a test, and every read of the word selects on it)
  const paired = (word, held) => held != null &&
    writes.get(word).every(w => tests.some(t => t.word === word && t.held === held && t.holder === w)) &&
    writes.get(held).every(w => tests.some(t => t.word === word && t.held === held && w[2] === t.test)) &&
    (reads.get(word) ?? []).every(p => p?.[0] === 'select' && p[1]?.[0] === 'local.get' && p[1][1] === word && p[3]?.[0] === 'local.get' && p[3][1] === held)
  for (const t of tests) if (t.word == null || paired(t.word, t.held))
    t.holder[t.at] = ['i32.wrap_i64', ['i64.reinterpret_f64', ['f64.add', t.x, MAGIC()]]]
  // A checked access's wide key (emit/dispatch.js emitIndex): `w = trunc(x)`,
  // tested by `convert(w) == x` and met against the length in i64, its word
  // the address under both. Where both hold, w is x, whichever integer stands
  // in for a key no integer equals, so x plus 1.5·2^52 read as bits, less the
  // bias, serves: exact within ±2^51; past it, or for a fraction or NaN, a w
  // whose conversion is not x, or which no length admits. (The test reads the
  // value the write truncated; watr may have the two read it through different
  // locals, a copy or a shared slot, so the pair is told by w alone: written
  // only so, read only by these.)
  for (const [w, ws] of writes) {
    if (!wideKeys.has(w) || !ws.every(n => isArr(n[2]) && n[2][0] === 'i64.trunc_sat_f64_s' && isArr(n[2][1]) && (n[2][1][0] === 'local.get' || n[2][1][0] === 'local.tee'))) continue
    if (!(reads.get(w) ?? []).every(p => p?.[0] === 'i32.wrap_i64' || p?.[0] === 'i64.lt_u' && p[1]?.[0] === 'local.get' && p[1][1] === w || wideTests.has(p))) continue
    for (const n of ws) n[2] = ['i64.sub', ['i64.reinterpret_f64', ['f64.add', n[2][1], MAGIC()]], ['i64.const', '0x4338000000000000']]
  }
}

// Whether `n` holds a conversion the lowering rewrites.
const converts = (n, add) => isArr(n) && (exactForm(n) != null || (add && (wideOf(n) != null || (SAT.has(n[0]) && n.length === 2) || isSum(n))) || n.some(c => converts(c, add)))

// The locals read outside a conversion of a tee of their own, into `read`.
const readsOf = (n, read) => {
  if (!isArr(n)) return
  const tee = exactForm(n)?.x ?? wideOf(n)?.of[1]
  if (tee?.[0] === 'local.tee') return readsOf(tee[2], read)
  if (n[0] === 'local.get') read.add(n[1])
  for (const c of n) readsOf(c, read)
}

/** Guard each exact ToInt32 of `module`'s functions with the 32-bit path (`add`:
 *  the conversion-free one, which also answers each element key's test), and
 *  take the add with no test wherever the function's intervals bound the number. */
export function guardToInt32(module, add = false) {
  for (const node of module) if (isArr(node) && node[0] === 'func') {
    let k = 0, at = 2
    while (isArr(node[at]) && (node[at][0] === 'export' || node[at][0] === 'type' || node[at][0] === 'param' || node[at][0] === 'result' || node[at][0] === 'local')) at++
    let body = false
    for (let i = at; i < node.length && !body; i++) body = converts(node[i], add)
    if (!body) continue
    // (read before any rewrite: the intervals key the nodes the walk visited)
    const facts = intRanges(node, at)
    const av = facts?.av
    if (add) exactKeys(node)
    const decls = []
    const temp = (type = 'f64') => { const name = `$__w64_${k++}`; decls.push(['local', name, type]); return name }
    const read = new Set()
    for (let i = at; i < node.length; i++) readsOf(node[i], read)
    const s = { add, temp, read, at: x => av?.get(x) ?? null }
    for (let i = at; i < node.length; i++) node[i] = lower(node[i], s)
    node.splice(at, 0, ...decls)
  }
  return module
}
