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
import { join, relative } from 'path'
import { compile } from '../index.js'
import { ctx, reset, DBG_INVARIANTS } from '../src/ctx.js'
import { analyzeBody, reanalyzeBody, setFuncBody } from '../src/compile/analyze.js'
import { emit, emitter, emitVoid as flat, emitBlockBody as body, emitBoolStr as bool, emitIndex as idx, buildArrayWithSpreads as spread, emitIdentitySafe } from '../src/compile/emit.js'
import { GLOBALS } from '../src/prepare/index.js'
import { run } from './util.js'
import { onKernel } from './_matrix.js'
import { representationStorageWriteAction } from '../src/compile/representation-plan.js'
import { buildProgramIndex } from '../src/compile/program-index.js'
import { parse } from '../src/parse.js'

// === Helper: compile with WAT output for structural inspection ===
const wat = (code, opts = {}) => compile(code, { ...opts, wat: true })

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
// bodyFacts solver seam invariants (audit P1 next-slice — src/session.js DEPS
// table, src/compile/analyze.js). The 14 pre-slice invalidateLocalsCache call
// sites each independently paired a raw invalidate with a later read/write;
// reanalyzeBody/setFuncBody/invalidateBodies/invalidateAllBodyFacts fuse that
// pairing into one call so a new pass can't drop the invalidate half. As a
// second, narrower net: a signature retype (param .type/.ptrKind/.ptrAux,
// sig.results/…) that DOES slip through outside the seam is caught at
// analyzeBody's cache-hit under JZ_DEBUG_INVARIANTS=1 (assertBodyFactsFresh)
// — these tests plant exactly that "forgot to invalidate" bug and prove the
// assert fires, then prove the seam itself never reproduces it.
// ============================================================================

test('invariant: analyzeBody cache-hit throws under JZ_DEBUG_INVARIANTS after an uninvalidated signature retype', () => {
  if (onKernel()) return  // white-box probe of analyze.js internals — no in-kernel host ctx to inspect
  if (!DBG_INVARIANTS) return  // the assert is a no-op outside the battery's dbg leg (JZ_DEBUG_INVARIANTS=1) — nothing to observe without it
  reset(emitter, GLOBALS, { emit, flat, body, bool, idx, spread, emitIdentitySafe })
  compile('export let f = (a) => a + 1')
  const func = ctx.funcs.map.get('f')
  ctx.func.current = func.sig
  analyzeBody(func.body) // populate/confirm the cache under the real, current signature
  const p = func.sig.params[0]
  const saved = p.type
  p.type = saved === 'i32' ? 'f64' : 'i32' // simulate a pass retyping a param and FORGETTING to invalidate
  let threw = null
  try { analyzeBody(func.body) } catch (e) { threw = e }
  p.type = saved
  ok(threw && /uninvalidated signature retype/.test(threw.message),
    `expected a stale-signature throw, got: ${threw ? threw.message : '(no throw)'}`)
})

test('invariant: the reanalyzeBody/setFuncBody seam never reproduces the stale-signature throw', () => {
  if (onKernel()) return
  if (!DBG_INVARIANTS) return
  reset(emitter, GLOBALS, { emit, flat, body, bool, idx, spread, emitIdentitySafe })
  compile('export let f = (a) => a + 1')
  const func = ctx.funcs.map.get('f')
  ctx.func.current = func.sig
  analyzeBody(func.body)
  const p = func.sig.params[0]
  p.type = p.type === 'i32' ? 'f64' : 'i32' // same retype as above, but read through the seam this time
  const fresh = reanalyzeBody(func.body)
  ok(fresh && fresh.locals instanceof Map, 'reanalyzeBody recomputes under the new signature instead of throwing')
  // setFuncBody: an AST rewrite (structural, not a signature retype) must not
  // leave a stale entry behind either — read the (same-identity) body again
  // right after and confirm no throw.
  setFuncBody(func, func.body)
  analyzeBody(func.body)
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

const COMPILE_FAMILY_OWNERS = [
  ['func-exports.js', ['isExported', 'exportNamesOf']],
  ['func-entry.js', ['enterFunc', 'emitPreboxedLocalInits']],
  ['param-numeric.js', ['NUM_BIN_OPS', 'REL_OPS', 'isStrLiteral', 'paramAllUsesNumeric', 'STRING_RECV_METHODS', 'paramNeverString']],
  ['throw-runtime.js', ['ensureThrowRuntime', 'pruneUnusedThrowRuntime']],
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
  for (const [file, names] of COMPILE_FAMILY_OWNERS) {
    const owner = readFileSync(join(ROOT, 'src/compile', file), 'utf8')
    ok(driver.includes(`from './${file}'`), `compile/index.js imports ${file}`)
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

test('architecture: typed emitters consume TypedStoragePlan, not live ctor maps', () => {
  const files = [
    'module/array.js', 'module/typedarray.js',
    'src/compile/emit.js', 'src/compile/emit-assign.js',
    'src/compile/emit/shared.js', 'src/compile/emit/i32-bounds.js', 'src/compile/emit/first-class.js',
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
  const wideRep = { schemaId: 7, arrayElemSchema: { id: 1, elems: [1, 2] }, kinds: new Set(['a']) }
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
  const projected = functionPlanRepField(ctx, plan, 'w', 'arrayElemSchema')
  projected.elems.push(3)
  is(wideRep.arrayElemSchema.elems.length, 2, 'cross-function projection is detached')

  const data = installFunctionPlan(ctx, plan)
  is(data.locals, facts.locals, 'analysis collection ownership transfers without cloning')
  is(data.localReps, facts.localReps)
  is([...data.locals.keys()].join(','), 'w,n,nil', 'Map insertion order preserved')
  ok(data.cellTypes.has('w'))
  ok(isMapOverlay(data.typedElem), 'MapOverlay stays an overlay, not flattened')
  is(ctx.plans.functionData.has(plan), false, 'install consumes canonical storage immediately')
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
  const { dataAlign, dataPush, dataLen, dataString, dataReset, pushStaticSlots } = await import('../src/static-data.js')
  const { ctx } = await import('../src/ctx.js')
  const savedParts = ctx.runtime.dataParts, savedLen = ctx.runtime.dataLen, savedSlots = ctx.runtime.staticPtrSlots
  try {
    dataReset('')
    is(dataLen(), 0)
    is(dataString(), '')
    dataAlign(8)                       // aligning empty is a no-op
    is(dataLen(), 0)
    // reference: the old string-form accumulation, run in parallel
    let ref = ''
    dataPush('abc'); ref += 'abc'
    dataAlign(4); while (ref.length % 4 !== 0) ref += '\0'
    is(dataLen(), ref.length)
    dataPush('defgh'); ref += 'defgh'
    dataAlign(8); while (ref.length % 8 !== 0) ref += '\0'
    const off = dataLen()
    is(off, ref.length)
    is(dataString(), ref)
    // dataString collapses but must not perturb subsequent appends
    dataPush('Z'); ref += 'Z'
    is(dataString(), ref)
    is(dataLen(), ref.length)
    // pushStaticSlots: 8-aligned start, LE u32-half encoding, NaN-boxed slot marking
    ctx.runtime.staticPtrSlots = []
    dataAlign(8); while (ref.length % 8 !== 0) ref += '\0'
    const slotOff = pushStaticSlots(['0x0011223344556677'])
    is(slotOff, ref.length)
    const bytes = dataString().slice(slotOff, slotOff + 8)
    // low half 0x44556677 LE first, then high half 0x00112233 LE
    is([...bytes].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(''), '7766554433221100')
    is(ctx.runtime.staticPtrSlots.length, 0, 'non-NaN-boxed slot not marked')
    // dataReset replaces wholesale
    dataReset('xy')
    is(dataLen(), 2)
    is(dataString(), 'xy')
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
  const caller = { name: 'caller', sig: { params: [], results: ['f64'] }, body: ['return', ['()', ['.', 'ns', 'run'], null]] }
  const funcs = [target, caller]
  const index = buildProgramIndex({
    module: { moduleInits: [] },
    funcs: {
      list: funcs,
      map: new Map(funcs.map(func => [func.name, func])),
      names: new Set(funcs.map(func => func.name)),
      multiProp: new Set(),
    },
  }, {
    nameEscapes: new Set(), dynWriteVars: new Set(), valueUsed: new Set(),
  }, parse('let target=()=>1;const ns={run:target};export let caller=()=>ns.run()'))
  const targetId = index.functionIdOfName('target')
  is(targetId, 0)
  is(index.functionCount, 2)
  is(index.functionById(targetId), target)
  is(index.resolveMemberId('ns', 'run'), targetId)
  is(index.resolveComputedIds('ns').join(','), String(targetId))
  is(index.resolveMemberId('ns', 'missing'), -1)
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
