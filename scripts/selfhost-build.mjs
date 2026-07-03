#!/usr/bin/env node
/** Build and validate the jz self-host compiler (dist/jz.wasm). */
import { writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { compile } from '../index.js'
import { resolveModuleGraph } from '../src/resolve.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = resolve(ROOT, 'dist')
const OUT = resolve(OUT_DIR, 'jz.wasm')

// Build from scripts/self.js: its default export is `compileSelf`, the whole jz
// pipeline (parse → jzify → prepare → compile → watr-encode) as one source→bytes
// function. The resulting wasm's `default(source)` is jz, compiled by jz — no host
// help needed (the wasm parses and encodes too).
const g = resolveModuleGraph(resolve(ROOT, 'scripts/self.js'), { resolveNode: true })
console.log('resolving self-host graph…', Object.keys(g.modules).length, 'modules')
const t0 = Date.now()
// optimize:2 — full standard optimization. (Earlier this MISCOMPILED the compiler into
// an infinite loop on its own code; root cause was `sourceInline` dropping a statement-
// position callee's side-effecting return expression — the parser's `seek = n => idx = n`
// stopped advancing `idx`, looping comment-skip forever. Fixed in src/compile/plan/inline.js.)
// -O2, not -O3: the compiler is integer/string/pointer work with no float/SIMD compute, so
// O3's extras (relaxedSimd, aggressive size-for-speed inline, reduceUnroll) don't help it —
// the corpus-compile ratio is identical at O1/O2/O3 (the cost is the kernel NaN-box/string/
// map tax, not the compiler's own code). Override with JZ_SELFHOST_OPT (e.g. =3, =false).
const SELF_OPT = process.env.JZ_SELFHOST_OPT ?? '2'
const HELPER_COUNTERS = /^(1|true|yes)$/i.test(process.env.JZ_HELPER_COUNTERS || '')
const HELPER_SITES = process.env.JZ_HELPER_SITES || ''
const HELPER_SITES_ON = !!HELPER_SITES && !/^(0|false|no)$/i.test(HELPER_SITES)
const HELPER_SITE_FILTER = /^(1|true|yes)$/i.test(HELPER_SITES) ? 'ptr_offset' : HELPER_SITES
const selfOptLevel = SELF_OPT === 'false' ? false : (isNaN(+SELF_OPT) ? SELF_OPT : +SELF_OPT)
// watr's packData (data-segment zero-run trim/merge/split, src/optimize.js) miscompiles
// the kernel's OWN interned static-string data (internStrings pass, src/compile/index.js
// buildInternTable: [hash u32][len u32][bytes] statics + a sparse open-addressing intern
// probe table — both zero-run-dense) at self-host scale. Surfaces as the kernel's embedded
// watr throwing "Unknown instruction f64.nearest" (OPCODE dyn-prop lookup miss) when the
// running kernel compiles a program whose Math.exp/sin/cos/tan/pow/expm1 lowering pulls in
// a WAT-text stdlib template (module/math.js) containing that opcode name — the template
// text is tokenized by watr's OWN parser at KERNEL RUNTIME, unlike Math.round's f64.nearest
// (a plain JS array-literal AST node, never miscompiled). Isolated by bisecting the OPTIMIZE
// pass config against the exact self.js module graph (native jz compiling self.js AS THE
// LITERAL ENTRY — wrapping it in another module changes reachability/dedup enough to hide
// the bug): {level:1, watr:true} and {level:2, watr:false} both compile the kernel correctly;
// watr + internStrings TOGETHER are required, and disabling packData alone (watr's other
// ~20 passes + internStrings stay on) fixes it at both the minimal and the real level-2
// config. Root cause lives in watr/optimize.js's packData; jz doesn't fork watr anymore
// (de-forked), so this is jz's own build orchestration choosing a safe watr config for its
// self-compile, not a source workaround. See .work/selfhost-perf-groundtruth.md.
const wasm = compile(g.code, {
  modules: g.modules,
  memory: 8192,
  optimize: selfOptLevel === false ? false : { level: selfOptLevel, watr: { packData: false } },
  helperCounters: HELPER_COUNTERS || HELPER_SITES_ON,
  helperCallsites: HELPER_SITES_ON ? HELPER_SITE_FILTER : false,
})
console.log('compiled', wasm.byteLength, 'bytes in', Date.now() - t0, 'ms')
new WebAssembly.Module(wasm)
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT, wasm)
console.log('wrote', OUT)
