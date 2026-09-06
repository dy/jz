#!/usr/bin/env node
// Test-only kernel build with source overlays: `node test/_self-overlay-build.mjs
// <out.wasm> <overlays.json>`, where the JSON maps a module path suffix of the
// self graph (`scripts/self.js` for the entry, whose source is the graph's
// `code`) to `[[find, replace], …]` edits applied to that module's source
// before the compile (test/_self-overlay.js: one module per suffix, one
// occurrence per find, or the build fails). The profile is the fresh self
// build's (scripts/self-compile-build.mjs: optimize 1, snapshot on); nothing
// in the shipped scripts changes. test/self-checkpoint.js forces the kernel's
// internal checkpoint branch this way.
import { writeFileSync } from 'node:fs'
import { compile } from '../index.js'
import { resolveSelfCompileBuild, SELF_ENTRY } from '../scripts/build-profile.mjs'
import { applyOverlays } from './_self-overlay.js'

const [out, overlayJson] = process.argv.slice(2)
if (!out || !overlayJson) { console.error('usage: _self-overlay-build.mjs <out.wasm> <overlays.json>'); process.exit(2) }
const overlays = JSON.parse(overlayJson)
const profile = resolveSelfCompileBuild({ optimize: 1, snapshot: true, helperCounters: false, helperCallsites: false })
const graph = applyOverlays(profile.graph, overlays, SELF_ENTRY)
const wasm = compile(graph.code, {
  modules: graph.modules, memory: profile.memory, optimize: profile.optimize,
  _compactCollections: profile.compactCollections, helperCounters: profile.helperCounters, helperCallsites: profile.helperCallsites,
})
new WebAssembly.Module(wasm)
writeFileSync(out, wasm)
console.log('wrote', out, wasm.byteLength, 'bytes')
