/**
 * "Module load = registration only" — the region-arena front round (src/front.js
 * includeAllMods()) loads every stdlib module BEFORE `mark()`, so no first-ever
 * module init(ctx) can allocate into an unrooted region round (.work/archive/region-
 * release-notes.md "ROOT CAUSE FOUND"). That fix is necessary for region-arena
 * correctness, but it only holds the compiler's OWN observable behavior steady
 * if loading a module has NO effect beyond registering its ctx.core.emit/
 * ctx.core.stdlib entries — the moment some module's init(ctx) does anything
 * else unconditionally (write ctx.closure/ctx.types/ctx.scope state, call
 * hostImport/inc/declGlobal outside a lazily-invoked emit handler), eager
 * loading changes emitted bytes for programs that never asked for that
 * module's feature at all (.work/archive/region-release-notes.md "Class 1"), or worse,
 * changes which dispatch tier a method call resolves through ("Class 2").
 *
 * This file proves the invariant NATIVELY — no region-arena mark/exit
 * machinery needed. `opts._eagerStdlib` (src/front.js, index.js) forces the
 * SAME includeAllMods() call independent of regionHooks, so `compile(src,
 * opts)` vs `compile(src, {...opts, _eagerStdlib:true})` on IDENTICAL source
 * is the exact "includeAllMods() forced vs default" comparison.
 *
 * @module test/eager-stdlib-parity
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile } from '../index.js'
import { CORPUS } from './kernel-parity.js'
import { onKernel } from './_matrix.js'

// _eagerStdlib is a host-side opts field (index.js's jzCompileInner) — the
// kernel target routes around jzCompileInner entirely (see _matrix.js's
// onKernel doc), so it has nothing to prove there.
const skip = onKernel()

const bytesEqual = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0

// Byte-identical eager vs lazy, both hosts, at O0. Date schema registration
// is demand-lazy, tied call-count functions sort by name, and DataView setters
// return undefined explicitly, so every former eager-load gap belongs in the
// ordinary parity loop.
for (const host of ['js', 'wasi']) {
  for (const [name, src] of Object.entries(CORPUS)) {
    test(`eager-stdlib parity: ${name} @ host:${host} — includeAllMods() forced is byte-identical to default`, () => {
      if (skip) return
      const lazy = compile(src, { host, optimize: 0 })
      const eager = compile(src, { host, optimize: 0, _eagerStdlib: true })
      ok(bytesEqual(lazy, eager), `${name}@${host}: eager preload changed emitted bytes (${lazy.length}B → ${eager.length}B) — a module's init(ctx) has a non-registration, non-demand-gated effect`)
    })
  }
}

// Class 2 (dispatch-tier eager-load divergence, this session's other finding,
// fixed in d1f4b585): a compile-time REJECT must fire identically whether or
// not the fn/string/etc. modules were eager-preloaded — before the fix,
// tryDynamicPropCall's `if (ctx.closure.call)` gate (now additionally
// `&& ctx.module.demanded.has('fn')`) let this silently compile once `fn`
// was eager-loaded, because ctx.closure.call is truthy the moment `fn`
// merely registers, regardless of whether the source ever created a closure.
test('eager-stdlib parity: unknown method on a proven array still rejects under eager preload', () => {
  if (skip) return
  const src = 'export let f = () => [3,1,2].frobnicate()'
  const catchMsg = (opts) => { try { compile(src, opts); return null } catch (e) { return e.message } }
  const lazyMsg = catchMsg({ host: 'js', optimize: 0 })
  const eagerMsg = catchMsg({ host: 'js', optimize: 0, _eagerStdlib: true })
  ok(lazyMsg && /frobnicate/.test(lazyMsg), `lazy must reject mentioning 'frobnicate', got: ${lazyMsg}`)
  ok(eagerMsg && /frobnicate/.test(eagerMsg), `eager must ALSO reject mentioning 'frobnicate' (Class 2 regression if this compiles), got: ${eagerMsg}`)
  is(eagerMsg, lazyMsg, 'the reject message must be identical, not just "some error"')
})
