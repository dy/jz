/**
 * That fix is necessary for region-arena correctness, but it only holds the compiler's
 * OWN observable behavior steady if loading a module has NO effect beyond registering
 * its ctx.core.emit/ctx.core.stdlib entries — the moment some module's init(ctx) does
 * anything else unconditionally (write ctx.closure/ctx.types/ctx.scope state, call
 * hostImport/inc/declGlobal outside a lazily-invoked emit handler), eager loading
 * changes emitted bytes for programs that never asked for that module's feature at all,
 * or worse, changes which dispatch tier a method call resolves through.
 *
 * This file proves the invariant NATIVELY — no region-arena mark/exit
 * machinery needed. `opts._eagerStdlib` (src/front.js, index.js) forces the
 * SAME includeAllMods() call, so `compile(src, opts)` vs `compile(src,
 * {...opts, _eagerStdlib:true})` on IDENTICAL source is the exact
 * "includeAllMods() forced vs default" comparison.
 */
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { CORPUS } from './_kernel-corpus.js'
import { onKernel } from './_matrix.js'
import { compile } from './util.js'

// _eagerStdlib is a host-side opts field (index.js's jzCompileInner) — the
// kernel target routes around jzCompileInner entirely (see _matrix.js's
// onKernel doc), so it has nothing to prove there.
const skip = onKernel()

const bytesEqual = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0

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

// A runtime helper's arm for a module (ToString's typed-array join, a Date's
// text, ToPrimitive's Date time) follows what the source requires, the demanded
// modules and what they depend on (ctx.module.required), not what preload ran.
test('eager-stdlib parity: ToString of an unknown value is byte-identical under eager preload', () => {
  if (skip) return
  for (const src of ['export let s = (n) => String(n)', 'export let s = (n) => `<${{ v: n }}>` + String(n > 1 ? null : { k: n })',
    'export let s = (n) => [n, n + 1].join() + ("" + { v: n })'])
    for (const host of ['js', 'wasi']) {
      const lazy = compile(src, { host, optimize: 0 }), eager = compile(src, { host, optimize: 0, _eagerStdlib: true })
      ok(bytesEqual(lazy, eager), `${src} @${host}: ${lazy.length}B lazy, ${eager.length}B eager`)
    }
})
