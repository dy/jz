#!/usr/bin/env node
/** Build and validate the jz self-compile compiler (dist/jz.wasm). */
import { writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { compile } from '../index.js'
import { resolveSelfCompileBuild } from './build-profile.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = resolve(ROOT, 'dist')
const OUT = resolve(OUT_DIR, 'jz.wasm')

// Build from scripts/self.js: its default export is `compileSelf`, the whole jz
// pipeline (parse → jzify → prepare → compile → watr-encode) as one source→bytes
// function. The resulting wasm's `default(source)` is jz, compiled by jz — no host
// help needed (the wasm parses and encodes too).
//
// Graph resolution + CARRIER_BOX injection + region-arena gate + compact
// compiler-runtime collection layout: shared with build-dist.mjs via
// resolveSelfCompileBuild (architecture re-audit item 2,
// .work/todo.md) — this entry point used to do NEITHER (JZ_CARRIER_BOX=0 was
// silently a no-op here, and a region-live self.js built through this script
// would carry build-dist.mjs's inlinePtrOffsetFast hazard ungated). Both
// builders now consume the identical config resolver.
const t0 = Date.now()
// optimize:2 — full standard optimization. (Earlier this MISCOMPILED the compiler into
// an infinite loop on its own code; root cause was `sourceInline` dropping a statement-
// position callee's side-effecting return expression — the parser's `seek = n => idx = n`
// stopped advancing `idx`, looping comment-skip forever. Fixed in src/compile/plan/inline.js.)
// -O3 is now the measured self-compile profile: internal lifted helpers can dissolve
// through inlineOnce and speed-tier loop shaping keeps the warm compiler clear of
// V8 (0.952× vs O2's load-sensitive ~0.99–1.02× on the pinned corpus). Dist size
// is irrelevant for this unpublished compiler artifact. Override for diagnosis.
const SELF_OPT = process.env.JZ_SELF_COMPILE_OPT ?? '3'
const HELPER_COUNTERS = /^(1|true|yes)$/i.test(process.env.JZ_HELPER_COUNTERS || '')
const HELPER_SITES = process.env.JZ_HELPER_SITES || ''
const HELPER_SITES_ON = !!HELPER_SITES && !/^(0|false|no)$/i.test(HELPER_SITES)
const HELPER_SITE_FILTER = /^(1|true|yes)$/i.test(HELPER_SITES) ? 'ptr_offset' : HELPER_SITES
const selfOptLevel = SELF_OPT === 'false' ? false : (isNaN(+SELF_OPT) ? SELF_OPT : +SELF_OPT)
// packData corruption was root-caused watr-side (isDroppable ';'-comment guard,
// fixed in watr 5.1.1 with byte-image regression tests) — full default config again.
//
// Speed-tier presets carry watr profile:'speed' by default now (outline/tailmerge/
// rettail off — measured on the 22-case corpus: geomean 1.433→1.316, 22/22; +19%
// kernel bytes, irrelevant for the compiler artifact). No special config needed.
// Init snapshotting (pre-eval tier 3, src/snapshot.js): the kernel's module-init —
// watr's OPCODE/IMM tables, interned atoms, GLOBALS registry — runs once at BUILD
// time and ships as pure data; __start is deleted. JZ_SELF_COMPILE_SNAPSHOT=0 opts out.
// watrGuard:false — skip watr's size-revert guard (two full encodes of the
// 6.6MB kernel ≈ 12s of the build, measured by CPU profile: instrSize/
// localidx/codeItemSize self-time). The kernel is a controlled artifact
// whose size test/perf pins track; the guard's never-inflate policing is
// redundant here. No-op until watr >5.2.3 lands the option.
const profile = resolveSelfCompileBuild({
  optimize: selfOptLevel,
  snapshot: !/^(0|false|no)$/i.test(process.env.JZ_SELF_COMPILE_SNAPSHOT || '1'),
  helperCounters: HELPER_COUNTERS || HELPER_SITES_ON,
  helperCallsites: HELPER_SITES_ON ? HELPER_SITE_FILTER : false,
})
console.log('resolved self-compile graph…', Object.keys(profile.graph.modules).length, 'modules')
const wasm = compile(profile.graph.code, {
  modules: profile.graph.modules,
  memory: profile.memory,
  optimize: profile.optimize,
  _compactCollections: profile.compactCollections,
  helperCounters: profile.helperCounters,
  helperCallsites: profile.helperCallsites,
})
console.log('compiled', wasm.byteLength, 'bytes in', Date.now() - t0, 'ms')
new WebAssembly.Module(wasm)
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT, wasm)
console.log('wrote', OUT)
