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
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import { compile } from '../index.js'
import { instantiate } from '../interop.js'
import { ctx } from '../src/ctx.js'
import { onKernel } from './_matrix.js'

const HEX = 'const _hx8 = n => n.toString(16).padStart(8, "0")\n'
const I64HEX = 'i64Hex = bits => "0x" + _hx8(Number((bits >> 32n) & 0xFFFFFFFFn)) + _hx8(Number(bits & 0xFFFFFFFFn))\n'
const run = (src, level) => instantiate(compile(src, { optimize: level }), { memory: 64 }).exports

test('bigint boundary: an exported function read only in BigInt arithmetic keeps its BigInt argument', () => {
  if (onKernel()) return
  const src = HEX + 'export const ' + I64HEX + 'export const LAYOUT = { A: 1, NAN: 0x7FF8000000000000n }\nexport let f = () => i64Hex(LAYOUT.NAN).length'
  for (const level of [1, 2]) {
    const ex = run(src, level)
    is(ex.f(), 18, `an in-program call of the exported i64Hex with a BigInt (O${level})`)   // red: Cannot mix BigInt and other types, use explicit conversions
    is(ex.i64Hex(0x7FF8000000000000n), '0x7ff8000000000000', `the host's call with a BigInt (O${level})`)   // red: the same
  }
})

test('bigint boundary: the summary seeds the parameter NUMBER on numeric demand from BigInt operators', () => {
  if (onKernel()) return
  compile(HEX + 'export const ' + I64HEX + 'export const LAYOUT = { A: 1, NAN: 0x7FF8000000000000n }\nexport let f = () => i64Hex(LAYOUT.NAN).length', { optimize: 1 })
  const f = ctx.funcs.list.find(f => f.name === 'i64Hex'), bits = f.sig.params[0].name
  ok(!ctx.summary.at('i64Hex').numericDemand(bits), 'a read by `>> 32n` is BigInt arithmetic, not a ToNumber read')   // red: true
  is(f.sig.params[0].type, 'i64', 'the parameter carries the BigInt')   // red: f64, the boundary's numeric contract
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
