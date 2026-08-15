/**
 * Canonical compile FRONT HALF — the one semantic pipeline every entry runs:
 *
 *   parse → reject-reserved-prefix → liftIIFEs → jzify → prepare → preEval
 *
 * Host (index.js jzCompileInner) and self-host kernel (scripts/self.js — ALL
 * entries: compileSelf, compileWat, compileWarnings, compileDiag) consume THIS
 * function, so the two pipelines cannot drift. They previously did: the kernel
 * entries skipped preEval entirely, so `0.1 + 0.2 - 0.3` folded natively but
 * not in-kernel (different result bits), and `Math.sqrt(9) + Math.abs(-2)`
 * emitted 76ch natively vs 139ch in-kernel at O0 — an observable semantic
 * split the 12-row parity corpus never exercised (audit P0, 2026-07-25).
 *
 * `jzify` is injected, not imported: both callers own their jzify binding
 * (host imports it, the kernel also wires it into ctx.transform for module
 * bundling), and keeping it a parameter adds no import edge from src/ into
 * jzify/. `time` is the host profiler hook (kernel passes none) and
 * `afterPrepare` is the host's post-prepare ctx-invariant assertion point.
 *
 * @module src/front
 */
import { parse } from './parse.js'
import { ctx, err } from './ctx.js'
import { T } from './ast.js'
import { liftIIFEs } from './prepare/lift-iife.js'
import prepare from './prepare/index.js'
import { preEval } from './prepare/pre-eval.js'

// U+E000 (T) prefixes every jz-generated local. The JS spec forbids it in
// identifiers, but subscript's parser is lenient and accepts it — so a user name
// carrying it could silently alias a compiler temp. Reject it in identifier
// position on the RAW parse (before jzify, which legitimately mints T-prefixed
// temps of its own). String-literal nodes are `[null, …]` and skipped, so
// `"……"` data is fine; only walked when the char is present in source.
export const rejectReservedPrefix = (node) => {
  if (!Array.isArray(node)) return
  if (node.length === 2 && node[0] == null) return   // [null, X] — value literal, not an identifier
  for (let i = 1; i < node.length; i++) {
    const v = node[i]
    if (typeof v === 'string') {
      if (v.includes(T)) err(`identifier '${v.split(T).join('\\uE000')}' contains the reserved compiler prefix (U+E000) — jz uses it for generated locals; rename it`)
    } else rejectReservedPrefix(v)
  }
}

/** source → preEval'd prepared AST (the tree compileAst consumes).
 *  `regionHooks` (region-arena FRONT boundary, .work/research.md §Region
 *  arena): optional `{ mark, exit }` pair, the same optimizeTail-shaped
 *  contract the round boundary (scripts/self.js's own `regionHooks` on
 *  `watrTail`) already uses — supplied ONLY by the self-host kernel entry
 *  (scripts/self.js), never by the native host pipeline (index.js never
 *  passes this option). When present, wraps parse→liftIIFE→jzify→prepare in
 *  one region round: every allocation that span makes gets reclaimed at
 *  `exit` EXCEPT what's reachable from the root.
 *  UNION-FIELD ROOT (Slice C-v2, `.work/compile-session-design.md` §2.1/§3,
 *  revised after the region-live gate — see `.work/research.md`'s Slice D
 *  entry): the root is the UNION of every `ctx.*` field ANY region round in
 *  this campaign has ever needed (`funcs, module, schema, closure, scope,
 *  types, warnings, plans, inspect, func, transform, facts` — 12 fields),
 *  applied UNIFORMLY at all nine round-exit call sites instead of each
 *  site's own hand-picked subset — the seven-times-repeated root-
 *  completeness defect class (ns-round-2026-08-14's dig found THIS exact
 *  array rooting a dead `ctx.func.list`) is closed the same way a full
 *  `[ast, ctx]` wholesale-session root would close it, WITHOUT exposing
 *  the nine fields no round has ever touched (`core, bridge, names,
 *  runtime, memory, error, abi, features, linkDemand` — `ctx.core.emit`/
 *  `ctx.core.stdlib`/`ctx.bridge` in particular carry hundreds of CLOSURE-
 *  valued properties, the self-hosted stdlib registration machinery,
 *  `__region_copy_rec` was never exercised against under region-live: the
 *  wholesale-`ctx` attempt traded the JS-level `Unknown op: ++` AST-
 *  corruption signature for a WASM-level `memory access out of
 *  bounds`/`unreachable` trap signature — DIFFERENT, not fixed, evidence
 *  the newly-exposed subtrees are where the regression actually lives).
 *  `ctx` itself is NEVER a root element here — only its individual fields
 *  are, exactly as before Slice B's identity-swap, so no `setSession()`
 *  rebind seam is needed. Any later read through a stale `ast`/`ctx.*`
 *  binding is a use-after-free. */
export function frontHalf(code, { strict, jzify, time = (n, f) => f(), afterPrepare, regionHooks } = {}) {
  const mark = regionHooks?.mark()
  let parsed = time('parse', () => parse(code))
  if (typeof code === 'string' && code.includes(T)) rejectReservedPrefix(parsed)
  // Lambda-lift immediately-invoked arrow literals to typed direct calls — lets SIMD
  // flow through the f64-only closure ABI and drops the closure for every IIFE. Runs
  // BEFORE jzify so it only sees USER arrow IIFEs, not jzify's synthetic wrapper IIFEs
  // (named/recursive function expressions, method shorthand), which keep the closure
  // path. A no-op when there are none.
  parsed = time('liftIIFE', () => liftIIFEs(parsed))
  if (!strict && jzify) parsed = time('jzify', () => jzify(parsed))
  let ast = time('prepare', () => prepare(parsed))
  if (afterPrepare) afterPrepare()
  if (regionHooks) {
    ;[ast, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts] =
      regionHooks.exit(mark, [ast, ctx.funcs, ctx.module, ctx.schema, ctx.closure, ctx.scope, ctx.types, ctx.warnings, ctx.plans, ctx.inspect, ctx.func, ctx.transform, ctx.facts])
  }
  // preEval: fold every statically-evaluable construct (numeric/string/bool chains,
  // pure Math.* calls, zero-arg pure calls incl. lift-iife's IIFEs) down to literals,
  // over the prepared AST + every ctx.funcs.list body, before compile ever sees them.
  return time('preEval', () => preEval(ast))
}
