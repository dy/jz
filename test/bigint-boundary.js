// An exported function whose parameter is read only in BigInt arithmetic
// (`bits >> 32n`, `bits & 0xFFFFFFFFn`) is compiled with the boundary's f64
// numeric contract: the summary's numeric demand counts a `>>`/`&` read as a
// ToNumber read whatever the other operand is, the parameter (ANY at the host
// boundary, BIGINT from every in-program call) is seeded NUMBER by the second
// fixpoint, and an in-program call passing a BigInt then trips the runtime's
// mixing check inside the function. This is layout.js's `i64Hex` and its
// callers (src/compile/emit/comparisons.js `emitTypeofCmp`, the
// `typeof x === 'number'` arm), which is why the self-hosted kernel throws
// `Cannot mix BigInt and other types` in emitFuncs on any program with a
// `typeof x === 'number'` test in expression position, its own source first
// of all (`.work/optimizer-review/checkpoint-45868ec5.md`). The regression is
// ordinary JS; the pins stay red until the summary's demand rule closes.
//
// What a repair must satisfy is semantic: every payload's exact bits reach the
// function from the host and from the program alike, and the published ABI
// (`jz:i64exp`, `jz:hostabi`) agrees with the parameter's boundary lane. No
// physical carrier is prescribed: a BigInt rides a raw i64, or the boxed f64
// carrier behind an i64 boundary lane (`boundaryI64`), as `g` below does.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { compile } from '../index.js'
import { instantiate } from '../interop.js'
import { ctx } from '../src/ctx.js'
import { onKernel } from './_matrix.js'

const HEX = 'const _hx8 = n => n.toString(16).padStart(8, "0")\n'
const I64HEX = 'i64Hex = bits => "0x" + _hx8(Number((bits >> 32n) & 0xFFFFFFFFn)) + _hx8(Number(bits & 0xFFFFFFFFn))\n'
const run = (src, level) => instantiate(compile(src, { optimize: level }), { memory: 64 }).exports
// The JS oracle, the same source evaluated by the host.
const hx8 = n => n.toString(16).padStart(8, '0')
const i64Hex = bits => '0x' + hx8(Number((bits >> 32n) & 0xFFFFFFFFn)) + hx8(Number(bits & 0xFFFFFFFFn))
// Payloads shaped like the runtime's own carriers: the sign bit alone, zero,
// all ones and a negative (the same 64 bits as all ones), a small and a large
// positive, a negative NaN with the quiet bit. COLLIDING are the plain BigInt
// values whose top 13 bits are 0x7FF8: the NaN box prefix itself (the value in
// the compiler's LAYOUT), a NaN with an atom payload, and the largest positive
// i64. The host boundary reads them as boxes it minted (interop.js isBox:
// `(hi32(b) & 0xFFF80000) === 0x7FF80000`), so they reach the program as
// NaN, undefined and an object, never as their BigInt value. That ambiguity
// belongs to the host ABI's use of one BigInt type for both box bits and
// values; it is pinned apart from the demand defect.
const PAYLOADS = [0x8000000000000000n, 0n, 0xFFFFFFFFFFFFFFFFn, -1n, 1n, 0x7FF7FFFFFFFFFFFFn, 0xFFF8000000000000n]
const COLLIDING = [0x7FF8000000000000n, 0x7FF8000200000000n, 0x7FFFFFFFFFFFFFFFn]
const section = (wasm, name) => {
  const [bytes] = WebAssembly.Module.customSections(new WebAssembly.Module(wasm), name)
  return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : []
}
// The published boundary of one export against the plan's record of its first parameter.
const boundary = (wasm, name) => {
  const f = ctx.funcs.list.find(f => f.name === name), lane = !!f.sig.params[0].boundaryI64
  const i64exp = section(wasm, 'jz:i64exp').find(e => e.name === name)
  const hostabi = section(wasm, 'jz:hostabi').find(e => e.name === name)
  const published = !!i64exp?.p?.includes(0), evidenced = !!(hostabi?.raw?.includes(0) || hostabi?.tag?.includes(0))
  return { type: f.sig.params[0].type, lane, published, evidenced }
}
const calls = (fn, payloads) => payloads.map((p, i) => `export let f${i} = () => ${fn}(${p}n)\n`).join('')
const LAYOUT = 'export const LAYOUT = { A: 1, NAN: 0x7FF8000000000000n }\nexport let f = () => i64Hex(LAYOUT.NAN).length\n'

test('bigint boundary: an exported function read only in BigInt arithmetic keeps its BigInt argument, from the program and from the host', () => {
  if (onKernel()) return
  const src = HEX + 'export const ' + I64HEX + LAYOUT
  for (const level of [1, 2]) {
    const ex = run(src, level)
    is(ex.f(), 18, `an in-program call of the exported i64Hex with a BigInt (O${level})`)   // red: Cannot mix BigInt and other types, use explicit conversions
    is(ex.i64Hex(0x8000000000000000n), '0x8000000000000000', `the host's call with a BigInt (O${level})`)   // red: the same
    throws(() => ex.i64Hex(5), TypeError, `a Number payload is a TypeError, as \`5 >> 32n\` is in JS (O${level})`)
    throws(() => ex.i64Hex(undefined), TypeError, `an absent argument is a TypeError, as \`undefined >> 32n\` is (O${level})`)
  }
})

test('bigint boundary: the same function called with BigInt literals from the program compiles, and every payload\'s exact bits arrive', () => {
  if (onKernel()) return
  // With literal BigInt arguments at the call sites the same seeding rejects at compile time
  // instead: `RepresentationPlan host-box param lacks i64 boundary: i64Hex[0]` (boundary-wrap.js).
  const src = HEX + 'export const ' + I64HEX + LAYOUT + calls('i64Hex', PAYLOADS)
  for (const level of [1, 2]) {
    const ex = run(src, level)   // red: the compile-time rejection
    const retained = []
    PAYLOADS.forEach((p, i) => {
      const expected = i64Hex(p)
      is(ex[`f${i}`](), expected, `the program's call with ${p}n (O${level})`)
      is(ex.i64Hex(p), expected, `the host's call with ${p}n (O${level})`)
      retained.push([expected, ex[`f${i}`](), ex.i64Hex(p)])
    })
    ok(retained.every(([e, a, b]) => a === e && b === e), 'the strings are retained across later calls')
  }
})

test('bigint boundary: the summary seeds the parameter NUMBER on numeric demand from BigInt operators', () => {
  if (onKernel()) return
  const wasm = compile(HEX + 'export const ' + I64HEX + LAYOUT, { optimize: 1 })
  const f = ctx.funcs.list.find(f => f.name === 'i64Hex'), bits = f.sig.params[0].name
  ok(!ctx.summary.at('i64Hex').numericDemand(bits), 'a read by `>> 32n` is BigInt arithmetic, not a ToNumber read')   // red: true
  const b = boundary(wasm, 'i64Hex')
  ok(b.lane, `the parameter takes the boundary's i64 lane, whatever its carrier (${b.type})`)   // red: f64 with no lane, the boundary's numeric contract
  is(b.published, b.lane, 'jz:i64exp publishes the lane the plan recorded')
  is(b.evidenced, b.lane, 'jz:hostabi carries the BigInt evidence the host needs to box a plain BigInt into it')
})

test('bigint boundary: a parameter proven BigInt by a typeof guard rides the boxed f64 carrier behind an i64 lane, and the ABI says so', () => {
  if (onKernel()) return
  // The reference shape: not an i64 parameter, yet a correct BigInt boundary.
  const src = 'export const g = b => typeof b === "bigint" ? b + 1n : 0n\nexport let f = () => g(2n)\n' + calls('g', PAYLOADS)
  for (const level of [1, 2]) {
    const wasm = compile(src, { optimize: level })
    const b = boundary(wasm, 'g')
    is(b.type, 'f64', `the carrier is the boxed f64 (O${level})`)
    ok(b.lane && b.published && b.evidenced, `the boundary lane is i64, published and evidenced (O${level})`)
    const ex = instantiate(wasm, { memory: 64 }).exports
    is(ex.f(), 3n)
    PAYLOADS.forEach((p, i) => {
      const expected = BigInt.asIntN(64, p + 1n)
      is(ex[`f${i}`](), expected, `the program's call with ${p}n (O${level})`)
      is(ex.g(p), expected, `the host's call with ${p}n (O${level})`)
    })
    is(ex.g(5), 0n, 'a Number takes the other arm'); is(ex.g(undefined), 0n, 'and so does absence')
  }
})

test('bigint boundary: a plain BigInt value with the box prefix crosses the host boundary as itself', () => {
  if (onKernel()) return
  const src = 'export const g = b => typeof b === "bigint" ? b + 1n : 0n\nexport const t = b => typeof b\n' + calls('g', COLLIDING)
  const ex = run(src, 1)
  COLLIDING.forEach((p, i) => {
    const expected = BigInt.asIntN(64, p + 1n)
    is(ex[`f${i}`](), expected, `the program's call with ${p}n`)
    is(ex.t(p), 'bigint', `the host's ${p}n is a bigint to typeof`)   // red: number, undefined, object
    is(ex.g(p), expected, `the host's call with ${p}n`)   // red: 0n, the box read as another kind
  })
})

test('bigint boundary: the sibling scopes run: the same function not exported; a typeof guard as a statement', () => {
  if (onKernel()) return
  const local = HEX + 'const ' + I64HEX + 'const LAYOUT = { A: 1, NAN: 0x7FF8000000000000n }\nexport let f = () => i64Hex(LAYOUT.NAN).length'
  for (const level of [1, 2]) is(run(local, level).f(), 18, `the same function not exported (O${level})`)
  const byIf = 'export const addr = (idx) => { if (typeof idx === "number") return idx * 8; return idx }\nexport let f = () => addr(2)'
  is(run(byIf, 1).f(), 16, 'a typeof guard as a statement (the kernel compiles this shape; the expression form calls i64Hex)')
  const expr = 'export const addr = (idx) => typeof idx === "number" ? idx * 8 : idx\nexport let f = () => addr(2)'
  is(run(expr, 1).f(), 16, 'the expression form compiles natively: the kernel, compiling the same, throws in emitFuncs')
})
