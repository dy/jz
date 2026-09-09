#!/usr/bin/env node
/** Build and validate the jz compiler. Optional first argument: output path. */
import { writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { compile } from '../index.js'
import { resolveSelfCompileBuild } from './build-profile.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(process.argv[2] || resolve(ROOT, 'dist/jz.wasm'))
const OUT_DIR = dirname(OUT)

// Build from scripts/self.js: its default export is `compileSelf`, the whole jz
// pipeline (parse → jzify → prepare → compile → watr-encode) as one source→bytes
// function. The resulting wasm's `default(source)` is jz, compiled by jz — no host
// help needed (the wasm parses and encodes too).
//
// Graph resolution, build-time specialization, and compact compiler-runtime
// collection layout are shared with build-dist.mjs via resolveSelfCompileBuild.
// Both builders consume the identical profile.
const t0 = Date.now()
// The compiler artifact defaults to level 1. Higher tiers spend gigabytes
// optimizing compiler-only SIMD and peephole candidates before encoding; level
// 1 keeps the essential cleanup while the hosted compiler still applies each
// user program's requested optimization profile. Override for diagnosis.
const SELF_OPT = process.env.JZ_SELF_COMPILE_OPT ?? '1'
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
// Snapshot initialization once at build time. The final artifact reuses the
// probe's encoded function bodies and bakes its heap/globals into declarations;
// instantiation needs no table-building work. Snapshotting remains enabled.
// JZ_SELF_COMPILE_SNAPSHOT=0 is available for diagnostic A/B use.
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
  host: 'js', // The compiler artifact's host is independent of the test matrix.
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
