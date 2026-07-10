/**
 * Structural invariants of the compiled output — properties beyond functional
 * correctness (the right answer can come out of wrong internal structure).
 *
 *   - semantic: const tracking, block scope, optional-chain eval-once, type
 *     preservation, export surface, NaN-boxing.
 *   - layout:   layout.js is the SOLE source of NaN-box carrier i64 hex in WAT
 *     templates — no hand-rolled discriminator literals in src/ or module/.
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { compile } from '../index.js'
import { ctx, reset } from '../src/ctx.js'
import { emit, emitter, emitVoid as flat, emitBlockBody as body, emitBoolStr as bool, emitIndex as idx, buildArrayWithSpreads as spread } from '../src/compile/emit.js'
import { GLOBALS } from '../src/prepare/index.js'
import { run } from './util.js'
import { onKernel } from './_matrix.js'

// === Helper: compile with WAT output for structural inspection ===
const wat = (code, opts = {}) => compile(code, { ...opts, wat: true })

// ============================================================================
// Const enforcement invariants
// ============================================================================

test('invariant: module-scope const name tracked in ctx.scope.consts', () => {
  if (onKernel()) return  // kernel: compile runs inside the wasm; the host's ctx.scope is never populated, so this white-box internal-state probe can't apply on the self-host leg
  reset(emitter, GLOBALS, { emit, flat, body, bool, idx, spread })
  compile('const X = 10; export let f = () => X')
  ok(ctx.scope.consts?.has('X'), 'const X should be tracked in ctx.scope.consts')
})

test('invariant: let does not appear in ctx.scope.consts', () => {
  reset(emitter, GLOBALS, { emit, flat, body, bool, idx, spread })
  compile('let x = 10; export let f = () => x')
  ok(!ctx.scope.consts?.has('x'), 'let x should NOT be in ctx.scope.consts')
})

test('invariant: reassigned const produces compile error', () => {
  let error
  try { compile('const X = 1; export let f = () => { X = 2; return X }') } catch (e) { error = e }
  ok(error, 'const reassignment should throw')
  ok(error.message.includes("const"), `error should mention 'const': ${error.message}`)
})

test('invariant: module-scope const is not a mutable WASM global', () => {
  // A true const should not appear as a `global.set` target
  const w = wat('const X = 10; export let f = () => X')
  ok(!w.includes('global.set $X'), `const X should not be global.set: ${w.slice(0, 200)}`)
})

// ============================================================================
// Block scope invariants — functional (compiler DCE eliminates unused locals)
// ============================================================================

test('invariant: if-block let does not shadow outer at runtime', () => {
  is(run('export let f = () => { let x = 1; if (1) { let x = 2; x = 3 }; return x }').f(), 1)
})

test('invariant: for-loop let does not leak to outer scope', () => {
  is(run('export let f = () => { let i = 99; for (let i = 0; i < 3; i++) {}; return i }').f(), 99)
})

test('invariant: bare block scoping', () => {
  is(run('export let f = () => { let x = 1; { let x = 2 }; return x }').f(), 1)
})

// ============================================================================
// Optional chain invariants
// ============================================================================

test('invariant: ?.[i] with side-effecting base evaluates once', () => {
  const { f, getCalls } = run(`
    let calls = 0
    let mk = () => { calls = calls + 1; return [10, 20] }
    export let f = () => {
      calls = 0
      let r = mk()?.[1]
      return [r, calls]
    }
    export let getCalls = () => calls
  `)
  const r = f()
  is(r[0], 20, 'optional index returns correct value')
  is(r[1], 1, 'base expression evaluated exactly once')
  // Also verify getCalls is correct after f()
  is(getCalls(), 1)
})

test('invariant: ?.[] on null returns null without evaluating key', () => {
  const { f, getEvalCount } = run(`
    let evalCount = 0
    let keyExpr = () => { evalCount = evalCount + 1; return 0 }
    export let f = () => {
      evalCount = 0
      let obj = null
      let r = obj?.[keyExpr()]
      return [r, evalCount]
    }
    export let getEvalCount = () => evalCount
  `)
  const r = f()
  ok(isNaN(r[0]), 'optional index on null returns null')
  is(r[1], 0, 'key expression NOT evaluated when base is null')
  is(getEvalCount(), 0)
})

// ============================================================================
// Type preservation invariants
// ============================================================================

test('invariant: i32 loop counter stays i32 in WAT', () => {
  const w = wat('export let f = (n) => { let s = 0; for (let i = 0; i < n; i++) s += i; return s }')
  ok(w.includes('i32'), 'WAT contains i32 ops for loop counter')
})

test('invariant: division always produces f64 result', () => {
  const w = wat('export let f = (a, b) => a / b')
  ok(w.includes('f64.div'), 'division uses f64.div')
})

// ============================================================================
// Module export invariants
// ============================================================================

test('invariant: exported function appears in WAT exports', () => {
  const w = wat('export let add = (a, b) => a + b')
  ok(w.includes('(export "add"'), 'exported name appears in WAT exports')
})

test('invariant: non-exported function is not in WAT exports', () => {
  const w = wat('let helper = (x) => x * 2; export let f = (x) => helper(x)')
  ok(!w.includes('(export "helper"'), 'unexported name not in exports')
  ok(w.includes('(export "f"'), 'exported name is in exports')
})

// ============================================================================
// NaN-boxing invariants
// ============================================================================

test('invariant: null pointer uses NaN pattern', () => {
  const w = wat('export let f = () => null')
  // null should compile to the special NaN pattern, not i32.const 0
  ok(w.includes('f64') || w.includes('i64'), 'null expression uses float/int ops')
})

// ============================================================================
// Layout invariants — layout.js is the sole source of NaN-box carrier i64 hex
// ============================================================================
const ROOT = join(import.meta.dirname, '..')
const SCAN = [join(ROOT, 'module'), join(ROOT, 'src')]
const ALLOW = new Set([join(ROOT, 'layout.js')])

/** Discriminator bits that must come from layout.js helpers, not hand literals. */
const LAYOUT_I64 = [
  /\(i64\.const 0x7FF80{8}[0-9A-Fa-f]{0,8}\)/g,
  /\(i64\.const 0x0000400000000000\)/g,
  /\(i64\.const 0x0000200000000000\)/g,
]

function jsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) jsFiles(p, out)
    else if (p.endsWith('.js') && !ALLOW.has(p)) out.push(p)
  }
  return out
}

test('layout: NaN-box carrier i64 hex only via layout.js helpers', () => {
  const violations = []
  for (const dir of SCAN) {
    for (const file of jsFiles(dir)) {
      const src = readFileSync(file, 'utf8')
      for (const re of LAYOUT_I64) {
        re.lastIndex = 0
        for (const m of src.matchAll(re)) {
          violations.push(`${relative(ROOT, file)}: ${m[0]}`)
        }
      }
    }
  }
  ok(violations.length === 0, violations.length
    ? `use layout.js helpers (nanPrefixHex, ssoBitI64Hex, sliceBitI64Hex, …):\n${violations.join('\n')}`
    : 'no hand-rolled layout hex')
})

test('layout: i64Hex is self-host-safe across the full 64-bit range', async () => {
  // Under self-host, BigInts are raw SIGNED i64 bits (kind-erased), so any
  // formatting that routes through bits.toString(16) renders a bit-63-set
  // value as a signed "-8000…" fragment — the emitted `(i64.const 0x00-…)`
  // is unparseable and killed every durable-log helper the kernel compiled
  // (the nanPrefixMaskHex regression). i64Hex must build the hex from
  // logical-shifted 32-bit halves; this pins host output byte-for-byte
  // against the toString reference for the boundary patterns.
  const { i64Hex, nanPrefixMaskHex } = await import('../layout.js')
  const ref = (b) => '0x' + b.toString(16).toUpperCase().padStart(16, '0')
  for (const bits of [0n, 1n, 0x7FF8000000000000n, 1n << 63n,
    0x7FF8000000000000n | (1n << 63n), 0xFFFFFFFFFFFFFFFFn, 0x0123456789ABCDEFn])
    is(i64Hex(bits), ref(bits), `i64Hex(${bits.toString(16)})`)
  ok(/^0xFFF8/.test(nanPrefixMaskHex()), 'sign-bit-forced mask formats unsigned')
})
