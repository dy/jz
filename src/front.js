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
import { err } from './ctx.js'
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
 * `eagerStdlib` is a test-only switch proving that module registration order
 * cannot affect emitted output; production keeps lazy on-demand loading. */
export function frontHalf(code, { strict, sourceType = 'jz', jzify, time = (n, f) => f(), afterPrepare, eagerStdlib } = {}) {
  if (eagerStdlib) includeAllMods()
  let parsed = time('parse', () => parse(code, sourceType))
  if (typeof code === 'string' && code.includes(T)) rejectReservedPrefix(parsed)
  // Lambda-lift immediately-invoked arrow literals to typed direct calls — lets SIMD
  // flow through the f64-only closure ABI and drops the closure for every IIFE. Runs
  // BEFORE jzify so it only sees USER arrow IIFEs, not jzify's synthetic wrapper IIFEs
  // (named/recursive function expressions, method shorthand), which keep the closure
  // path. A no-op when there are none.
  parsed = time('liftIIFE', () => liftIIFEs(parsed))
  if (!strict && jzify) parsed = time('jzify', () => jzify(parsed))
  const ast = time('prepare', () => prepare(parsed))
  if (afterPrepare) afterPrepare()
  // preEval: fold every statically-evaluable construct (numeric/string/bool chains,
  // pure Math.* calls, zero-arg pure calls incl. lift-iife's IIFEs) down to literals,
  // over the prepared AST + every ctx.funcs.list body, before compile ever sees them.
  return time('preEval', () => preEval(ast))
}
