#!/usr/bin/env node
/**
 * Build the portable standalone artifacts under dist/ (gitignored; produced on
 * demand and for publish):
 *
 *   dist/jz.js   — minified single-file ESM bundle of the JS compiler (index.js
 *                  + its src/ graph + the subscript parser + watr backend). Drop
 *                  it anywhere with a JS runtime: `import jz from './jz.js'`.
 *   dist/interop.js — minified jz/interop bridge (host runtime: instantiate +
 *                  value marshalling, no compiler). ~15 kB / ~6 kB gzipped.
 *   assets/sprae.js — minified bundle of sprae (a WEB asset, not compiler dist):
 *                  the landing binds its live bench figures with sprae `:text`
 *                  directives. Resolved from the npm package or a sibling dy/sprae.
 *   dist/jz.wasm — the jz compiler compiled to wasm by jz (full self-host). Its
 *                  default export is `compileSelf(source) → wasm bytes`: the whole
 *                  pipeline (parse → jzify → prepare → compile → watr-encode) runs
 *                  in wasm, no host help. Built from scripts/self.js — same artifact
 *                  the selfhost gate builds (scripts/selfhost-build.mjs).
 *
 * Run: npm run build
 */
import { build } from 'esbuild'
import { writeFileSync, mkdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { stripWatTemplates } from './wat-strip.mjs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '../index.js'
import { resolveModuleGraph } from '../src/resolve.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(ROOT, 'dist')
const ASSETS = resolve(ROOT, 'assets')   // web-only assets (site.css, fonts, the sprae bundle) — NOT compiler dist
mkdirSync(OUT, { recursive: true })
mkdirSync(ASSETS, { recursive: true })
const kb = (p) => (statSync(p).size / 1024).toFixed(1) + ' kB'

// ── dist/jz.js — minified ESM bundle of the JS compiler ──────────────────────
const jsOut = resolve(OUT, 'jz.js')
// WAT templates in module/*.js ship their comments + indentation through the
// minifier (string content is verbatim) — strip them at bundle time only; the
// sources stay documented. Whitespace-only for the WAT parser: outputs are
// byte-identical (gated by the corpus compare in scripts/wat-strip.mjs's
// header + the examples smoke below).
const watStrip = {
  name: 'wat-strip',
  setup(b) {
    b.onLoad({ filter: /\/module\/[^/]+\.js$/ }, (args) => ({
      contents: stripWatTemplates(readFileSync(args.path, 'utf8')), loader: 'js',
    }))
  },
}
await build({
  entryPoints: [resolve(ROOT, 'index.js')],
  bundle: true,
  minify: true,
  format: 'esm',
  plugins: [watStrip],
  // neutral, not node: the primary consumers are browser <script type=module> tags
  // (landing/REPL). A node-platform bundle let an unguarded `process.env` debug line
  // ship and break every loop compile in every browser (test/web-smoke.js pins this).
  platform: 'neutral',
  mainFields: ['module', 'main'],
  target: 'es2022',
  legalComments: 'none',
  outfile: jsOut,
})
console.log('wrote dist/jz.js  ', kb(jsOut))

// wat-strip parity spot-gate: the stripped bundle must emit byte-identical
// wasm (whitespace-only transform). Three shape-diverse probes per build;
// the full corpus gate is scripts/wat-strip-gate — run it on any stripper change.
{
  const distCompile = (await import(jsOut)).compile
  for (const [name, src] of [
    ['typed', 'export let f = (n) => { const a = new Float64Array(64); let s = 0; for (let i = 0; i < n; i++) { a[i & 63] = i * 0.5; s += a[i & 63] } return s }'],
    ['dict', 'export let f = (n) => { const c = {}; const ks = ["a","b","c"]; for (let i = 0; i < n; i++) { const k = ks[i % 3]; c[k] = (c[k] | 0) + 1 } return (c.a | 0) + (c.b | 0) * 2 }'],
    ['string', 'export let f = (n) => { let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(97 + (i % 26)); return s.length }'],
  ]) {
    const a = compile(src, { optimize: 'speed' }), b = distCompile(src, { optimize: 'speed' })
    if (a.length !== b.length || Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0)
      throw new Error(`wat-strip parity DIFF on ${name} probe: source ${a.length} B vs dist ${b.length} B — dist/jz.js diverged from index.js`)
  }
  console.log('  wat-strip parity: 3 probes byte-identical')
}

// --js-only: just the browser-facing bundles (used by test/web-smoke.js — the wasm
// kernel below costs ~20s and has its own gates).
if (process.argv.includes('--js-only')) process.exit(0)

// ── dist/interop.js — minified jz/interop bridge (host runtime, no compiler) ──
const interopOut = resolve(OUT, 'interop.js')
await build({
  entryPoints: [resolve(ROOT, 'interop.js')],
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  legalComments: 'none',
  outfile: interopOut,
})
console.log('wrote dist/interop.js', kb(interopOut))

// ── assets/sprae.js — a WEB asset, not compiler dist: the landing binds its live bench figures with
// sprae (`:text` over bench/results.json) and statically imports ./assets/sprae.js, so the build must
// emit it. Resolve from the npm package if installed, else a sibling `dy/sprae` checkout. ───────────
let spraeEntry = null
try { spraeEntry = fileURLToPath(import.meta.resolve('sprae')) } catch {}
if (!spraeEntry) { const sib = resolve(ROOT, '../sprae/sprae.js'); if (existsSync(sib)) spraeEntry = sib }
if (spraeEntry) {
  const spraeOut = resolve(ASSETS, 'sprae.js')
  await build({ entryPoints: [spraeEntry], bundle: true, minify: true, format: 'esm', platform: 'neutral', target: 'es2022', legalComments: 'none', outfile: spraeOut })
  console.log('wrote assets/sprae.js', kb(spraeOut))
} else {
  console.warn('⚠ sprae not found — `npm i sprae` or clone dy/sprae as a sibling; assets/sprae.js NOT built (landing metric bindings will fail)')
}

// ── dist/jz.wasm — the jz compiler, compiled to wasm by jz (full self-host) ───
const wasmOut = resolve(OUT, 'jz.wasm')
const g = resolveModuleGraph(resolve(ROOT, 'scripts/self.js'), { resolveNode: true })
// CARRIER_BOX self-host build-time injection (.work/carrier-representation-
// design.md §32 — the item-8/rawField() root cause; §34 flipped the default
// ON). src/ctx.js declares `CARRIER_BOX = typeof process === 'undefined' ||
// process.env?.JZ_CARRIER_BOX !== '0'` — a native-process host-capability
// probe, correct when ctx.js runs NATIVELY (this very build process). But
// when ctx.js's OWN SOURCE is what's being self-hosted (compiled BY jz,
// below), jz's compiler — CORRECTLY, per spec §13.5.3 (prepare/index.js
// staticTypeofString/isUnresolvableBareIdent) — folds `typeof process` to
// the literal 'undefined' for ANY compile, because `process` is never
// declared anywhere in jz's own source or its GLOBALS table. That
// permanently folds CARRIER_BOX to `true` inside ANY self-hosted kernel
// regardless of the flag THIS build runs under (the OR's left arm always
// wins once `typeof process` is a literal 'undefined'): the running
// kernel's own compiled decisions (module/schema.js slotBigintBoxedBySid,
// src/ir.js isSchemaSlotBigintPossible, etc.) can never observe a live env
// var — wasm has no `process`. Pre-flip (§32) this same mechanism froze the
// flag OFF inside every kernel; post-flip it would freeze it ON, silently
// ignoring `JZ_CARRIER_BOX=0`'s opt-out for any self-hosted build — the
// escape hatch must actually escape. Bake THIS BUILD's actual flag value in
// as a source-text literal before compiling, the standard technique for a
// build-time constant that must survive into a self-hosted artifact
// (webpack DefinePlugin / rustc cfg! precedent) — scoped to this one
// self-hosting compile only; native runs (`node index.js`, every test/
// *.js) read the real declaration, untouched.
{
  const CTX_PATH = Object.keys(g.modules).find(p => p.endsWith('/src/ctx.js'))
  if (!CTX_PATH) throw new Error('build-dist.mjs: src/ctx.js not found in self.js module graph — CARRIER_BOX injection site missing')
  const needle = "export const CARRIER_BOX = typeof process === 'undefined' || process.env?.JZ_CARRIER_BOX !== '0'"
  if (!g.modules[CTX_PATH].includes(needle))
    throw new Error('build-dist.mjs: CARRIER_BOX declaration shape changed in src/ctx.js — update this self-host injection to match')
  g.modules[CTX_PATH] = g.modules[CTX_PATH].replace(needle, `export const CARRIER_BOX = ${process.env.JZ_CARRIER_BOX !== '0'}`)
}
// Match selfhost-build.mjs's measured release profile: this artifact is a
// compiler executable, not a size-distributed web asset. O3 keeps its warm
// compile geomean decisively below the same pipeline on V8.
// REGION-ARENA × inlinePtrOffsetFast (.work/research.md §Region arena,
// ROOT-CAUSE ATTEMPT 2026-08-11 — confirmed by ablation, 7/7 banked fuzz
// findings + both minimal repros clean ×3 reps with this flag off, kernel-
// oracle 13/13×3, kernel-parity 33/33×3, dead on the full 200-seed sweep×3):
// inlinePtrOffsetFast (src/passes.js:48) expands `(call $__ptr_offset X)`
// into a loop-free, CSE-eligible i32.and/i64.shr_u/load expression AT EVERY
// CALL SITE, precisely so watr's own optimizer can fold/hoist it like any
// other pure op. That is exactly the hazard when regionHooks are wired
// (scripts/self.js below): a region_exit call relocates live heap objects
// and re-derives their offsets through the SAME forwarding chase this
// inlined form reproduces — but once inlined, the expansion LOOKS pure to
// every downstream CSE (watr's own, jz's hoistPtrType/hoistInvariantPtrOffset
// regionTrackCSE family), which has zero notion that a `$__region_exit`
// call anywhere in between invalidates a previously-decoded offset. The
// out-of-line `call $__ptr_offset` form is naturally conservative (a call is
// a CSE barrier); the inlined form is not, and watr's OWN cross-function
// inlining runs AFTER jz's per-function optimizeFunc pass (see this file's
// pass-order note above optimizeFunc), so a precise per-function dominator/
// interval exclusion inside inlinePtrOffsetFastPass itself cannot see the
// hazard — the CSE opportunity only exists post-fusion. The sound,
// compile-time gate is therefore here, at the one call site that ever wires
// regionHooks live: detect the ACTIVE (uncommented) `regionHooks:` line in
// scripts/self.js's own source and force inlinePtrOffsetFast off for
// EXACTLY that build. Every other compile — native, the test suite, jzify,
// any user program, even a DORMANT self-host build — is untouched: this is
// a narrow exclusion at the one build where the hazard's precondition
// holds, not a global pass disable (which would give up the pass's real
// speed-tier win for ordinary programs). Verified a true no-op on the
// dormant path: byte-identical dist/jz.wasm with and without this block
// while scripts/self.js's regionHooks line stays commented.
const REGION_HOOKS_LIVE = /^\s*regionHooks:\s*\{/m.test(g.code)
const wasm = compile(g.code, {
  modules: g.modules,
  memory: 8192,
  optimize: {
    level: 3, watrGuard: false, snapshotInit: true,
    ...(REGION_HOOKS_LIVE ? { inlinePtrOffsetFast: false } : null),
  },
})
new WebAssembly.Module(wasm)  // validate before writing
writeFileSync(wasmOut, wasm)
console.log('wrote dist/jz.wasm', kb(wasmOut))
