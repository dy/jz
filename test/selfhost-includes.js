// Self-host stdlib-inclusion invariant.
//
// resolveIncludes() (src/ctx.js) pulls a stdlib helper's transitively-needed helpers two ways:
//   1. explicit edges — a helper listed in another's manual `deps()` array, or a direct
//      `inc('__foo')` from an emitter (both plain, self-host-robust), and
//   2. an AUTO-dep scan that *realizes* each included template (calls its factory / reads its
//      string) and greps the body for `$__foo` references.
// (2) is only a host-side safety net: under self-host (jz.wasm) it DIVERGES — the realize/scan
// silently yields nothing for some templates — so a helper reachable ONLY through (2) is dropped
// from the kernel module. That is the `str.slice`/typed-`.fill` "Unknown func $__clamp_idx" bug:
// __clamp_idx was body-called by six range helpers yet had ZERO explicit edge, so it rode in on
// the auto-scan alone and vanished in the kernel.
//
// Invariant: every helper a stdlib template body calls must be reachable WITHOUT the auto-scan —
// i.e. it must appear in some `deps()` array or be directly `inc()`'d. A new helper that forgets
// its explicit edge fails here in-process, long before the kernel leg traps on the dangling call.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { readdirSync, readFileSync } from 'node:fs'
import { compile } from '../index.js'
import { ctx } from '../src/ctx.js'
import { onKernel } from './_matrix.js'

// Broad surface so most templates register (each compile resets ctx; accumulate across compiles).
const PROBES = [
  'export let a=(s)=>s.slice(1,3)+s.substring(0,2)+s.trim()+s.replace("a","b")+s.replaceAll("a","b")+s.split(",")[0]+s.padStart(5)+s.repeat(2)+s.toUpperCase()+s.at(0)',
  'export let b=(a)=>{a.fill(1,0,2);a.copyWithin(0,1,3);const v=a.subarray(1,2);return a.slice(0,1)[0]+v[0]}',
  'export let c=()=>{const a=new Int32Array(4);a.fill(7,1,3);a.copyWithin(0,2);return a.slice(1,3)[0]}',
  'export let d=()=>{const a=[1,2,3];a.fill(9,0,2);a.push(4);return a.slice(0,1).join(",")}',
  'export let e=(o)=>JSON.stringify(o)+JSON.parse("[1]")[0]',
  'export let f=(k)=>{const x=new Map();x.set(1,2);const s=new Set([1]);return x.get(k)+(s.has(1)?1:0)}',
  'export let g=(s)=>s.match(/a/)?1:0',
  'export let h=(n)=>new Date(n).getFullYear()+String(n)+(n).toString(16)+parseInt("7f",16)+parseFloat("1.5")',
]

// Helpers an emitter pulls in directly: every `inc('__foo', …)` literal across src/ + module/.
// (Dynamic names like `inc(`__regex_${id}`)` are generated roots — they carry a numeric suffix
// and are excluded below.) This is the second reliable inclusion channel besides deps().
function emitterIncluded() {
  const set = new Set()
  const scan = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${ent.name}`
      if (ent.isDirectory()) scan(p)
      else if (ent.name.endsWith('.js')) {
        const src = readFileSync(p, 'utf8')
        for (const m of src.matchAll(/\binc(?:Mods)?\(([^)]*)\)/g))
          for (const lit of m[1].matchAll(/['"`](__[A-Za-z0-9_]+)['"`]/g)) set.add(lit[1])
      }
    }
  }
  scan('src'); scan('module')
  return set
}

const realize = (v) => typeof v === 'string' ? v : typeof v === 'function' ? (() => { try { return v() } catch { return null } })() : null

test('self-host: no stdlib helper is reachable only via the (self-host-unreliable) auto-dep scan', () => {
  if (onKernel()) return  // inspects host-side ctx internals + scans source; the in-process leg owns it
  const incd = emitterIncluded()
  // PER-TEMPLATE edges, not a program-wide union: `__set_add`'s body called
  // $__durable_slot_log while only __map_set's deps row listed it — the union
  // check passed, and every `new Set(...)` failed to compile on the kernel leg
  // ("Unknown func $__durable_slot_log"). A body-called helper must be in the
  // TRANSITIVE closure of the CALLING template's own explicit deps (or inc'd
  // globally) — that is what actually keeps it alive when the auto-scan
  // silently yields nothing under self-host.
  const callerBodyRefs = new Map()  // template name → Set of helpers its body calls
  const edges = new Map()           // template name → its OWN explicit deps
  let depTargets = 0
  for (const src of PROBES) {
    try { compile(src, { optimize: 2 }) } catch { continue }
    const { stdlib, stdlibDeps: graph } = ctx.core
    for (const name of Object.keys(stdlib)) {
      const txt = realize(stdlib[name])
      if (typeof txt !== 'string') continue
      let refs = callerBodyRefs.get(name)
      if (!refs) callerBodyRefs.set(name, refs = new Set())
      for (const m of txt.matchAll(/\$(__[A-Za-z0-9_]+)/g)) if (m[1] !== name && stdlib[m[1]]) refs.add(m[1])
    }
    for (const k of Object.keys(graph)) {
      const e = graph[k]; const a = typeof e === 'function' ? (() => { try { return e() } catch { return [] } })() : e
      let es = edges.get(k)
      if (!es) edges.set(k, es = new Set())
      for (const d of (a || [])) { es.add(d); depTargets++ }
    }
  }
  const closureOf = (name) => {
    const out = new Set(), queue = [name]
    while (queue.length) {
      const n = queue.pop()
      for (const d of edges.get(n) || []) if (!out.has(d)) { out.add(d); queue.push(d) }
    }
    return out
  }
  const vulnerable = []
  for (const [name, refs] of callerBodyRefs) {
    if (!refs.size) continue
    const reach = closureOf(name)
    for (const h of refs)
      if (!reach.has(h) && !incd.has(h) && !/_\d+$/.test(h)) vulnerable.push(`${name}→${h}`)
  }
  ok(vulnerable.length === 0,
    `template body calls a helper its OWN explicit deps can't reach — add the deps() edge or inc(): ${[...new Set(vulnerable)].join(', ')} ` +
    `(these compile in-process but vanish from the self-host kernel, e.g. "Unknown func $__clamp_idx" / "$__durable_slot_log")`)
  ok(callerBodyRefs.size > 20 && depTargets > 20, `realized surface: ${callerBodyRefs.size} templates, ${depTargets} dep edges`)
})
