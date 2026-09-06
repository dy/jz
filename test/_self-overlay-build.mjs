#!/usr/bin/env node
// Test-only kernel build with source overlays: `node test/_self-overlay-build.mjs
// <out.wasm> <overlays.json>`, where the JSON maps a module path suffix of the
// self graph (`scripts/self.js` for the entry, whose source is the graph's
// `code`) to `[[find, replace], …]` edits applied to that module's source
// before the compile. The profile is the fresh self build's
// (scripts/self-compile-build.mjs: optimize 1, snapshot on); nothing in the
// shipped scripts changes. A missing module or a find string absent from it
// fails the build. test/self-checkpoint.js forces the kernel's internal
// checkpoint branch this way.
import { writeFileSync } from 'node:fs'
import { compile } from '../index.js'
import { resolveSelfCompileBuild } from '../scripts/build-profile.mjs'

const [out, overlayJson] = process.argv.slice(2)
if (!out || !overlayJson) { console.error('usage: _self-overlay-build.mjs <out.wasm> <overlays.json>'); process.exit(2) }
const overlays = JSON.parse(overlayJson)
const profile = resolveSelfCompileBuild({ optimize: 1, snapshot: true, helperCounters: false, helperCallsites: false })
const apply = (suffix, src, edits) => {
  for (const [find, replace] of edits) {
    if (!src.includes(find)) throw new Error(`overlay: ${suffix} does not contain ${JSON.stringify(find)}`)
    src = src.replace(find, replace)
  }
  return src
}
for (const [suffix, edits] of Object.entries(overlays)) {
  if (suffix === 'scripts/self.js') { profile.graph.code = apply(suffix, profile.graph.code, edits); continue }
  const path = Object.keys(profile.graph.modules).find(p => p.endsWith(suffix))
  if (!path) throw new Error(`overlay: no module ends with ${suffix}`)
  profile.graph.modules[path] = apply(suffix, profile.graph.modules[path], edits)
}
const wasm = compile(profile.graph.code, {
  modules: profile.graph.modules, memory: profile.memory, optimize: profile.optimize,
  _compactCollections: profile.compactCollections, helperCounters: profile.helperCounters, helperCallsites: profile.helperCallsites,
})
new WebAssembly.Module(wasm)
writeFileSync(out, wasm)
console.log('wrote', out, wasm.byteLength, 'bytes')
