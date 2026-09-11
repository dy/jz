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
import { is, ok, throws } from 'tst/assert.js'
import { readFileSync, readdirSync, statSync } from 'fs'
import { spawnSync } from 'node:child_process'
import { join, relative } from 'path'
import jz, { compile } from '../index.js'
import { compile as compileWat } from 'watr'
import { ctx, reset } from '../src/ctx.js'
import { DBG_INVARIANTS, assertCtxInvariants, resetInvariants, assertFeatureWrite, assertLinkDemandWrite } from '../src/debug.js'
import { createActiveFunction } from '../src/compile/active-function.js'
import { analyzeBody, reanalyzeBody, setFuncBody, invalidateAllBodyFacts } from '../src/compile/analyze.js'
import { emit, emitter, emitVoid as flat, emitBlockBody as body, emitBoolStr as bool, emitIndex as idx, buildArrayWithSpreads as spread, emitIdentitySafe } from '../src/compile/emit.js'
import { GLOBALS } from '../src/prepare/index.js'
import { run, wat } from './util.js'
import { onKernel, levels } from './_matrix.js'
import { representationStorageWriteAction } from '../src/compile/representation-plan.js'
import { buildProgramIndex } from '../src/compile/program-index.js'
import { isExported } from '../src/compile/func-exports.js'
import { parse } from '../src/parse.js'

// === Helper: compile with WAT output for structural inspection ===

test('invariant: shared power generator reconstructs every decimal entry exactly', () => {
  if (onKernel()) return  // native helper inspection; bootstrap decimal semantics have a separate full-range pin
  const expected = []
  for (let q = -342; q <= 308; q++) {
    const p = 10n ** BigInt(Math.abs(q)), bits = p.toString(2).length
    expected.push(q < 0 ? (1n << BigInt(127 + bits)) / p
      : bits <= 128 ? p << BigInt(128 - bits) : p >> BigInt(bits - 128))
  }
  for (const op of ['Number', 'Number', 'parseFloat']) {
    compile(`export const f = s => ${op}(s)`)
    const spans = ctx.runtime.lazySpans
    const corrections = spans.find(s => s.global === '__el_tbl').bytes
    const powers = spans.find(s => s.global === '__ryu_tbl').bytes
    is(corrections.length, 245, 'three correction bits for every exponent')
    is(powers.length, 828, 'one shared power table, including parser-only modules')
    const esc = Array.from(powers, x => '\\' + x.toString(16).padStart(2, '0')).join('')
    const helper = ctx.core.stdlib.__ryu_pow5
    const bytes = compileWat(`(module
      (memory 1) (global $__ryu_tbl i32 (i32.const 0)) (data (i32.const 0) "${esc}")
      ${ctx.core.stdlib.__ryu_mulhi} ${ctx.core.stdlib.__umul128} ${typeof helper === 'function' ? helper() : helper}
      (export "entry" (func $__ryu_pow5)) (export "mul" (func $__umul128)))`)
    const { entry, mul } = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports
    const limbs = [0n, 1n, 0xFFFFFFFFn, 0x100000000n, 0x8000000000000000n, 0xFFFFFFFFFFFFFFFFn]
    for (const m of limbs) for (const lo of limbs) for (const hi of limbs) {
      const product = mul(m, lo, hi).reduce((sum, word, i) => sum | BigInt.asUintN(64, word) << BigInt(i * 64), 0n)
      is(product, m * (lo | hi << 64n), `unsigned 64×128: ${m}, ${lo}, ${hi}`)
    }
    const power = (i, inv) => {
      const [lo, hi] = entry(i, inv)
      return BigInt.asUintN(64, lo) | BigInt.asUintN(64, hi) << 64n
    }
    const view = new DataView(corrections.buffer, corrections.byteOffset, corrections.byteLength)
    for (let i = 0; i < expected.length; i++) {
      const q = i - 342, bit = i * 3
      const correction = BigInt(view.getUint16(bit >> 3, true) >> (bit & 7) & 7)
      const base = power(Math.abs(q), q < 0 ? 1 : 0) << 3n
      is(q < 0 ? base - correction - 1n : base + correction, expected[i], `${op}: exact 10^${q}`)
    }
    // Formatting reaches positive powers beyond the parser's maximum exponent.
    for (let i = 309; i <= 325; i++) {
      const p = 5n ** BigInt(i), bits = p.toString(2).length
      is(power(i, 0), p >> BigInt(bits - 125), `formatter: exact 5^${i}`)
    }
    is(power(0, 1), (1n << 125n) + 1n, 'inverse zero seed retains its rounding convention')
  }
})

// ============================================================================
// Const enforcement invariants
// ============================================================================

test('invariant: module-scope const name tracked in ctx.scope.consts', () => {
  if (onKernel()) return  // kernel: compile runs inside the wasm; the host's ctx.scope is never populated, so this white-box internal-state probe can't apply on the self-compile leg
  reset(emitter, GLOBALS, { emit, flat, body, bool, idx, spread, emitIdentitySafe })
  compile('const X = 10; export let f = () => X')
  ok(ctx.scope.consts?.has('X'), 'const X should be tracked in ctx.scope.consts')
})

test('invariant: let does not appear in ctx.scope.consts', () => {
  reset(emitter, GLOBALS, { emit, flat, body, bool, idx, spread, emitIdentitySafe })
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
// Body facts: signature freshness is checked on every hit; explicit mutation
// seams cover AST and ambient changes. Global invalidation includes anonymous
// bodies, not just the named function registry.

test('invariant: a signature retype invalidates a cached body on its next read', () => {
  if (onKernel()) return
  reset(emitter, GLOBALS, { emit, flat, body, bool, idx, spread, emitIdentitySafe })
  compile('export let f = (a) => a + 1')
  const func = ctx.funcs.map.get('f'), prior = ctx.func.current
  ctx.func.current = func.sig
  const p = func.sig.params[0], saved = p.type
  try {
    const before = analyzeBody(func.body)
    ok(analyzeBody(func.body) === before, 'unchanged signature reuses its facts')
    p.type = saved === 'i32' ? 'f64' : 'i32'
    const after = analyzeBody(func.body)
    ok(after !== before, 'changed signature recomputes without a debug-only throw')
    ok(analyzeBody(func.body) === after, 'the new signature has a stable cache entry')
  } finally { p.type = saved; reanalyzeBody(func.body); ctx.func.current = prior }
})

test('invariant: explicit body mutation seams refresh cached facts', () => {
  if (onKernel()) return
  reset(emitter, GLOBALS, { emit, flat, body, bool, idx, spread, emitIdentitySafe })
  compile('export let f = (a) => a + 1')
  const func = ctx.funcs.map.get('f')
  ctx.func.current = func.sig
  analyzeBody(func.body)
  const p = func.sig.params[0]
  p.type = p.type === 'i32' ? 'f64' : 'i32' // same retype as above, but read through the seam this time
  const fresh = reanalyzeBody(func.body)
  ok(fresh && fresh.locals instanceof Map, 'reanalyzeBody recomputes under the new signature')
  // setFuncBody: an AST rewrite (structural, not a signature retype) must not
  // leave a stale entry behind either — read the (same-identity) body again
  // right after and confirm no throw.
  setFuncBody(func, func.body)
  analyzeBody(func.body)
})

// ============================================================================
// Global fact changes also invalidate bodies outside the named registry.
test('invariant: global fact invalidation includes anonymous body roots', () => {
  if (onKernel()) return
  compile('export const f = () => 1')
  const anonymous = parse('let x = 1; x + 2')
  const before = analyzeBody(anonymous)
  ok(analyzeBody(anonymous) === before, 'anonymous root has a cached observation')
  invalidateAllBodyFacts()
  ok(analyzeBody(anonymous) !== before, 'phase invalidation drops anonymous observations too')
})

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

const COMPILE_FAMILY_OWNERS = [
  ['func-exports.js', ['isExported', 'exportNamesOf']],
  ['func-entry.js', ['enterFunc', 'emitPreboxedLocalInits']],
  ['param-numeric.js', ['NUM_BIN_OPS', 'REL_OPS', 'isStrLiteral', 'paramAllUsesNumeric', 'STRING_RECV_METHODS', 'paramNeverString', 'paramValueOnly']],
  ['throw-runtime.js', ['ensureThrowRuntime']],
  ['intern-table.js', ['buildInternTable']],
  ['func-inspect.js', ['repView', 'captureFuncInspect']],
  ['boundary-wrap.js', ['isBoundaryWrapped', 'synthesizeBoundaryWrappers']],
  ['coercion-hoist.js', ['hoistInvariantParamCoercions', 'hoistUnionCursorUnbox']],
  ['analyze-for-emit.js', ['freshCseName', 'analyzeFuncForEmit', 'seedLocalIntConsts']],
  ['emit-func.js', ['emitFunc']],
  ['closure-emit.js', ['normalizeClosureBody', 'closureSig', 'enterClosureFrame', 'seedClosureFrame', 'analyzeClosureBodyForEmit', 'emitClosureBody']],
]

test('architecture: compile-session families have one declaration owner outside the driver', () => {
  const driver = readFileSync(join(ROOT, 'src/compile/index.js'), 'utf8')
  const stages = [driver, ...['analyze-for-emit.js', 'emit-func.js', 'closure-emit.js']
    .map(file => readFileSync(join(ROOT, 'src/compile', file), 'utf8'))]
  for (const [file, names] of COMPILE_FAMILY_OWNERS) {
    const owner = readFileSync(join(ROOT, 'src/compile', file), 'utf8')
    ok(stages.some(source => source.includes(`from './${file}'`)), `compiler stages import ${file}`)
    for (const name of names) {
      const declaration = new RegExp(`^(?:export\\s+)?(?:const\\s+${name}\\b|function\\s+${name}\\b)`, 'gm')
      is([...owner.matchAll(declaration)].length, 1, `${name} is declared exactly once in ${file}`)
      is([...driver.matchAll(declaration)].length, 0, `${name} has no duplicate authority in compile/index.js`)
    }
  }
})

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

test('architecture: missing active BigInt RepresentationPlan fails closed', () => {
  const plans = { representations: new WeakMap(), representationData: new WeakMap() }
  plans.representationData.set(plans, { bigint: true })
  const fake = { plans, func: { current: { name: 'missing-plan' } } }
  throws(() => representationStorageWriteAction(fake, 1), /RepresentationPlan active body missing/)
})

test('architecture: named BigInt boundaries live only in ProgramIndex', () => {
  if (onKernel()) return
  compile('export let f = (x) => { x = BigInt(x); return x + 1n }')
  const func = ctx.funcs.map.get('f')
  const index = ctx.plans.programIndex
  const boundary = index.functionBoundaryData(func)
  ok(boundary?.kind === 'boundary', 'ProgramIndex owns the named function boundary')
  const handle = ctx.plans.representations.get(func)
  const record = handle && ctx.plans.representationData.get(handle)
  is(Object.prototype.hasOwnProperty.call(record, 'boundary'), false,
    'the named FunctionPlan record has no duplicate boundary writer')
  is(record?.body?.boundary, boundary, 'body analysis reads the exact ProgramIndex boundary')
})

test('architecture: anonymous closure/start boundaries live only in ProgramIndex', () => {
  if (onKernel()) return
  compile(`
    let seed = 1n
    seed = seed + 2n
    export let make = (a) => {
      let base = BigInt(a) + seed
      let f = (y) => y + base
      return f
    }
  `)
  const index = ctx.plans.programIndex
  const anonymous = [...(ctx.closure.bodies || [])]
  ok(ctx.plans.start, 'the module body compiles through a start frame')
  anonymous.push(ctx.plans.start)
  ok(anonymous.length >= 2, 'the program produces at least one closure body and the start frame')
  for (const identity of anonymous) {
    const boundary = index.functionBoundaryData(identity)
    ok(boundary?.kind === 'boundary', 'ProgramIndex owns the anonymous boundary')
    is(index.anonymousBoundaryKindOf(identity), identity.moduleScope === true ? 'start' : 'closure')
    const record = ctx.plans.representationData.get(ctx.plans.representations.get(identity))
    is(Object.prototype.hasOwnProperty.call(record, 'boundary'), false,
      'the anonymous record has no duplicate boundary writer')
    is(record?.body?.boundary, boundary, 'body analysis reads the exact ProgramIndex boundary')
  }
})

test('architecture: typed emitters consume TypedStoragePlan, not live ctor maps', () => {
  const files = [
    'module/array.js', 'module/typedarray.js',
    'src/compile/emit.js', 'src/compile/emit-assign.js',
    'src/compile/emit/shared.js', 'src/compile/emit/i32-bounds.js',
    'src/compile/emit/dispatch.js', 'src/compile/emit/bigint.js', 'src/compile/emit/call-args.js',
    'src/compile/emit/method-dispatch.js', 'src/compile/emit/call.js', 'src/compile/emit/instanceof.js',
    'src/compile/emit/incdec.js', 'src/compile/emit/arithmetic.js', 'src/compile/emit/comparisons.js',
    'src/compile/emit/logical.js', 'src/compile/emit/bitwise.js', 'src/compile/emit/statements.js',
    'src/compile/emit/control-flow.js', 'src/compile/emit/assignment.js', 'src/compile/emit/index.js',
  ]
  const violations = []
  for (const rel of files) {
    const src = readFileSync(join(ROOT, rel), 'utf8')
    if (/ctx\.func\.typedElem[^\n]*\.get\(|ctx\.scope\.globalTypedElem[^\n]*\.get\(/.test(src))
      violations.push(rel)
  }
  is(violations.join(','), '', 'emit-time ctor decisions must route through TypedStoragePlan')
})

test('layout: i64Hex is self-compile-safe across the full 64-bit range', async () => {
  // Under self-compile, BigInts are raw SIGNED i64 bits (kind-erased), so any
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

// ============================================================================
// isReassigned emission memo — memoized path must be bit-equivalent to the walk
// ============================================================================
// The emit driver brackets its stages with begin/endAssignedMemo (ast.js), so
// every emit-time isReassigned query resolves through a per-subtree
// assigned-name set instead of an O(|body|) rescan. The set collection must
// mirror the walk's tree contract EXACTLY — a `let`/`const` declarator's `=`
// binds rather than writes (only initializers scanned), non-name mutation
// targets contribute nothing but their subexpressions are scanned.
// (`redeclaresName` in type.js is the same walk shape and often paired at call
// sites — left unmemoized deliberately: it never showed in the m86 profile.
// If it ever does, it takes this same treatment and this same test.)
test('invariant: isReassigned memo path bit-equivalent to the fresh walk', async () => {
  const { isReassigned, beginAssignedMemo, endAssignedMemo } = await import('../src/ast.js')
  const both = (node, name) => {
    const a = isReassigned(node, name)
    beginAssignedMemo()
    try { is(isReassigned(node, name), a, `memo diverges: ${name} in ${JSON.stringify(node)}`) }
    finally { endAssignedMemo() }
    return a
  }
  // declarator `=` binds, does not write
  is(both(['let', ['=', 'x', ['num', 1]]], 'x'), false)
  // ...but a write inside the initializer counts
  is(both(['let', ['=', 'x', ['=', 'y', ['num', 1]]]], 'y'), true)
  // bare declarator, empty body, non-array body
  is(both(['let', 'x'], 'x'), false)
  is(both([';'], 'x'), false)
  is(both('x', 'x'), false)
  // plain and compound writes, inc/dec
  is(both([';', ['=', 'x', ['num', 1]]], 'x'), true)
  is(both([';', ['+=', 'x', ['num', 1]]], 'x'), true)
  is(both([';', ['++', 'x']], 'x'), true)
  // member target is not a name write, but its subexpressions are scanned
  is(both([';', ['=', ['.', 'o', 'p'], ['num', 1]]], 'o'), false)
  is(both([';', ['=', ['idx', 'a', ['++', 'i']], ['num', 1]]], 'i'), true)
  // nested let inside an initializer keeps the binder rule at depth
  is(both(['let', ['=', 'x', ['=>', ['args'], ['let', ['=', 'q', ['num', 1]]]]]], 'q'), false)
  // memo reuse across roots: query root, child, root again — all consistent
  const root = [';', ['=', 'a', ['num', 1]], ['if', 'c', [';', ['++', 'b']]]]
  beginAssignedMemo()
  try {
    is(isReassigned(root, 'a'), true)
    is(isReassigned(root[2][2], 'b'), true)   // child subtree gets its own set
    is(isReassigned(root[2][2], 'a'), false)  // 'a' write is outside this subtree
    is(isReassigned(root, 'b'), true)
  } finally { endAssignedMemo() }
  // window discipline: after end, the fresh walk is back (no lingering memo)
  is(isReassigned(root, 'a'), true)
})

// ============================================================================
// FunctionPlan linear ownership
// ============================================================================
test('invariant: FunctionPlan transfers collections once and keeps projections detached', async () => {
  const { createFunctionPlan, functionPlanRepField, installFunctionPlan } = await import('../src/compile/function-plan.js')
  const { isMapOverlay, makeMapOverlay } = await import('../src/compile/map-overlay.js')
  const wideRep = { schemaId: 7, arrayElemSchema: 0, arrayElemSchemaSet: [1, 2], intCertain: false }
  const facts = {
    block: false,
    locals: new Map([['w', wideRep], ['n', 5], ['nil', null]]),
    boxed: new Map(), capturedNames: new Set(), cellTypes: new Set(['w']),
    flatObjects: new Map(), sliceViews: new Set(), cseLoadBases: new Set(),
    distinctParams: null, leanHashLocals: new Set(), i32HashLocals: new Set(),
    leanHashDomains: new Map(),
    typedElem: makeMapOverlay(new Map([['t', 'Float64Array']]), new Map()),
    typedLen: null,
    localReps: new Map([['w', wideRep]]),
  }
  const { ctx } = await import('../src/ctx.js')
  const plan = createFunctionPlan(ctx, facts)
  is(functionPlanRepField(ctx, plan, 'w', 'arrayElemSchema'), 0)
  is(functionPlanRepField(ctx, plan, 'w', 'intCertain'), false)
  const projected = functionPlanRepField(ctx, plan, 'w', 'arrayElemSchemaSet')
  projected.push(3)
  is(wideRep.arrayElemSchemaSet, [1, 2], 'cross-function projection is detached')
  is(functionPlanRepField(ctx, plan, 'w', 'arrayElemSchemaSet'), [1, 2], 'a repeated read sees canonical facts')
  wideRep.arrayElemSchemaSet = []
  is(functionPlanRepField(ctx, plan, 'w', 'arrayElemSchemaSet'), [], 'empty arrays remain present')
  is(functionPlanRepField(ctx, plan, 'missing', 'arrayElemSchemaSet'), undefined)
  throws(() => functionPlanRepField(ctx, plan, 'w', 'schemaId'), /Unknown FunctionPlan projection/)

  const data = installFunctionPlan(ctx, plan)
  is(data.locals, facts.locals, 'analysis collection ownership transfers without cloning')
  is(data.localReps, facts.localReps)
  is([...data.locals.keys()].join(','), 'w,n,nil', 'Map insertion order preserved')
  ok(data.cellTypes.has('w'))
  ok(isMapOverlay(data.typedElem), 'MapOverlay stays an overlay, not flattened')
  is(ctx.plans.functionData.has(plan), false, 'install consumes canonical storage immediately')
  is(functionPlanRepField(ctx, plan, 'w', 'arrayElemSchemaSet'), undefined, 'consumed plans expose no facts')
  throws(() => installFunctionPlan(ctx, plan), /already-consumed FunctionPlan/)
})

// ============================================================================
// Static-data parts accumulator — exact equivalence with the string form
// ============================================================================
// The data segment accumulates as parts + a maintained length
// (src/static-data.js) because member-target `+=` fresh-copies the whole
// segment per append in the self-compiled kernel (the jz×jz goal-gate wall,
// .work/evidence.md §EXHAUSTIVE ATTRIBUTION). Offsets, alignment padding, and
// the final joined bytes must be byte-equivalent to the old string form.
test('invariant: static-data parts accumulator matches string-form bytes and offsets', async () => {
  const { dataAlign, dataPush, dataLen, dataBytes, dataReset, pushStaticSlots, hexBytes } = await import('../src/static-data.js')
  const { ctx } = await import('../src/ctx.js')
  const savedParts = ctx.runtime.dataParts, savedLen = ctx.runtime.dataLen, savedSlots = ctx.runtime.staticPtrSlots
  try {
    dataReset(new Uint8Array(0))
    is(dataLen(), 0)
    is([...dataBytes()], [])
    dataAlign(8)
    is(dataLen(), 0)
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    dataPush(all.slice(0, 129))
    dataAlign(8)
    const ref = [...all.slice(0, 129), ...new Array(7).fill(0)]
    is(dataLen(), ref.length)
    is([...dataBytes()], ref)
    dataPush(all.slice(129))
    ref.push(...all.slice(129))
    is([...dataBytes()], ref, 'joining then appending preserves every byte')
    is(dataLen(), ref.length)
    ctx.runtime.staticPtrSlots = []
    dataAlign(8)
    while (ref.length % 8) ref.push(0)
    const slotOff = pushStaticSlots(['0x0011223344556677'])
    is(slotOff, ref.length)
    is([...dataBytes().slice(slotOff, slotOff + 8)], [0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0])
    is(ctx.runtime.staticPtrSlots.length, 0)
    dataReset(dataBytes().slice(128, 137))
    is(dataLen(), 9)
    is([...dataBytes()], ref.slice(128, 137), 'slices retain byte offsets across zero padding')
    is([...hexBytes('00807fFf')], [0, 128, 127, 255])
  } finally {
    ctx.runtime.dataParts = savedParts; ctx.runtime.dataLen = savedLen; ctx.runtime.staticPtrSlots = savedSlots
  }
})

// ============================================================================
// dedupClosureBodies — hash-cons grouping parity with the retired stringify key
// ============================================================================
// The dedup key moved from JSON.stringify of each closure's renamed tree
// (measured 810.76 MB of transient churn on the jz×jz region-live self-compile)
// to a rename-invariant rolling hash + exact alpha-aware comparator. Grouping
// must be bit-compatible with the old key, including its accidental JSON-null
// equivalence class: undefined/null/NaN/±Infinity all serialized to 'null'.
test('invariant: closure dedup groups alpha-duplicates, JSON-null class, and order counterexamples exactly', async () => {
  const { dedupClosureBodies } = await import('../src/wat/assemble.js')
  const { ctx } = await import('../src/ctx.js')
  const savedTable = ctx.closure.table
  try {
    const mk = (name, body) => ['func', `$${name}`, ['param', '$a', 'f64'], ['result', 'f64'], body]
    const run = (funcs) => {
      ctx.closure.table = funcs.map(f => f[1].slice(1))
      const sec = { funcs: [...funcs] }
      dedupClosureBodies(funcs, sec)
      return sec.funcs.map(f => f[1]).join(',')
    }
    // alpha-renamed duplicates collapse
    const dupA = ['func', '$c1', ['param', '$x', 'f64'], ['result', 'f64'], ['f64.add', ['local.get', '$x'], ['f64.const', 1]]]
    const dupB = ['func', '$c2', ['param', '$y', 'f64'], ['result', 'f64'], ['f64.add', ['local.get', '$y'], ['f64.const', 1]]]
    is(run([dupA, dupB]), '$c1', 'alpha-renamed duplicate collapses to canonical')
    // JSON-null class: NaN and null in the same slot stay ONE group (old-key parity)
    const nanF = mk('c3', ['f64.const', NaN])
    const nulF = mk('c4', ['f64.const', null])
    is(run([nanF, nulF]), '$c3', 'NaN/null slots share the JSON-null equivalence class')
    // different local correspondence order must NOT dedup
    const ord1 = ['func', '$c5', ['param', '$p', 'f64'], ['param', '$q', 'f64'], ['result', 'f64'], ['f64.sub', ['local.get', '$p'], ['local.get', '$q']]]
    const ord2 = ['func', '$c6', ['param', '$p', 'f64'], ['param', '$q', 'f64'], ['result', 'f64'], ['f64.sub', ['local.get', '$q'], ['local.get', '$p']]]
    is(run([ord1, ord2]), '$c5,$c6', 'reversed local correspondence stays distinct')
    // distinct constants stay distinct
    const k1 = mk('c7', ['f64.const', 2])
    const k2 = mk('c8', ['f64.const', 3])
    is(run([k1, k2]), '$c7,$c8', 'distinct constants stay distinct')
  } finally { ctx.closure.table = savedTable }
})

// ============================================================================
// program-facts freeze discipline (v1 architecture-convergence, "facts frozen
// before consumers" — .work/archive/program-facts-split.md §7 has the full lifecycle
// table: paramReps/callSites are STAGED facts, published empty/raw by
// collectProgramFacts and settled by plan()'s own round 3; programFacts
// itself is closed-shape once ProgramIndex is stapled on). All three pins
// below are white-box against the freeze.js mechanism itself, not a live
// compile's internal state — no onKernel() guard needed, since
// JZ_TEST_TARGET=jz.wasm only changes WHERE compilation happens, never what
// this plain, side-effect-free module does when called directly from the host.
// ============================================================================

test('invariant: ProgramIndex owns stable numeric function and member-target identities', () => {
  const target = { name: 'target', sig: { params: [], results: ['f64'] }, body: ['return', [null, 1]] }
  const caller = { name: 'caller', exported: true, sig: { params: [], results: ['f64'] }, body: ['return', ['()', ['.', 'ns', 'run'], null]] }
  const dead = { name: 'dead', sig: { params: [], results: ['f64'] }, body: ['return', ['()', 'target', null]] }
  const orphan = { name: 'orphan', sig: { params: [], results: ['f64'] }, body: ['return', ['()', 'target', null]] }
  const funcs = [target, caller, dead, orphan]
  const callSites = [
    { callee: 'caller', argList: [], callerFunc: target, node: ['()', 'caller'] },
    { callee: 'target', argList: [], callerFunc: caller, node: ['()', 'target'] },
    { callee: 'caller', argList: [], callerFunc: null, node: ['()', 'caller'] },
    { callee: 'target', argList: [], callerFunc: dead, node: ['()', 'target'] },
    { callee: 'target', argList: [], callerFunc: orphan, node: ['()', 'target'] },
  ]
  const addressTakenNames = new Set(['dead', 'orphan'])
  const index = buildProgramIndex({
    module: { moduleInits: [] },
    funcs: {
      list: funcs,
      map: new Map(funcs.map(func => [func.name, func])),
      names: new Set(funcs.map(func => func.name)),
      multiProp: new Map(),
    },
  }, {
    nameEscapes: new Set(), dynWriteVars: new Set(), addressTakenNames, callSites,
  }, parse('let target=()=>1;const ns={run:target};export let caller=()=>ns.run()'),
  () => addressTakenNames.delete('orphan'))
  const targetSourceId = index.sourceIdOf('target')
  const targetGraphId = index.graphFunctionIdOfName('target')
  const callerGraphId = index.graphFunctionIdOfName('caller')
  const deadGraphId = index.graphFunctionIdOfName('dead')
  const orphanGraphId = index.graphFunctionIdOfName('orphan')
  is(targetSourceId, 0)
  is(index.sourceFunctionCount, 4)
  is(index.graphFunctionCount, 4)
  is(index.sourceFunctionById(targetSourceId), target)
  is(index.resolveMemberSourceId('ns', 'run'), targetSourceId)
  is(index.resolveComputedSourceIds('ns').join(','), String(targetSourceId))
  is(index.resolveMemberSourceId('ns', 'missing'), -1)

  const graph = index.getCallGraph()
  is(graph.rootIds.join(','), `${callerGraphId},${deadGraphId}`)
  is(graph.dynamicRootIds.join(','), String(deadGraphId))
  is(index.addressTaken.size, 1)
  ok(index.addressTaken.has('dead'), 'address-taken compatibility reads the numeric index')
  ok(!index.addressTaken.has('orphan'), 'enrichment release settles before address-taken freeze')
  ok(index.isGraphAddressTaken(deadGraphId), 'numeric graph address-taken query agrees with the name view')
  is(graph.addressTakenBits.join(','), '0,0,1,0')
  throws(() => index.addressTaken.add('orphan'), /is not a function/)
  is(graph.edgeStart.join(','), '0,1,2,3')
  is(graph.edgeCount.join(','), '1,1,1,1')
  is(graph.edgeTarget.join(','), `${callerGraphId},${targetGraphId},${targetGraphId},${targetGraphId}`)
  is(graph.componentCount, 3)
  is(graph.componentOf[targetGraphId], graph.componentOf[callerGraphId], 'the recursive pair shares one SCC')
  is(graph.componentSize[graph.componentOf[targetGraphId]], 2)
  ok(index.isGraphReachable(targetGraphId), 'the transitive target is reachable')
  ok(index.isGraphReachable(callerGraphId), 'the module-call root is reachable')
  ok(index.isGraphReachable(deadGraphId), 'an address-taken function is a conservative dynamic root')
  ok(!index.isGraphReachable(orphanGraphId), 'an unrooted caller remains unreachable')
  index.filterCallSitesToReachable(callSites)
  is(callSites.length, 4)
  is(callSites.map(site => site.callee).join(','), 'caller,target,caller,target')
  throws(() => graph.edgeTarget.push(deadGraphId), /not extensible/)
  throws(() => graph.componentOf.push(deadGraphId), /not extensible/)
  is(index.finalizeCallGraph, undefined, 'the published ProgramIndex exposes no graph writer')
})

test('invariant: ProgramIndex keeps source, variant, and graph IDs disjoint', async () => {
  const { materializeVariant } = await import('../src/compile/variant.js')
  const savedFuncs = ctx.funcs, savedPlans = ctx.plans
  try {
    const source = { name: 'source', exported: false, sig: { params: [{ name: 'x', type: 'f64' }], results: ['f64'] }, body: ['return', 'x'] }
    ctx.funcs = {
      list: [source], map: new Map([['source', source]]), names: new Set(['source']),
      multiProp: new Map(), pendingVariants: [],
    }
    ctx.plans = {}
    const paramReps = new Map([['source', new Map([[0, { val: 'NUMBER' }]])]])
    const fixed = materializeVariant({
      origin: source, name: 'source$fixed', kind: 'fixed-rest', paramReps,
      eligibleSites: [], fallback: source,
    })
    const facts = {
      nameEscapes: new Set(), dynWriteVars: new Set(), addressTakenNames: new Set(), callSites: [],
      memberCallSites: [],
    }
    const index = buildProgramIndex(ctx, facts, null)
    is('addressTakenNames' in facts, false, 'the source-name census is consumed and deleted')
    is('memberCallSites' in facts, false, 'the member call-site census is consumed and deleted')
    is('valueUsed' in facts, false, 'the compatibility key does not survive ProgramIndex build')
    ctx.plans.programIndex = index
    const guarded = materializeVariant({
      origin: fixed, name: 'source$guarded', kind: 'typed-guard', paramReps,
      eligibleSites: [], fallback: fixed,
    })

    is(index.sourceFunctionCount, 1)
    is(index.sourceIdOf(source), 0)
    is(index.sourceIdOf(fixed), -1, 'a variant never aliases its source ID')
    is(index.variantIdOf(source), -1, 'a source never aliases a variant ID')
    is(index.variantIdOf(fixed), 0)
    is(index.variantIdOf(guarded), 1)
    is(index.sourceIdOfVariant(0), 0)
    is(index.sourceIdOfVariant(1), 0, 'a variant of a variant normalizes to the source ID')
    is(index.sourceFunctionById(0), source)
    is(index.variantFunctionById(0), fixed)
    is(index.variantFunctionById(1), guarded)
    is(index.graphFunctionCount, 2, 'the frozen graph includes only callables present at graph build')
    ok(index.graphFunctionIdOfName('source') >= 0)
    ok(index.graphFunctionIdOfName('source$fixed') >= 0)
    is(index.graphFunctionIdOfName('source$guarded'), -1)
    is(index.functionById, undefined, 'no untyped function-ID accessor survives')
    is(index.functionIdOfName, undefined, 'no untyped name-to-ID accessor survives')

    const sourceBoundary = { kind: 'boundary', owner: 'source' }
    const fixedBoundary = { kind: 'boundary', owner: 'fixed' }
    index.publishFunctionBoundaryData(source, sourceBoundary)
    index.publishFunctionBoundaryData(fixed, fixedBoundary)
    is(index.functionBoundaryData(source), sourceBoundary)
    is(index.functionBoundaryData(fixed), fixedBoundary)
    is(index.functionBoundaryData(guarded), null)

    const sourcePlan = {}, fixedPlan = {}, guardedPlan = {}
    const plans = new Map([[source, sourcePlan], [fixed, fixedPlan], [guarded, guardedPlan]])
    const variants = index.finalizeVariantIdentities(paramReps, func => plans.get(func))
    is(variants.variantCount, 2)
    is(variants.variantSourceIds.join(','), '0,0')
    is(variants.variantKinds.join(','), 'fixed-rest,typed-guard')
    is(variants.variantBoundaryData[0], fixedBoundary)
    is(variants.variantBoundaryData[1], null)
    ok(fixed.sig !== source.sig && guarded.sig !== source.sig, 'variant signatures are derived records')
    ok(paramReps.get(fixed.name) !== paramReps.get(source.name), 'variant parameter facts are derived records')
    ok(paramReps.get(guarded.name) !== paramReps.get(fixed.name), 'nested variant facts are derived again')
    ok(fixedPlan !== sourcePlan && guardedPlan !== sourcePlan, 'variant FunctionPlans are distinct')
    throws(() => variants.variantSourceIds.push(0), /not extensible/)
    throws(() => index.registerVariantIdentity({ name: 'late' }, source, 'late'), /already finalized/)
    throws(() => index.publishFunctionBoundaryData(guarded, { kind: 'boundary' }), /read only/)

    const closureIdentity = { name: 'cb0' }, startIdentity = { name: '__start', moduleScope: true }
    const closureBoundary = { kind: 'boundary' }, startBoundary = { kind: 'boundary' }
    is(index.publishFunctionBoundaryData(closureIdentity, closureBoundary, 'closure'), closureBoundary,
      'the anonymous boundary space stays open after variant identity closes')
    is(index.publishFunctionBoundaryData(startIdentity, startBoundary, 'start'), startBoundary)
    is(index.functionBoundaryData(closureIdentity), closureBoundary)
    is(index.functionBoundaryData(startIdentity), startBoundary)
    is(index.anonymousBoundaryKindOf(closureIdentity), 'closure')
    is(index.anonymousBoundaryKindOf(startIdentity), 'start')
    is(index.anonymousBoundaryKindOf(source), null, 'an indexed identity never aliases the anonymous space')
    throws(() => index.publishFunctionBoundaryData(closureIdentity, closureBoundary, 'closure'), /already published/)

    const concrete = index.finalizeConcreteFunctionIds()
    is(concrete.concreteCount, ctx.funcs.list.length)
    is(index.concreteFunctionOrder().map(f => f.name).join(','),
      ctx.funcs.list.map(f => f.name).join(','), 'concrete order is the final emission order')
    is(index.concreteIdOf(source), 0)
    is(index.concreteIdOf(fixed), 1)
    is(index.concreteFunctionById(index.concreteIdOf(guarded)), guarded)
    is(index.concreteIdOfSource(index.sourceIdOf(source)), 0)
    is(index.concreteIdOfVariant(index.variantIdOf(guarded)), 2)
    ok(Object.isFrozen(ctx.funcs.list), 'the registry list freezes at concrete-ID close')
    throws(() => ctx.funcs.list.push(source), /not extensible/)
    is(index.finalizeConcreteFunctionIds(), concrete, 'concrete finalize is idempotent')

    throws(() => index.parameterAbiOf(source), /not published/)
    is(index.publishParameterAbi(paramReps), 3)
    is(index.parameterAbiOf(source), paramReps.get('source'), 'the settled source row transfers by reference')
    is(index.parameterAbiOf(fixed), paramReps.get('source$fixed'), 'a variant reads its own derived row')
    ok(index.parameterAbiOf(fixed) !== index.parameterAbiOf(source), 'variant and source rows stay distinct')
    throws(() => index.publishParameterAbi(paramReps), /already published/)

    const facts2 = {
      nameEscapes: new Set(), dynWriteVars: new Set(), addressTakenNames: new Set(), callSites: [],
    }
    const index2 = buildProgramIndex(ctx, facts2, null)
    throws(() => index2.finalizeConcreteFunctionIds(), /finalized variant identities/)
    throws(() => index2.concreteFunctionOrder(), /not finalized/)
    throws(() => index2.publishParameterAbi(paramReps), /concrete function IDs/)
  } finally {
    ctx.funcs = savedFuncs
    ctx.plans = savedPlans
  }
})

test('architecture: ProgramIndex variant and boundary facts have one writer each', () => {
  const registrations = [], finalizers = [], boundaryWriters = [], boundaryAssignments = [], concreteFinalizers = []
  for (const file of jsFiles(join(ROOT, 'src'))) {
    const src = readFileSync(file, 'utf8')
    if (/\.registerVariantIdentity\s*\(/.test(src)) registrations.push(relative(ROOT, file))
    if (/\.finalizeVariantIdentities\s*\(/.test(src)) finalizers.push(relative(ROOT, file))
    if (/\.publishFunctionBoundaryData\s*\(/.test(src)) boundaryWriters.push(relative(ROOT, file))
    if (/\.boundary\s*=[^=]/.test(src)) boundaryAssignments.push(relative(ROOT, file))
    if (/\.finalizeConcreteFunctionIds\s*\(/.test(src)) concreteFinalizers.push(relative(ROOT, file))
  }
  is(registrations.join(','), 'src/compile/variant.js')
  is(finalizers.join(','), 'src/compile/index.js')
  is(boundaryWriters.join(','), 'src/compile/representation-plan/boundaries.js')
  is(boundaryAssignments.join(','), '', 'no identity-keyed boundary field writer survives')
  is(concreteFinalizers.join(','), 'src/compile/index.js')
  const abiPublishers = []
  for (const file of jsFiles(join(ROOT, 'src'))) {
    if (/\.publishParameterAbi\s*\(/.test(readFileSync(file, 'utf8'))) abiPublishers.push(relative(ROOT, file))
  }
  is(abiPublishers.join(','), 'src/compile/index.js')
  ok(!/paramReps/.test(readFileSync(join(ROOT, 'src', 'compile', 'emit-func.js'), 'utf8')),
    'emission reads ProgramIndex parameter ABI, not the analysis lattice')
})

test('architecture: host-callability reads the canonical export predicate', () => {
  // The raw `func.exported` flag means "declared with `export` in its own
  // module" and is read only where that syntactic fact is the question: the
  // inline `(export …)` attribute sites and the active-function frame record.
  // Every host-callability decision (roots, coverage, host ABI, inlining)
  // goes through isExported / isExportedIn, which also resolves aliases and
  // bundle re-exports.
  const allowed = new Set([
    'src/compile/func-exports.js', 'src/compile/active-function.js',
    'src/compile/boundary-wrap.js', 'src/compile/emit-func.js',
  ])
  const offenders = []
  for (const file of [...jsFiles(join(ROOT, 'src')), ...jsFiles(join(ROOT, 'module'))]) {
    const rel = relative(ROOT, file)
    if (allowed.has(rel)) continue
    const code = readFileSync(file, 'utf8').split('\n')
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
    if (/(?<![.\w])(?:func|f|fn|callerFunc)\??\.exported\b/.test(code)) offenders.push(rel)
  }
  is(offenders.join(','), '', 'no host-callability reader consults the raw export flag')
})

test('invariant: re-exported entry points are ProgramIndex roots', () => {
  if (onKernel()) return
  compile("export { f } from './m.jz'", {
    modules: { './m.jz': 'let helper = (x) => x > 0 ? helper(x - 1) + 1 : 0\nexport let f = (y) => helper(y) * 2' },
  })
  const index = ctx.plans.programIndex
  const target = ctx.funcs.list.find(fn => !fn.raw && isExported(fn) && !fn.exported)
  ok(target, 'the bundle re-export resolves to a target without the syntactic flag')
  ok(index.isGraphReachable(index.graphFunctionIdOfName(target.name)), 'the re-exported target is a root')
  const helper = ctx.funcs.list.find(fn => !fn.raw && /helper$/.test(fn.name))
  ok(helper && index.isGraphReachable(index.graphFunctionIdOfName(helper.name)),
    'a callee reached only through the re-exported entry is reachable')
})

test('invariant: member-property calls are ProgramIndex edges and roots', () => {
  if (onKernel()) return
  compile([
    'let helper = (s) => s > 0 ? helper(s - 1) + 2 : 0',
    'let ns = (x) => x',
    'ns.parse = (s) => helper(s) + 1',
    'export let use = (s) => ns.parse(s)',
  ].join('\n'))
  const index = ctx.plans.programIndex
  const reach = name => index.isGraphReachable(index.graphFunctionIdOfName(name))
  ok(index.graphFunctionIdOfName('ns$parse') >= 0, 'the function property lifts to a graph node')
  ok(reach('ns$parse'), 'a `.`-member call resolved through member targets is an edge')
  ok(reach('helper'), 'a callee reached only inside the member-property body is reachable')

  compile([
    'let helper = (s) => s > 0 ? helper(s - 1) + 2 : 0',
    'let ns = (x) => x',
    'ns.parse = (s) => helper(s) + 1',
    'let seed = ns.parse(3)',
    'export let read = () => seed',
  ].join('\n'))
  const index2 = ctx.plans.programIndex
  ok(index2.isGraphReachable(index2.graphFunctionIdOfName('ns$parse')), 'a module-scope member call roots its target')
  ok(index2.isGraphReachable(index2.graphFunctionIdOfName('helper')), 'and its callees follow')
})

test('invariant: namespace-computed dispatch reaches its arms and their members', () => {
  if (onKernel()) return
  const m = 'export let a = (x) => x + 1\nexport let b = (x) => x * 2\nb.parse = (s) => s.length\nexport let four = (p, q, r, s) => p + 1'
  compile("import * as ns from './m.jz'\nexport let pick2 = (k, s) => ns[k].parse(s)", { modules: { './m.jz': m } })
  const index = ctx.plans.programIndex
  const parse = ctx.funcs.list.find(fn => !fn.raw && /b\$parse$/.test(fn.name))
  ok(parse && index.isGraphReachable(index.graphFunctionIdOfName(parse.name)),
    'a member call on the lowered `?:` chain reaches each arm\'s member target')

  compile([
    "import * as ns from './m.jz'",
    'const H = { go: (k, v) => ns[k](v) }',
    'export let run = (op, k, v) => H[op](k, v)',
  ].join('\n'), { modules: { './m.jz': m } })
  const index2 = ctx.plans.programIndex
  const four = ctx.funcs.list.find(fn => !fn.raw && /four$/.test(fn.name))
  ok(four && index2.isGraphReachable(index2.graphFunctionIdOfName(four.name)),
    'an arm called with an arity shortfall inside an inline dispatch member still gets its graph edge')
})

test('invariant: multi-written properties, optional calls, init-stored refs, and defaults reach ProgramIndex', () => {
  if (onKernel()) return
  const reach = (index, name) => index.isGraphReachable(index.graphFunctionIdOfName(name))

  compile('let ns = (x) => x\nns.p = (v) => v + 1\nns.p = (v) => v + 2\nexport let h = (v) => ns.p(v)')
  let index = ctx.plans.programIndex
  const lifts = ctx.funcs.list.filter(f => !f.raw && /^ns\$p/.test(f.name)).map(f => f.name)
  is(lifts.length, 2, 'each write of a multi-written function property lifts its own implementation')
  ok(lifts.every(n => index.addressTaken.has(n) && reach(index, n)),
    'every lifted implementation of a multi-written property is address-taken and reachable')

  compile('let f = (x) => x > 0 ? f(x - 1) + 1 : 0\nexport let h = (v) => f?.(v)')
  index = ctx.plans.programIndex
  ok(reach(index, 'f'), 'an optional call on a named function is a call-graph edge')

  compile("import { g } from './m.jz'\nexport let read = () => g", {
    modules: { './m.jz': 'let f = (x) => x > 0 ? f(x - 1) + 1 : 0\nexport let g = 0\ng = f' },
  })
  index = ctx.plans.programIndex
  const stored = ctx.funcs.list.find(fn => !fn.raw && /f$/.test(fn.name))
  ok(stored && reach(index, stored.name), 'a function reference stored by a module-init write is a root')

  compile('let helper = (x) => x > 0 ? helper(x - 1) + 1 : 0\nlet d = (a, fn = (x) => helper(x)) => fn(a)\nexport let h = (v) => d(v)')
  index = ctx.plans.programIndex
  ok(reach(index, 'helper'), 'a call inside a default-parameter expression is an edge of its function')
})

test('invariant: value reads, global devirt, and init arguments take the function address', () => {
  if (onKernel()) return
  const reach = (index, name) => index.isGraphReachable(index.graphFunctionIdOfName(name))

  compile('let ns = (x) => x\nns.p = (v) => v > 0 ? ns.p(v - 1) + 1 : 0\nconst saved = ns.p\nexport let h = (v) => saved(v)')
  let index = ctx.plans.programIndex
  ok(index.addressTaken.has('ns$p') && reach(index, 'ns$p'),
    'a function-property read in value position takes the member\'s address')
  ok(reach(index, 'ns') && !index.addressTaken.has('ns'), 'the base function is a root, its parameters stay covered')

  compile('let ns = (x) => x\nns.p = (v) => v > 0 ? ns.p(v - 1) + 1 : 0\nexport let h = (v) => ns.p && v ? 1 : 0')
  index = ctx.plans.programIndex
  ok(reach(index, 'ns$p') && !index.addressTaken.has('ns$p'),
    'a member read consumed only as a truthiness test is a root without taking the address')

  compile("import { use } from './m.jz'\nexport let h = (v) => use(v)", {
    modules: { './m.jz': 'let ns = (x) => x\nns.p = (v) => v > 0 ? ns.p(v - 1) + 1 : 0\nexport let use = (v) => ns.p(v)' },
  })
  index = ctx.plans.programIndex
  const lifted = ctx.funcs.list.find(fn => !fn.raw && /ns\$p$/.test(fn.name))
  ok(lifted && reach(index, lifted.name) && !index.addressTaken.has(lifted.name),
    'a module-init write target stores into the slot without reading a function value')

  compile('let g\ng ??= (x) => x > 0 ? g(x - 1) + 1 : 0\nexport let h = (v) => g(v)')
  index = ctx.plans.programIndex
  const devirt = [...(ctx.funcs.globalDevirt?.values() || [])]
  ok(devirt.length && devirt.every(n => index.addressTaken.has(n) && reach(index, n)),
    'a lifted arrow reached through global devirtualization takes the address')

  compile("import thing from './dep.jz'\nexport let test = (x) => thing(x)", {
    modules: { './dep.jz': 'let make = (a) => (x) => a(x) + 1\nlet double = (x) => x > 0 ? double(x - 1) + 2 : 0\nexport default make(double)' },
  })
  index = ctx.plans.programIndex
  const dbl = ctx.funcs.list.find(fn => !fn.raw && /double$/.test(fn.name))
  ok(dbl && reach(index, dbl.name), 'a function passed as an argument at module init is a root')
})

test('invariant: unreachable functions are neither analyzed nor emitted, and still validate', () => {
  if (onKernel()) return
  const base = 'export let f = (x) => x + 1'
  const dead = 'let dead = (s) => "unreachable literal " + s\n' + base
  for (const optimize of levels(false, true)) {
    const a = compile(base, { optimize }), b = compile(dead, { optimize })
    ok(Buffer.from(a).equals(Buffer.from(b)), `dead code leaves no trace at optimize=${optimize}`)
  }
  compile(dead)
  is(ctx.plans.functions.get(ctx.funcs.map.get('dead')), undefined, 'the dead function publishes no FunctionPlan')
  throws(() => compile('let dead = (s) => { with (s) { return x } }\n' + base), /not supported/)
})

test('architecture: emission order is the frozen concrete function order', () => {
  if (onKernel()) return
  compile('let a = (x) => x + 1; export let b = (y) => a(y) * 2')
  const index = ctx.plans.programIndex
  const order = index.concreteFunctionOrder()
  is(order.map(f => f.name).join(','), ctx.funcs.list.map(f => f.name).join(','),
    'concrete order matches the closed registry exactly')
  ok(Object.isFrozen(ctx.funcs.list), 'the registry list is frozen after concrete-ID close')
  ok(order.every((f, id) => index.concreteIdOf(f) === id && index.concreteFunctionById(id) === f),
    'concrete IDs are bijective over the emission order')
})

test('invariant: ProgramIndex SCCs and reachability match an independent closure', () => {
  const count = 12
  const funcs = Array.from({ length: count }, (_, id) => ({
    name: `f${id}`, exported: id === 0,
    sig: { params: [], results: ['f64'] }, body: null,
  }))
  const pairs = [[0, 1], [1, 2], [2, 0], [2, 3], [3, 4], [4, 3],
    [5, 6], [6, 5], [7, 5], [8, 9], [10, 11], [11, 10]]
  const callSites = pairs.map(([from, to]) => ({
    callee: `f${to}`, argList: [], callerFunc: funcs[from], node: ['()', `f${to}`],
  }))
  callSites.push({ callee: 'f10', argList: [], callerFunc: null, node: ['()', 'f10'] })
  const index = buildProgramIndex({
    module: { moduleInits: [] },
    funcs: {
      list: funcs,
      map: new Map(funcs.map(func => [func.name, func])),
      names: new Set(funcs.map(func => func.name)),
      multiProp: new Map(),
    },
  }, {
    nameEscapes: new Set(), dynWriteVars: new Set(), addressTakenNames: new Set(['f7']), callSites,
  }, null)
  const graph = index.getCallGraph()
  is(graph.componentCount, 7)
  is(graph.rootIds.join(','), '0,7,10')
  is(graph.dynamicRootIds.join(','), '7')

  const reach = Array.from({ length: count }, () => new Array(count).fill(false))
  for (let id = 0; id < count; id++) reach[id][id] = true
  for (const [from, to] of pairs) reach[from][to] = true
  for (let via = 0; via < count; via++) for (let from = 0; from < count; from++)
    for (let to = 0; to < count; to++) reach[from][to] ||= reach[from][via] && reach[via][to]
  let componentMismatch = '', reachMismatch = ''
  for (let a = 0; a < count; a++) for (let b = 0; b < count; b++) {
    const sameReferenceComponent = reach[a][b] && reach[b][a]
    if (!componentMismatch && (graph.componentOf[a] === graph.componentOf[b]) !== sameReferenceComponent)
      componentMismatch = `${a},${b}`
  }
  const roots = [0, 7, 10]
  for (let id = 0; id < count; id++) {
    const expected = roots.some(root => reach[root][id])
    if (!reachMismatch && index.isGraphReachable(id) !== expected) reachMismatch = String(id)
  }
  ok(!componentMismatch, componentMismatch ? `SCC mismatch at ${componentMismatch}` : 'all SCC pairs match')
  ok(!reachMismatch, reachMismatch ? `reachability mismatch at ${reachMismatch}` : 'all reachable IDs match')
})

test('invariant: readonlyParamReps exposes get (+ the .raw restore hook), not a mutator — a stray write throws', async () => {
  const { readonlyParamReps } = await import('../src/compile/program-facts.js')
  const real = new Map([['f', new Map([[0, { val: 'NUMBER' }]])]])
  const view = readonlyParamReps(real)
  is(view.get('f').get(0).val, 'NUMBER', 'get() reads through to the real Map')
  is(view.get('missing'), undefined, 'get() of an absent key reads through cleanly')
  throws(() => view.set('g', new Map()), /is not a function/, 'no .set on the read-only view')
  throws(() => view.delete('f'), /is not a function/, 'no .delete on the read-only view')
  // .raw is plan/index.js's own restore hook (region-relocation-safe, per
  // freeze.js's own doc — a stashed local across a round() boundary can go
  // stale under the self-hosted region allocator) — it deliberately IS the
  // same live, writable Map, so reading it back out is expected to work.
  is(view.raw, real, '.raw recovers the exact same Map plan() installed')
})

test('invariant: freezeCallSites blocks structural mutation of both the array and its entries', async () => {
  const { freezeCallSites } = await import('../src/compile/program-facts.js')
  const entry = { callee: 'f', argList: [], callerFunc: null, node: ['()', 'f'] }
  const sites = [entry]
  const frozen = freezeCallSites(sites)
  is(frozen, sites, 'freezeCallSites freezes in place and returns the same array')
  throws(() => frozen.push({ callee: 'g' }), /not extensible/, 'push throws on a frozen callSites array')
  throws(() => { frozen[0] = null }, /read only property/, 'index-assignment throws on a frozen callSites array')
  throws(() => { entry.callee = 'g' }, /read only property/, 'a frozen entry cannot be retargeted after the freeze point')
})

test('invariant: assertProgramFactsShape rejects an undocumented programFacts key, always (not gated)', async () => {
  // core-simplification-audit.md §4(ii) slice 7: promoted from JZ_DEBUG_INVARIANTS-gated
  // to always-on (measured <0.03 ms/compile — negligible against whole-compile time), so
  // the throw now fires regardless of the env flag.
  const { spawnSync } = await import('node:child_process')
  const root = new URL('..', import.meta.url).pathname
  const script = `
    import { assertProgramFactsShape } from './src/compile/program-facts.js'
    const bogus = { dynVars: new Set(), programIndex: null, notARealFact: 1 }
    assertProgramFactsShape(bogus, 'test')
    console.log('no-throw')
  `
  const { JZ_DEBUG_INVARIANTS, ...envWithoutFlag } = process.env
  const unset = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env: envWithoutFlag })
  ok(unset.status !== 0, `unset JZ_DEBUG_INVARIANTS: an undocumented top-level key still throws (stderr: ${unset.stderr.toString().slice(0, 300)})`)
  ok(/notARealFact/.test(unset.stderr.toString()), `error should name the offending key: ${unset.stderr.toString().slice(0, 300)}`)
  const armed = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env: { ...envWithoutFlag, JZ_DEBUG_INVARIANTS: '1' } })
  ok(armed.status !== 0, 'JZ_DEBUG_INVARIANTS=1: an undocumented top-level key throws')
  ok(/notARealFact/.test(armed.stderr.toString()), `error should name the offending key: ${armed.stderr.toString().slice(0, 300)}`)
})

test('invariant: paramReps/callSites consumer order independence — a function\'s own compiled body does not depend on a sibling\'s declaration order', () => {
  // Proxy for "two consumers swapped in registration order": since both
  // functions' paramReps/callSites entries live in the SAME frozen Map/array
  // (keyed by name, not position) once plan()'s round 3 settles, f's own
  // narrowing/specialization must be identical whichever order the two
  // functions were declared/registered in — a real, whole-compile pin, not a
  // synthetic one, exercising the actual freeze this slice installs.
  const extractFunc = (w, name) => {
    const m = w.match(new RegExp(`\\(func \\$${name}\\b[\\s\\S]*?\\n  \\)`))
    return m && m[0]
  }
  // Local/label names carry a whole-module monotonic disambiguation counter
  // (freshId(), src/ir.js) wholly unrelated to paramReps/callSites — e.g. a
  // `let len` temp becomes `$len0` or `$len1` purely depending on how many
  // OTHER same-named temps were minted earlier in the module, which shifts
  // with declaration order by design (cosmetic renaming, not a logic
  // change; some synthesized names also carry a leading private-use marker
  // codepoint before the letters, invisible in a terminal — `\S` rather than
  // `[A-Za-z_]` so the strip isn't fooled by it). Strip each name's trailing
  // counter before comparing so the pin asserts structural/logical identity,
  // not name-supply-order identity.
  const stripIdCounters = w => w.replace(/\$(\S+?)\d+\b/g, '$$$1')
  // useF/useG give f/g a concrete internal typed-array call site, so
  // narrowSignatures/specializeBimorphicTyped settle both to a monomorphic
  // typed body (paramReps' whole reason to exist) instead of the generic
  // dyn-dispatch shape a purely-exported, never-internally-called f/g would
  // keep — the shape that actually exercises the frozen fact.
  const declaredFirst = `
    export let f = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s = s + a[i]; return s }
    export let g = (b) => { let s = 0.0; for (let i = 0; i < b.length; i++) s = s + b[i] * 2; return s }
    export let useF = () => f(new Int32Array([1, 2, 3]))
    export let useG = () => g(new Float64Array([1.5, 2.5]))
  `
  const declaredSecond = `
    export let g = (b) => { let s = 0.0; for (let i = 0; i < b.length; i++) s = s + b[i] * 2; return s }
    export let f = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s = s + a[i]; return s }
    export let useG = () => g(new Float64Array([1.5, 2.5]))
    export let useF = () => f(new Int32Array([1, 2, 3]))
  `
  const watFirst = wat(declaredFirst)
  const watSecond = wat(declaredSecond)
  const f1 = extractFunc(watFirst, 'f'), f2 = extractFunc(watSecond, 'f')
  const g1 = extractFunc(watFirst, 'g'), g2 = extractFunc(watSecond, 'g')
  ok(f1 && f2, `both compiles must emit $f: ${JSON.stringify([!!f1, !!f2])}`)
  ok(g1 && g2, `both compiles must emit $g: ${JSON.stringify([!!g1, !!g2])}`)
  is(stripIdCounters(f1), stripIdCounters(f2), 'f\'s own compiled body is structurally identical regardless of declaration order relative to g')
  is(stripIdCounters(g1), stripIdCounters(g2), 'g\'s own compiled body is structurally identical regardless of declaration order relative to f')
})

test('invariant: a guarded clone of a rest-lowered function reaches through its source family', () => {
  // `resample(data, { from, to } = {})` lowers to a rest variant; a speculative
  // typed clone of that variant resolves its identity to the unlowered root,
  // which nothing calls. The reachability gate skipped the clone while the
  // guarded call sites still named it (watr: unknown func).
  const modules = {
    './resample.js': `export default function resample(data, { from = 44100, to = 44100 } = {}) { let out = new Float32Array(Math.round(data.length * to / from)); for (let i = 0; i < out.length; i++) out[i] = data[Math.min(data.length - 1, Math.floor(i * from / to))]; return out }`,
    './shape.js': `import resample from './resample.js'
export function shape(data, fn, { fs = 44100, oversample = 1 } = {}) {
  if (oversample > 1) {
    let up = resample(data, { from: fs, to: fs * oversample })
    for (let i = 0; i < up.length; i++) up[i] = fn(up[i])
    let down = resample(up, { from: fs * oversample, to: fs })
    let out = new Float32Array(data.length)
    out.set(down.subarray(0, Math.min(data.length, down.length)))
    return out
  }
  let out = new Float32Array(data.length)
  for (let i = 0; i < data.length; i++) out[i] = fn(data[i])
  return out
}`,
    './softclip.js': `import { shape } from './shape.js'
export default function softclip(data, opts = {}) { const fn = (x) => Math.tanh(x); return shape(data, fn, { fs: opts.fs ?? 44100, oversample: opts.oversample ?? 1 }) }
export function block(buf, fs, oversample) { const fn = (x) => x * 0.5; let out = shape(buf, fn, { fs, oversample }); return out }`,
  }
  const { exports } = jz(`import softclip, { block } from './softclip.js'
export let a = (x) => softclip(new Float32Array([x]), { oversample: 2 })[0]
export let b = (x) => block(new Float32Array([x]), 48000, 1)[0]`, { modules, optimize: 2 })
  ok(Math.abs(exports.a(0.5) - Math.tanh(0.5)) < 1e-6)
  is(exports.b(4), 2)
})

test('invariant: in-process inspection preserves the selected execution compiler', async () => {
  const { spawnSync } = await import('node:child_process')
  const script = `
    import assert from 'node:assert/strict'
    import jz, {compile, _compileInProcess, _setCompileTarget} from './index.js'
    import {compileViaKernel} from './test/kernel-target.js'
    assert.throws(() => compileViaKernel('', {inspect: true}), /in-process compiler/)
    assert.throws(() => compileViaKernel('', {profile: {}}), /in-process compiler/)
    const bytes = _compileInProcess('export let f = () => 42')
    let calls = 0
    _setCompileTarget(() => { calls++; return bytes })
    const result = _compileInProcess('export let inspected = () => 1', {inspect: true})
    assert.ok(result.inspect.functions.inspected)
    assert.throws(() => _compileInProcess('export let f = () => unknownBinding'))
    assert.equal(compile('target-only source'), bytes)
    assert.equal(jz('target-only source').exports.f(), 42)
    assert.equal(calls, 2)
    _setCompileTarget(null)
    assert.equal(jz('export let f = () => 7').exports.f(), 7)
  `
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 30000,
  })
  is(r.status, 0, r.stderr || r.error?.message || 'inspection and execution keep their own compiler')
})

// Exercise developer diagnostics independently of the compiler's debug setting.
test('debug lifecycle: repeated sessions, drift and failed-session recovery', () => {
  const bridge = Object.fromEntries(['emit','flat','body','bool','idx','spread','emitIdentitySafe'].map(k => [k, () => {}]))
  const fresh = () => ({
    core: { includes: new Set(), emit: {} }, module: {}, scope: {},
    funcs: { list: [], names: new Set(), map: new Map(), multiProp: new Map() },
    func: createActiveFunction(), transform: {}, plans: {}, linkDemand: {},
    features: { sso: true, blockingTimers: false, bigint: false, error: false, errorClasses: null, timers: false },
  })
  const begin = c => { resetInvariants(bridge); assertCtxInvariants(c, 'post-reset'); assertCtxInvariants(c, 'post-prepare') }
  const end = c => { assertCtxInvariants(c, 'post-analyze'); assertCtxInvariants(c, 'pre-assemble'); assertCtxInvariants(c, 'post-compile') }
  for (const sso of [true, true, false]) {
    const c = fresh(); c.features.sso = sso
    begin(c); assertFeatureWrite('bigint'); end(c)
    throws(() => assertFeatureWrite('bigint'), /written after post-analyze/)
    throws(() => assertLinkDemandWrite('external'), /written after pre-assemble/)
  }
  let c = fresh(); begin(c)
  throws(() => assertCtxInvariants(c, 'post-prepare'), /phase out of order/)
  c = fresh(); begin(c); c.features.sso = false
  throws(() => end(c), /sso drifted/)
  c = fresh(); c.features.errorClasses = new Set(['TypeError']); begin(c)
  c.features.errorClasses.add('RangeError')
  throws(() => end(c), /errorClasses drifted/)
  c = fresh(); begin(c); delete c.features.errorClasses
  throws(() => end(c), /errorClasses missing/)
  c = fresh(); begin(c)
  throws(() => assertCtxInvariants(c, 'pre-emit'), /func.current/)
  c.func.current = { name: 'f' }; assertCtxInvariants(c, 'pre-emit')
  throws(() => end(c), /active function record/)
  throws(() => resetInvariants({}), /bridge hook 'emit' missing/)
  c = fresh(); begin(c); end(c)
  resetInvariants(bridge)
  ok(true, 'a fresh empty session completes after every failure kind')
})

test('debug lifecycle: real compiles retain semantics across shape changes and errors', () => {
  const entry = new URL('../index.js', import.meta.url).href
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import jz from ${JSON.stringify(entry)}
    const sources = [
      'export function f(){return 0}',
      'export function f(){let p={x:1,y:2};p={x:3};return p.x}',
      'export function f(){let p={x:1,y:2};p={x:3};p.y=4;return p.y}'
    ]
    const values = []
    for (const i of [0,0,1,2]) values.push(jz(sources[i]).exports.f())
    try { jz('export function f( {') } catch {}
    values.push(jz(sources[0]).exports.f())
    console.log(JSON.stringify(values))
  `], { env: { ...process.env, JZ_DEBUG_INVARIANTS: '1' }, encoding: 'utf8', timeout: 30000 })
  is(child.status, 0, child.stderr)
  is(JSON.parse(child.stdout), [0,0,3,4,0], 'A → A → different shapes → error → A')
})
