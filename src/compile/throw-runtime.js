import { ctx, declGlobal } from '../ctx.js'

export const ensureThrowRuntime = (sec) => {
  // A pulled stdlib helper may throw $__jz_err even when no user `throw` set the
  // flag (e.g. __to_num on a Symbol). Detect it from the included stdlib bodies
  // so the $__jz_err tag is always present when something can raise it.
  if (!ctx.runtime.throws && [...ctx.core.includes].some(n => {
    const body = ctx.core.stdlib[n]
    return typeof body === 'string' && body.includes('(throw ')
  })) ctx.runtime.throws = true
  if (!ctx.runtime.throws) return

  if (!ctx.scope.globals.has('__jz_last_err_bits'))
    declGlobal('__jz_last_err_bits', 'i64')
  if (!sec.tags.some(t => Array.isArray(t) && t[0] === 'tag' && t[1] === '$__jz_err'))
    sec.tags.push(['tag', '$__jz_err', ['param', 'f64']])
  if (!sec.tags.some(t => Array.isArray(t) && t[0] === 'export' && t[1] === '"__jz_last_err_bits"'))
    sec.tags.push(['export', '"__jz_last_err_bits"', ['global', '$__jz_last_err_bits']])
}

// Drop the $__jz_err TAG (not the last-err global) when no throw can be CAUGHT.
// ensureThrowRuntime runs before optimizeModule so dead-throw analysis sees the
// tag as live; once opt has finished, an unused tag still forces consumers
// (wasmtime, wasm2c, wabt) to enable the exceptions proposal just to PARSE the module.
//
// When `!userThrows`, every `throw` is compiler-internal (bounds / coercion / type
// errors) and — with no user try/catch — uncatchable IN WASM: nothing inside the
// module inspects the thrown value, so it is semantically a trap there. The
// exceptions proposal is needed only to DECLARE the tag a `throw` references;
// lowering each surviving uncatchable throw to `unreachable` keeps the module in
// the wasm MVP, so every runtime can parse it (V8 alone enables exceptions by
// default, which masked this). A pure-recursion or typed-array kernel (nqueens,
// anything pulling __to_num) thus stops emitting a Tag section it can never use.
// User-written throw/try/catch/finally is an ABI contract (JS-side may inspect
// __jz_last_err_bits), so `userThrows` keeps the tag + exceptions runtime intact.
//
// `__jz_last_err_bits` itself is KEPT (global + export + every `global.set`) even
// on this trap path: it is plain mutable-i64 wasm MVP (no exceptions proposal
// needed to declare or write it), and it is the ONLY signal that survives an
// `unreachable` trap to the host boundary. Every internal throw site writes it
// immediately before its (now-trap) throw, so interop.js's decodeThrown can read
// it out of the trapped instance and resolve the code via err-codes.js — turning
// an otherwise-opaque `RuntimeError: unreachable` into the real ECMAScript error
// class the site models. Stripping this global would make host decode of
// ordinary runtime errors unreachable by construction, so it must stay.
// `noEhAbort` (opts.noEhAbort → --no-eh-abort, index.js): opt-in generalization
// of the trap-lowering above for consumers with NO wasm-exceptions support at
// all (wasm2c, w2c2 — see bench/README's native-lane / lab-row notes). Without
// it, `userThrows` is a coarse proxy: it goes true the moment source has ANY
// `throw` statement, even one with no reachable `try`/`catch` anywhere (e.g. a
// parser's `throw SyntaxError(...)` on malformed input, never caught by
// design) — so a case can carry a live-but-unreachable exceptions tag purely
// because of a bare throw. With the flag, that coarse gate is replaced by the
// SAME hasCatch() scan already below: it still unconditionally bails (no-ops,
// zero behavior change) the instant a real `try_table`/`catch`/`catch_all`
// exists anywhere in the module — so this can never silently turn a genuinely
// CAUGHT throw into a trap. It only unlocks the prune for modules that have
// throws but structurally zero catches, regardless of why userThrows got set.
export const pruneUnusedThrowRuntime = (sec) => {
  if (!ctx.runtime.throws) return
  if (ctx.runtime.userThrows && !ctx.transform.noEhAbort) return
  // A catch handler (try_table) means SOME throw is caught; bail unconditionally
  // (with or without noEhAbort) so a caught throw is never silently turned into
  // a trap — this scan is the sole safety net once userThrows no longer gates.
  // Note this also fires for a bare `try { … } finally { … }` with NO catch
  // clause at all: jz's own `finally` codegen still needs an internal
  // try_table/catch(-rethrow) to run the cleanup on the exceptional path, so
  // it is exactly as unsafe to trap-lower as a real user catch. For example,
  // subscript's switch-parsing feature — reachable from the `jessie` bench
  // case even though it has zero `catch` clauses anywhere — uses try/finally
  // for its `inSwitch` depth counter, and this scan correctly refuses to
  // prune it.
  const hasCatch = (n) => Array.isArray(n) &&
    (n[0] === 'try_table' || n[0] === 'catch' || n[0] === 'catch_all' || n.some(hasCatch))
  for (const arr of [sec.funcs, sec.stdlib, sec.start])
    for (const f of arr) if (hasCatch(f)) return
  // Rewrite every surviving `(throw $__jz_err …)` to `(unreachable)` (same polymorphic
  // stack type — a drop-in in any position). The thrown operand is side-effect-free
  // (a local read / const), so dropping it loses nothing. The preceding
  // `(global.set $__jz_last_err_bits …)` at each site is left untouched — see above.
  const lowerThrows = (n) => {
    if (!Array.isArray(n)) return n
    if (n[0] === 'throw') return ['unreachable']
    for (let i = 1; i < n.length; i++) n[i] = lowerThrows(n[i])
    return n
  }
  for (const arr of [sec.funcs, sec.stdlib, sec.start])
    for (let i = 0; i < arr.length; i++) arr[i] = lowerThrows(arr[i])
  sec.tags = sec.tags.filter(t => !(Array.isArray(t) &&
    (t[0] === 'tag' && t[1] === '$__jz_err')))
}
