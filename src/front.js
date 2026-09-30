/**
 * Canonical compile FRONT HALF — the one semantic pipeline every entry runs:
 *
 *   parse → liftIIFEs → jzify → prepare → preEval
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
import { ctx } from './ctx.js'
import { markSource } from './ast.js'
import { liftIIFEs } from './prepare/lift-iife.js'
import { prepareImports, programModuleAsts, importedBinding } from './prepare/handlers.js'
import prepare from './prepare/index.js'
import { preEval } from './prepare/pre-eval.js'
import { includeAllMods } from './autoload.js'

/** source → preEval'd prepared AST (the tree compileAst consumes).
 * `eagerStdlib` is a test-only switch proving that module registration order
 * cannot affect emitted output; production keeps lazy on-demand loading. */
export function frontHalf(code, { strict, sourceType = 'jz', jzify, time = (n, f) => f(), afterPrepare, eagerStdlib } = {}) {
  if (eagerStdlib) includeAllMods()
  let parsed = time('parse', () => parse(code, sourceType))
  if (ctx.transform.sourceMap) markSource(parsed)
  // Lambda-lift immediately-invoked arrow literals to typed direct calls — lets SIMD
  // flow through the f64-only closure ABI and drops the closure for every IIFE. Runs
  // BEFORE jzify so it only sees USER arrow IIFEs, not jzify's synthetic wrapper IIFEs
  // (named/recursive function expressions, method shorthand), which keep the closure
  // path. A no-op when there are none.
  parsed = time('liftIIFE', () => liftIIFEs(parsed))
  if (!strict && jzify) { time('prepare', () => { jzify.witness?.(programModuleAsts(parsed)); prepareImports(parsed) }); parsed = time('jzify', () => jzify(parsed, { importedBinding })) }
  const ast = time('prepare', () => prepare(parsed))
  if (afterPrepare) afterPrepare()
  // preEval: fold every statically-evaluable construct (numeric/string/bool chains,
  // pure Math.* calls, zero-arg pure calls incl. lift-iife's IIFEs) down to literals,
  // over every module initializer and function body, before compile sees them.
  return time('preEval', () => preEval(ast))
}
