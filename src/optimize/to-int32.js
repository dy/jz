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
// bits. The same test then guards every other 64-bit truncation, and an element
// key's exactness test takes the sum's bits as its word.
// It runs after watr: every pass before reads the exact form.

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

const MAGIC = () => ['f64.const', 6755399441055744], NEAR = () => ['f64.const', 2 ** 51]
// the integer of x (|x| < 2^51, no NaN) in its word or its 64 bits, by the add
const added = (x, w) => {
  const bits = ['i64.reinterpret_f64', ['f64.add', ['f64.trunc', x], MAGIC()]]
  return w === 'i32' ? ['i32.wrap_i64', bits] : ['i64.sub', bits, ['i64.const', '0x4338000000000000']]
}
const wideOf = n => isArr(n) && n[0] === 'i32.wrap_i64' && isArr(n[1]) && n[1][0] === 'i64.trunc_sat_f64_s' ? { x: n[1][1], w: 'i32' }
  : isArr(n) && n[0] === 'i64.trunc_sat_f64_s' ? { x: n[1], w: 'i64' } : null

const lower = (n, add, temp) => {
  if (!isArr(n)) return n
  const f = exactForm(n)
  if (f) {
    const get = () => ['local.get', f.name]
    // (new nodes throughout: the form may be shared, and its other reader keeps its tee)
    return ['if', ['result', 'i32'], ['f64.lt', ['f64.abs', f.x], add ? NEAR() : ['f64.const', 2147483648]],
      ['then', add ? added(get(), 'i32') : ['i32.trunc_sat_f64_s', get()]],
      ['else', ['select', ['i32.wrap_i64', ['i64.trunc_sat_f64_s', get()]], ['i32.const', 0], ['f64.ne', get(), ['f64.const', Infinity]]]]]
  }
  for (let i = 0; i < n.length; i++) n[i] = lower(n[i], add, temp)
  // Any other 64-bit truncation, with `add`: the add where |x| < 2^51, the
  // truncation itself past it (NaN fails the test and truncates to zero there).
  const wide = add && wideOf(n)
  if (!wide) return n
  const t = isArr(wide.x) && (wide.x[0] === 'local.get' || wide.x[0] === 'local.tee') ? wide.x[1] : temp()
  const get = () => ['local.get', t], first = isArr(wide.x) && wide.x[0] === 'local.get' ? wide.x : ['local.tee', t, wide.x[0] === 'local.tee' ? wide.x[2] : wide.x]
  return ['if', ['result', wide.w], ['f64.lt', ['f64.abs', first], NEAR()],
    ['then', added(get(), wide.w)],
    ['else', wide.w === 'i32' ? ['i32.wrap_i64', ['i64.trunc_sat_f64_s', get()]] : ['i64.trunc_sat_f64_s', get()]]]
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

const exactKeys = fn => {
  // each local's writes, and the reads with their parents
  const writes = new Map(), reads = new Map(), tests = []
  const walk = (n, parent) => {
    if (!isArr(n)) return
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') writes.set(n[1], [...writes.get(n[1]) ?? [], n])
    else if (n[0] === 'local.get' && typeof n[1] === 'string') reads.set(n[1], [...reads.get(n[1]) ?? [], parent])
    const t = keyTest(n)
    if (t) tests.push({ ...t, test: n, held: (parent?.[0] === 'local.set' || parent?.[0] === 'local.tee') && parent[2] === n ? parent[1] : null })
    for (const c of n) walk(c, n)
  }
  for (let i = 2; i < fn.length; i++) walk(fn[i], fn)
  // (a word and its test's local travel together, loop copies included: every
  // write of either is such a test, and every read of the word selects on it)
  const paired = (word, held) => held != null &&
    writes.get(word).every(w => tests.some(t => t.word === word && t.held === held && t.holder === w)) &&
    writes.get(held).every(w => tests.some(t => t.word === word && t.held === held && w[2] === t.test)) &&
    (reads.get(word) ?? []).every(p => p?.[0] === 'select' && p[1]?.[0] === 'local.get' && p[1][1] === word && p[3]?.[0] === 'local.get' && p[3][1] === held)
  for (const t of tests) if (t.word == null || paired(t.word, t.held))
    t.holder[t.at] = ['i32.wrap_i64', ['i64.reinterpret_f64', ['f64.add', t.x, MAGIC()]]]
}

/** Guard each exact ToInt32 of `module`'s functions with the 32-bit path (`add`:
 *  the conversion-free one, which also answers each element key's test). */
export function guardToInt32(module, add = false) {
  for (const node of module) if (isArr(node) && node[0] === 'func') {
    if (add) exactKeys(node)
    let k = 0, at = 2
    const decls = []
    while (isArr(node[at]) && (node[at][0] === 'export' || node[at][0] === 'type' || node[at][0] === 'param' || node[at][0] === 'result' || node[at][0] === 'local')) at++
    const temp = () => { const name = `$__w64_${k++}`; decls.push(['local', name, 'f64']); return name }
    for (let i = at; i < node.length; i++) node[i] = lower(node[i], add, temp)
    node.splice(at, 0, ...decls)
  }
  return module
}
