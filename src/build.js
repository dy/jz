// WAT instruction builders and type system
// Typed value: { t: type, wat: string }

export const tv = (t, wat) => ({ t, wat })

// --- Type coercions ---
export const asF64 = v =>
  v.t === 'f64' ? v :
  v.t === 'ref' ? tv('f64', '(f64.const 0)') :
  tv('f64', `(f64.convert_i32_s ${v.wat})`)

export const asI32 = v =>
  v.t === 'i32' ? v :
  v.t === 'ref' ? tv('i32', '(i32.const 0)') :
  tv('i32', `(i32.trunc_f64_s ${v.wat})`)

export const truthy = v =>
  v.t === 'ref' ? tv('i32', `(i32.eqz (ref.is_null ${v.wat}))`) :
  v.t === 'i32' ? tv('i32', `(i32.ne ${v.wat} (i32.const 0))`) :
  tv('i32', `(f64.ne ${v.wat} (f64.const 0))`)

export const conciliate = (a, b) =>
  a.t === 'i32' && b.t === 'i32' ? [a, b] : [asF64(a), asF64(b)]

// --- Number formatting ---
export function fmtNum(n) {
  if (Object.is(n, -0)) return '-0'
  if (Number.isNaN(n)) return 'nan'
  if (n === Infinity) return 'inf'
  if (n === -Infinity) return '-inf'
  return String(n)
}

// --- f64 instructions ---
export const f64 = {
  const: n => tv('f64', `(f64.const ${fmtNum(n)})`),
  add: (a, b) => tv('f64', `(f64.add ${asF64(a).wat} ${asF64(b).wat})`),
  sub: (a, b) => tv('f64', `(f64.sub ${asF64(a).wat} ${asF64(b).wat})`),
  mul: (a, b) => tv('f64', `(f64.mul ${asF64(a).wat} ${asF64(b).wat})`),
  div: (a, b) => tv('f64', `(f64.div ${asF64(a).wat} ${asF64(b).wat})`),
  neg: a => tv('f64', `(f64.neg ${asF64(a).wat})`),
  eq: (a, b) => tv('i32', `(f64.eq ${asF64(a).wat} ${asF64(b).wat})`),
  ne: (a, b) => tv('i32', `(f64.ne ${asF64(a).wat} ${asF64(b).wat})`),
  lt: (a, b) => tv('i32', `(f64.lt ${asF64(a).wat} ${asF64(b).wat})`),
  le: (a, b) => tv('i32', `(f64.le ${asF64(a).wat} ${asF64(b).wat})`),
  gt: (a, b) => tv('i32', `(f64.gt ${asF64(a).wat} ${asF64(b).wat})`),
  ge: (a, b) => tv('i32', `(f64.ge ${asF64(a).wat} ${asF64(b).wat})`),
}

// --- i32 instructions ---
export const i32 = {
  const: n => tv('i32', `(i32.const ${n})`),
  add: (a, b) => tv('i32', `(i32.add ${asI32(a).wat} ${asI32(b).wat})`),
  sub: (a, b) => tv('i32', `(i32.sub ${asI32(a).wat} ${asI32(b).wat})`),
  mul: (a, b) => tv('i32', `(i32.mul ${asI32(a).wat} ${asI32(b).wat})`),
  and: (a, b) => tv('i32', `(i32.and ${asI32(a).wat} ${asI32(b).wat})`),
  or: (a, b) => tv('i32', `(i32.or ${asI32(a).wat} ${asI32(b).wat})`),
  xor: (a, b) => tv('i32', `(i32.xor ${asI32(a).wat} ${asI32(b).wat})`),
  shl: (a, b) => tv('i32', `(i32.shl ${asI32(a).wat} (i32.and ${asI32(b).wat} (i32.const 31)))`),
  shr_s: (a, b) => tv('i32', `(i32.shr_s ${asI32(a).wat} (i32.and ${asI32(b).wat} (i32.const 31)))`),
  shr_u: (a, b) => tv('i32', `(i32.shr_u ${asI32(a).wat} (i32.and ${asI32(b).wat} (i32.const 31)))`),
  eq: (a, b) => tv('i32', `(i32.eq ${asI32(a).wat} ${asI32(b).wat})`),
  ne: (a, b) => tv('i32', `(i32.ne ${asI32(a).wat} ${asI32(b).wat})`),
  lt_s: (a, b) => tv('i32', `(i32.lt_s ${asI32(a).wat} ${asI32(b).wat})`),
  le_s: (a, b) => tv('i32', `(i32.le_s ${asI32(a).wat} ${asI32(b).wat})`),
  gt_s: (a, b) => tv('i32', `(i32.gt_s ${asI32(a).wat} ${asI32(b).wat})`),
  ge_s: (a, b) => tv('i32', `(i32.ge_s ${asI32(a).wat} ${asI32(b).wat})`),
  eqz: a => tv('i32', `(i32.eqz ${asI32(a).wat})`),
  not: a => tv('i32', `(i32.xor ${asI32(a).wat} (i32.const -1))`),
}

// --- Control flow ---
export const ctrl = {
  if: (cond, thenType, thenVal, elseVal) =>
    tv(thenType, `(if (result ${thenType}) ${cond.wat} (then ${thenVal.wat}) (else ${elseVal.wat}))`),
}

// --- Locals ---
export const local = {
  get: (name, type) => tv(type, `(local.get $${name})`),
  set: (name, val) => `(local.set $${name} ${val.wat})`,
  tee: (name, val) => tv(val.t, `(local.tee $${name} ${val.wat})`),
}

// --- Function calls ---
export const call = (name, ...args) => `(call $${name} ${args.map(a => a.wat).join(' ')})`
