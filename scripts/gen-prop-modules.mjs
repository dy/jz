#!/usr/bin/env node
// Regenerates src/prop-modules.generated.js — the property/method-name to
// stdlib-module table `includeForProperty` (src/autoload.js) consults at
// prepare() time — from the stdlib modules' OWN registrations, instead of
// hand-typed rows.
//
// WHY: prepare() runs before value-type inference (analyze()), so when it sees
// `.prop`, it can't yet know which VAL kind the receiver resolves to — it must
// conservatively load every module whose `.prop`/`.kind:prop` emitter that
// spelling could dispatch to at emit time (src/compile/emit.js's
// tryStaticDispatch / tryRuntimePtrTypeFork). The table encoding "which modules
// could that be" used to be hand-maintained (PROP_MODULES) and could silently
// drift from the real registrations — a missing row was exactly the
// length-registration crash this generator's introduction fixes structurally:
// a hand row can be wrong or incomplete, a derived one can't (it IS the
// registrations).
//
// HOW: drive every stdlib module through includeModule() once, in a throwaway
// session, and observe — via includeModule's optional `onRegister` hook — which
// module's init(ctx) call caused which `ctx.core.emit` keys to appear. Every
// property-dispatch key follows one of two shapes (see tryStaticDispatch /
// tryRuntimePtrTypeFork): bare `.method` (the generic/unresolved-vt fallback) or
// `.kind:method` (a VAL.*-specific emitter) — never a bare name with no leading
// dot (that's the CALL_MODULES/namespace world — 'parseInt', 'Array.isArray' —
// a different table, out of scope here). Diffing around EACH module's own
// init(ctx) call (not just top-level ones) correctly attributes modules pulled
// in transitively via MOD_DEPS, including circular pairs (string <-> number):
// see includeModule's own doc comment for why the diff window is safe there.
//
// This script is HOST-ONLY (plain Node, run manually) — never imported by
// src/*.js or module/*.js, so it is never part of the self-compiled kernel
// surface. The generated file it writes IS part of that surface (imported by
// src/autoload.js as plain static data — same shape as the hand-written table
// it replaces), so the kernel pays zero runtime cost for any of this: no
// module-execution, no ctx dependency, nothing to go stale across a warm
// kernel instance's `_clear()`-then-recompile reuse.
//
// Regenerate after adding/removing/renaming a `.method` / `.kind:method`
// registration in any module/*.js file. test/self-compile-includes.js's
// "derived prop-modules table is fresh" case re-runs this derivation live
// (host-side only) and fails loudly, naming this command, if the checked-in
// file has drifted.
//
// Run: node scripts/gen-prop-modules.mjs
import { writeFileSync } from 'node:fs'
import { ctx } from '../src/ctx.js'
import { beginSession } from '../src/session.js'
import { includeModule } from '../src/autoload.js'
import * as mods from '../module/index.js'
import { emitter, emit, emitVoid, emitBlockBody, emitBoolStr, emitIndex, buildArrayWithSpreads, emitIdentitySafe } from '../src/compile/emit.js'
import { GLOBALS } from '../src/prepare/index.js'

// Property-dispatch key shapes only (leading dot): `.method` or `.kind:method`.
// Every VAL.* kind (src/reps.js) is lowercase, so a lowercase+digits prefix
// before the colon is exhaustive; anything `.`-prefixed that doesn't match is
// reported, not silently dropped, so a new key shape gets noticed here.
const KEY_RE = /^\.(?:([a-z0-9]+):)?([A-Za-z_$][\w$]*)$/

// Known `.`-prefixed keys that are NOT property-spelling dispatch (so must not
// enter the derived table, confirmed against their registration/call sites):
//   '.'                — module/core.js's generic dyn-prop-read dispatcher
//                        (the fallback machinery itself, not a method name).
//   '.typed:[]' / '=' — the INDEX operator (`arr[i]` / `arr[i]=v`), a
//                        different dispatch class (OP_MODULES's `'['`), not a
//                        `.prop`/method call — test/array-methods.js's own
//                        comment: "(index ops, not method calls) stay out of
//                        scope".
//   '.string:slice#view' — an internal helper variant src/compile/emit.js
//                        calls directly by literal key (line ~2055); no
//                        source property is ever spelled `slice#view`, so
//                        includeForProperty/tryStaticDispatch never construct
//                        this key from a real `.prop` access.
const NON_METHOD_KEYS = new Set(['.', '.typed:[]', '.typed:[]=', '.string:slice#view'])

export function deriveMethodModules() {
  beginSession({
    emitter, globals: GLOBALS,
    hooks: { emit, flat: emitVoid, body: emitBlockBody, bool: emitBoolStr, idx: emitIndex, spread: buildArrayWithSpreads, emitIdentitySafe },
  })
  const table = new Map() // method name -> Set<module name>
  const unmatched = []
  for (const name of Object.keys(mods)) {
    includeModule(name, (modName, newKeys) => {
      for (const key of newKeys) {
        if (NON_METHOD_KEYS.has(key)) continue
        const m = KEY_RE.exec(key)
        if (!m) { if (key.startsWith('.')) unmatched.push(key); continue }
        const method = m[2]
        let set = table.get(method)
        if (!set) table.set(method, set = new Set())
        set.add(modName)
      }
    })
  }
  if (unmatched.length) throw new Error(`gen-prop-modules: unrecognized '.'-prefixed emit key shape(s), update KEY_RE: ${unmatched.join(', ')}`)
  return table
}

function render(table) {
  const names = [...table.keys()].sort()
  const lines = names.map(name => {
    const modules = [...table.get(name)].sort()
    return `  ${JSON.stringify(name)}: [${modules.map(m => JSON.stringify(m)).join(', ')}],`
  })
  return `// AUTO-GENERATED by scripts/gen-prop-modules.mjs — DO NOT EDIT BY HAND.
// Regenerate: node scripts/gen-prop-modules.mjs
// See that script's header for what this table is and how it's derived.
//
// method/property name -> stdlib module names that register a '.name' or
// '.kind:name' ctx.core.emit dispatch key for it. src/autoload.js unions this
// with its hand-audited PROP_MODULES (RESOLVED_PROP_MODULES) rather than
// consulting it alone — see that union's own comment for why (a dispatch-key
// registration isn't always the whole story: some emitters call another
// module's stdlib helper directly, an edge this table can't see).
export const DERIVED_PROP_MODULES = Object.assign(Object.create(null), {
${lines.join('\n')}
})
`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const table = deriveMethodModules()
  const out = render(table)
  const dest = new URL('../src/prop-modules.generated.js', import.meta.url)
  writeFileSync(dest, out)
  console.log(`wrote src/prop-modules.generated.js (${table.size} method names)`)
}
