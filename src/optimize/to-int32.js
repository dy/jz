// ToInt32 of a number of unknown range, as the IR writes it: the low word of
// its 64-bit truncation, Infinity taken to zero
//   (select (i32.wrap_i64 (i64.trunc_sat_f64_s x)) (i32.const 0) (f64.ne x inf))
// exact for every number. On x64 the 64-bit truncation and its saturation checks
// cost twice the 32-bit one, and a number nearly always lies inside the 32-bit
// range, where the 32-bit truncation is the integer. One test of the magnitude
// takes that path and keeps the exact form for the rest (NaN fails the test and
// reads zero there). It runs after watr: every pass before reads the exact form.

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

const lower = n => {
  if (!isArr(n)) return n
  for (let i = 0; i < n.length; i++) n[i] = lower(n[i])
  const f = exactForm(n)
  if (!f) return n
  const get = () => ['local.get', f.name]
  // (new nodes throughout: the form may be shared, and its other reader keeps its tee)
  return ['if', ['result', 'i32'], ['f64.lt', ['f64.abs', f.x], ['f64.const', 2147483648]],
    ['then', ['i32.trunc_sat_f64_s', get()]],
    ['else', ['select', ['i32.wrap_i64', ['i64.trunc_sat_f64_s', get()]], ['i32.const', 0], ['f64.ne', get(), ['f64.const', Infinity]]]]]
}

/** Guard each exact ToInt32 of `module`'s functions with the 32-bit path. */
export function guardToInt32(module) {
  for (const node of module) if (isArr(node) && node[0] === 'func') for (let i = 2; i < node.length; i++) node[i] = lower(node[i])
  return module
}
