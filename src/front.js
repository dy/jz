/**
 * Canonical compile FRONT HALF — the one semantic pipeline every entry runs:
 *
 *   parse → reject-reserved-prefix → liftIIFEs → jzify → prepare → preEval
 *
 * Host (index.js jzCompileInner) and self-compile kernel (scripts/self.js — ALL
 * entries: compileSelf, compileWat, compileWarnings, compileDiag) MUST consume
 * THIS function, not a re-implementation, so the two pipelines cannot drift —
 * a kernel entry that skips a step here (e.g. preEval) folds constants
 * differently from the host (`0.1 + 0.2 - 0.3` gets different result bits) and
 * emits different code size for the same source, an observable semantic split
 * the parity corpus needs every step exercised to catch.
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
import { includeAllMods } from './autoload.js'

// U+E000 (T) prefixes every jz-generated local. The JS spec forbids it in
// identifiers, but subscript's parser is lenient and accepts it — so a user name
// carrying it could silently alias a compiler temp. Reject it in identifier
// position on the RAW parse (before jzify, which legitimately mints T-prefixed
// temps of its own). String-literal nodes are `[null, …]` and skipped, so
// `"……"` data is fine; only walked when the char is present in source.
const rejectReservedPrefix = (node) => {
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
 *  `regionHooks` (region-arena FRONT boundary, .work/evidence.md §Region
 *  arena): optional `{ mark, exit }` pair, the same optimizeTail-shaped
 *  contract the round boundary (scripts/self.js's own `regionHooks` on
 *  `watrTail`) already uses — supplied ONLY by the self-compile kernel entry
 *  (scripts/self.js), never by the native host pipeline (index.js never
 *  passes this option). When present, wraps parse→liftIIFE→jzify→prepare in
 *  one region round: every allocation that span makes gets reclaimed at
 *  `exit` EXCEPT what's reachable from the root.
 *  UNION-FIELD ROOT (see `.work/archive/compile-session-design.md` §2.1/§3 and
 *  `.work/evidence.md`'s region-arena entry): the root MUST be the UNION of
 *  every `ctx.*` field ANY region round needs (`funcs, module, schema,
 *  closure, scope, types, warnings, plans, inspect, func, transform, facts`
 *  — 12 fields), applied UNIFORMLY at every round-exit call site — never
 *  each site's own hand-picked subset, which silently drops a field some
 *  OTHER round needs and leaves it collected out from under a live
 *  reference. The remaining `ctx.*` fields (`core, bridge, names, runtime,
 *  memory, error, abi, features, linkDemand`) must stay OUT of the root:
 *  `ctx.core.emit`/`ctx.core.stdlib`/`ctx.bridge` carry hundreds of
 *  CLOSURE-valued properties (the self-compiled stdlib registration
 *  machinery) that the region-arena relocation walk is not proven safe
 *  against. `ctx` itself is NEVER a root element here — only its individual
 *  fields are, so no `setSession()` rebind seam is needed. Any later read
 *  through a stale `ast`/`ctx.*` binding is a use-after-free.
 *  PRE-MARK MODULE LOAD (`.work/archive/region-release-notes.md` "ROOT CAUSE FOUND"):
 *  `prepare()`'s own first line unconditionally calls `includeModule('core')`,
 *  and several later, source-dependent branches call `includeModule(mod)` for
 *  other stdlib modules. `includeModule` runs a module's `init(ctx)` on first
 *  load, writing hundreds of fresh CLOSURE values into `ctx.core.emit`/
 *  `ctx.core.stdlib` — exactly the fields the paragraph above says can never
 *  be rooted (rooting them wholesale was tried — commit 7085cb57 — and made
 *  the regression WORSE). A module loaded mid-round (after `mark()`, before
 *  `exit()`) allocates its whole closure table into the ephemeral zone with
 *  no root path to it, so `exit()` silently abandons it — `ctx.core.emit`
 *  keeps its identity (durable container, allocated at `reset()`) but every
 *  property it just gained now points into reclaimed memory. Load every
 *  stdlib module here, BEFORE `mark()`, so nothing `prepare()` might
 *  conditionally load — 'core' unconditionally, others by source content —
 *  can ever be the first-ever load of a module while a round is active.
 *  `includeModule` is idempotent (its own `ctx.module.modules` guard), so
 *  this costs one bounded, one-time-per-compile registration pass; gated on
 *  `regionHooks` so the native host pipeline (which never sees a region
 *  round) keeps its existing lazy, on-demand load order unchanged. The list
 *  is autoload.js's STDLIB (a mirror of the manifest's export list, pinned in
 *  sync by test/self-compile-includes.js) — the self-hosted kernel cannot
 *  enumerate a namespace import.
 *  `eagerStdlib` (test-only, index.js opts._eagerStdlib): forces the SAME
 *  eager `includeAllMods()` call independent of `regionHooks`, so the
 *  "module load = registration only, no observable output effect" invariant
 *  (test/eager-stdlib-parity.js) can be pinned NATIVELY — no region-arena
 *  mark/exit machinery needed to prove a module's init(ctx) is pure
 *  registration; loading it early must never change emitted bytes/imports. */
export function frontHalf(code, { strict, sourceType = 'jz', jzify, time = (n, f) => f(), afterPrepare, regionHooks, eagerStdlib } = {}) {
  if (regionHooks || eagerStdlib) includeAllMods()
  const mark = regionHooks?.mark()
  let parsed = time('parse', () => parse(code, sourceType))
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
