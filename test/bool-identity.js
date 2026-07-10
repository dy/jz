// Boolean identity across untyped carriers — the self-host mother bug
// (kernel resolveOptimize: `1 === true` took the level-2 branch; fromEntries
// presets read back 0/1 so `cfg.pass !== false` ran passes the host skipped).
//
// Contract (src/ir.js BOOL_ATOM_BASE): booleans are raw i32/f64 0/1 ONLY while
// their static type is known (branch/arithmetic position). The moment one flows
// into an untyped carrier — container store, collection key/value, closure arg,
// mixed ?:/&&/||/?? merge — it materializes as its TRUE/FALSE atom (carrierF64),
// so typeof / String / strict-eq observe boolean identity. Strict equality
// against a bool literal on an unknown operand compares atom BITS (emitStrictEq)
// — `1 === true` is false, exactly ES; BOOL∪NUMBER merges deliberately stay raw
// (the 0/1 IS the ToNumber image — VT['?:'] carries NUMBER there).
import test, { is, ok } from 'tst'
import { run } from './util.js'

const LEVELS = [false, 2]

test('bool identity: containers round-trip the atom', async () => {
  const SRC = `
  export const probe = () => {
    const fe = Object.fromEntries([['f', false], ['t', true]])
    const m1 = new Map([['k', false]])
    const m2 = new Map(); m2.set('k', true)
    const h = {}; const dk = 'dk'; h[dk] = false
    const pairs = [['k', false]]
    const a = [0]; a[0] = true
    const p = []; p.push(false)
    return [
      typeof fe.f, String(fe.f), typeof fe.t,
      typeof m1.get('k'), typeof m2.get('k'),
      typeof h[dk], typeof pairs[0][1], typeof a[0], typeof p[0],
    ].join('|')
  }`
  for (const optimize of LEVELS) {
    const { probe } = await run(SRC, { memory: 256, optimize })
    is(probe(), 'boolean|false|boolean|boolean|boolean|boolean|boolean|boolean|boolean', `optimize:${optimize}`)
  }
})

test('bool identity: strict-eq is identity, loose stays ToNumber', async () => {
  const SRC = `
  export const probe = () => {
    const fe = Object.fromEntries([['f', false]])
    const g = (x) => x === true          // mixed-site param: g(true) and g(1)
    return [
      1 === true ? 'X' : 'ok',           // ES: false
      0 === false ? 'X' : 'ok',
      fe.f === false ? 'ok' : 'X',       // boxed false IS false
      fe.f !== false ? 'X' : 'ok',       // the resolveOptimize gate shape
      fe.f == 0 ? 'ok' : 'X',            // loose: ToNumber(false) == 0
      g(true) ? 'ok' : 'X',
      g(1) ? 'X' : 'ok',
    ].join('|')
  }`
  for (const optimize of LEVELS) {
    const { probe } = await run(SRC, { memory: 256, optimize })
    is(probe(), 'ok|ok|ok|ok|ok|ok|ok', `optimize:${optimize}`)
  }
})

test('bool identity: mixed ?:/&&/||/?? merges box the bool arm, numeric mixes stay raw', async () => {
  const SRC = `
  export const probe = (n, s) => {
    const a = []
    for (let i = 0; i < n; i++) a.push(i ? true : [7, 8])   // watr's rec-type marker shape
    const v = s || false
    const w = s && true
    const u = s ?? false
    return [
      typeof a[1], a[1] === true ? 'ok' : 'X',
      typeof v, String(v), v === false ? 'eqF' : 'neF',
      typeof w,
      typeof u,
      String(1 + (n > 0 ? 1 : n > -1)),        // BOOL∪NUMBER: raw, arithmetic exact
      String((n > 0 ? true : 'x')),            // BOOL∪STRING: identity kept
    ].join('|')
  }`
  for (const optimize of LEVELS) {
    const { probe } = await run(SRC, { memory: 256, optimize })
    is(probe(2, ''), 'boolean|ok|boolean|false|eqF|string|string|2|true', `optimize:${optimize} falsy`)
    is(probe(2, 'x'), 'boolean|ok|string|x|neF|boolean|string|2|true', `optimize:${optimize} truthy`)
  }
})

test('bool identity: preset-table idiom (the kernel divergence chain)', async () => {
  // resolveOptimize's exact shape: fromEntries -> freeze -> spread -> number
  // level from JSON.parse -> `=== true` branch test -> `!== false` pass gates.
  const SRC = `
  const NAMES = ['csePureExpr', 'foldSetToTee', 'treeshake', 'fusedRewrite']
  const ALL_ON = Object.freeze(Object.fromEntries(NAMES.map(n => [n, true])))
  const ALL_OFF = Object.freeze(Object.fromEntries(NAMES.map(n => [n, false])))
  const P1 = Object.freeze({ ...ALL_OFF, treeshake: true, fusedRewrite: true })
  const TABLE = Object.freeze({ 0: ALL_OFF, 1: P1, 2: ALL_ON })
  const resolve = (opt) => {
    if (opt === false || opt === 0) return { ...ALL_OFF }
    if (opt === true || opt == null) return { ...TABLE[2] }
    if (typeof opt === 'number' || typeof opt === 'string') return { ...(TABLE[String(opt)] || TABLE[2]) }
    return { ...ALL_OFF }
  }
  export const probe = (optJSON) => {
    const cfg = resolve(JSON.parse(optJSON))
    return [
      cfg.csePureExpr !== false ? 'ON' : 'off',
      cfg.treeshake ? 'on' : 'OFF',
      Object.keys(cfg).length,
    ].join('|')
  }`
  for (const optimize of LEVELS) {
    const { probe } = await run(SRC, { memory: 256, optimize })
    is(probe('1'), 'off|on|4', `optimize:${optimize} number level (JSON.parse('1') must NOT hit === true)`)
    is(probe('"1"'), 'off|on|4', `optimize:${optimize} string level`)
    is(probe('true'), 'ON|on|4', `optimize:${optimize} literal true takes the === true branch (frozen TABLE[2] literal read)`)
    is(probe('0'), 'off|OFF|4', `optimize:${optimize} zero level`)
  }
})

test('bool identity: typed-array element writes ToNumber the box', async () => {
  const SRC = `
  export const probe = () => {
    const f = new Float64Array(2), u = new Uint8Array(2)
    const k = 0
    f[k] = true; u[k] = true      // dyn index defeats the inline typed store
    f[1] = false; u[1] = false
    return [f[0], f[1], u[0], u[1]].join('|')
  }`
  for (const optimize of LEVELS) {
    const { probe } = await run(SRC, { memory: 256, optimize })
    is(probe(), '1|0|1|0', `optimize:${optimize}`)
  }
})

test('bool identity: JSON, truthiness, arithmetic on boxed bools', async () => {
  const SRC = `
  export const probe = () => {
    const fe = Object.fromEntries([['f', false], ['t', true]])
    return [
      JSON.stringify({ a: false, b: [true] }),
      fe.t ? 'T' : 'X', fe.f ? 'X' : 'F',    // truthiness of boxed atoms
      fe.t + 1, fe.f + 1,                    // ToNumber through the box
      [false, true].indexOf(true),
      [false].includes(false) ? 'inc' : 'X',
    ].join('|')
  }`
  for (const optimize of LEVELS) {
    const { probe } = await run(SRC, { memory: 256, optimize })
    is(probe(), '{"a":false,"b":[true]}|T|F|2|1|1|inc', `optimize:${optimize}`)
  }
})
