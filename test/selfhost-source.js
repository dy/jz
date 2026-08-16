// Self-host source guard — keep scripts/self.js's whole module graph inside the
// jz-compilable subset, checked in the FAST suite (`npm test`).
//
// dist/jz.wasm is jz compiling its OWN source, so every file the self-host entry
// pulls in must parse under jz's jessie parser, not just under Node. The trap that
// motivated this guard: a `return f(x)` (or any call-expression statement) directly
// followed by a bare `{ block }` with no separating `;`. Node's ASI makes the block
// dead code after the return, so it runs fine and the curated suite stays green —
// but jessie has no ASI here and folds `f(x) ⏎ { … }` into `f: (x) => { … }`, a
// labeled statement that prepare rejects with "labeled statements not supported".
// That surfaces ONLY in the self-host build (`npm run build` / the selfhost CI job),
// which agents don't run in the inner loop — so a perf change can land it green.
// This test makes the same break show up in `npm test`.
//
// jzify lowers WELL-FORMED labeled loops (`outer: for … break outer`) before prepare,
// so they're gone after the lowering pass; only the un-lowerable misparses survive
// the scan. The file set is taken from resolveModuleGraph — exactly what the build
// compiles — so it can't drift out of sync with self.js's imports.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { join } from 'node:path'
import { parse } from '../src/parse.js'
import jzify from '../jzify/index.js'
import { resolveModuleGraph } from '../src/resolve.js'
import { resolveSelfhostBuild } from '../scripts/build-profile.mjs'

const ROOT = join(import.meta.dirname, '..')
const SELF = join(ROOT, 'scripts/self.js')

// A ':' node is an object-property `key: value` exactly when its nearest non-','
// ancestor is a '{}' object literal; every other ':' in the tree is a labeled
// statement (the thing prepare rejects).
const labeledStatements = (ast) => {
  const hits = []
  const walk = (n, chain) => {
    if (!Array.isArray(n)) return
    if (n[0] === ':') {
      let i = chain.length - 1
      while (i >= 0 && chain[i] === ',') i--
      if ((i < 0 ? null : chain[i]) !== '{}') hits.push(n)
    }
    for (let k = 1; k < n.length; k++) walk(n[k], [...chain, n[0]])
  }
  walk(ast, [])
  return hits
}

// Mirror the build's parse → jzify front end, then look for surviving labels. A
// parse failure isn't a labeled-statement bug (and is its own loud error), so skip it.
const survivingLabels = (src) => {
  let ast
  try { ast = parse(src) } catch { return [] }
  let lowered
  try { lowered = jzify(ast) } catch { lowered = ast }
  return labeledStatements(lowered)
}

test('selfhost-source: self-host kernel is free of labeled-statement misparses', () => {
  const g = resolveModuleGraph(SELF, { resolveNode: true })
  // g.code is the entry (scripts/self.js); g.modules is every resolved dependency.
  // Scan only jz-owned files — the subscript parser under node_modules is an external
  // dependency, already self-host-clean, and not the surface agents edit.
  const sources = { 'scripts/self.js': g.code }
  for (const [path, src] of Object.entries(g.modules))
    if (!path.includes('node_modules')) sources[path.replace(ROOT + '/', '')] = src

  const offenders = []
  for (const [path, src] of Object.entries(sources))
    for (const h of survivingLabels(src)) {
      const label = typeof h[1] === 'string' ? h[1] : JSON.stringify(h[1]).slice(0, 30)
      offenders.push(`${path}: \`${label}:\` — a statement isn't terminated before a '{ block }' ` +
        `(jessie folds 'expr ⏎ { … }' into a labeled arrow). Add a ';' after the statement, or drop the bare block.`)
    }

  ok(offenders.length === 0,
    offenders.length
      ? `self-host source would break the self-host build (dist/jz.wasm) — ${offenders.length} labeled-statement misparse(s):\n  ${offenders.join('\n  ')}`
      : `clean across ${Object.keys(sources).length} self-host kernel files`)
})

// A bare `globalThis` READ in compiler source compiles to an env.globalThis
// import in the self-host build — the module then fails to INSTANTIATE
// (LinkError) in import-free hosts, and the failure is silent in the fast
// suite (the bench self-host row just vanishes). Debug hooks must use the
// house pattern `typeof process !== 'undefined' && process.env.X` — prep
// folds the typeof dead, no import. (String/comment mentions are fine; this
// scans PARSED source for a `globalThis` member-access base.)
// REGION_HOOKS_ACTIVE is the build's single dormant/live authority. A squashed
// merge once restored one optimize-tail `regionHooks` object unconditionally
// while leaving this marker false; builds reported themselves dormant but ran
// moving-region exits anyway. Keep every boundary visibly gated by the same
// expression so marker state and actual wiring cannot diverge again.
test('selfhost-source: every region hook boundary is gated by REGION_HOOKS_ACTIVE', () => {
  const { code } = resolveModuleGraph(SELF, { resolveNode: true })
  const markerFalse = 'export const REGION_HOOKS_ACTIVE = false'
  const markerTrue = 'export const REGION_HOOKS_ACTIVE = true'
  const guarded = 'REGION_HOOKS_ACTIVE ? { mark: () => __region_mark(), exit: (mark, root) => __region_exit(mark, root) } : undefined'
  const sites = code.split(guarded).length - 1
  ok(code.includes(markerFalse) !== code.includes(markerTrue),
    'scripts/self.js must declare exactly one literal REGION_HOOKS_ACTIVE state')
  ok(sites === 3,
    `expected all 3 self-host region boundaries to use the marker gate; found ${sites} (an unconditional site makes a dormant build region-live)`)
})

test('selfhost-source: build profile bakes debug invariants to a literal in both modes', () => {
  const ctxSource = (profile) => profile.graph.modules[Object.keys(profile.graph.modules).find(p => p.endsWith('/src/ctx.js'))]
  const prod = resolveSelfhostBuild()
  const debug = resolveSelfhostBuild({ debugInvariants: true })
  const prodGraph = [prod.graph.code, ...Object.values(prod.graph.modules)].join('\n')
  const debugGraph = [debug.graph.code, ...Object.values(debug.graph.modules)].join('\n')
  ok(prod.defines.DBG_INVARIANTS === false && ctxSource(prod).includes('export const DBG_INVARIANTS = false'),
    'production self-host graph bakes false so debug-only branches can be stripped')
  ok((prodGraph.match(/\bDBG_INVARIANTS\b/g) || []).length === 1,
    'production graph specializes every use; only ctx.js\'s exported declaration remains')
  ok(debug.defines.DBG_INVARIANTS === true && ctxSource(debug).includes('export const DBG_INVARIANTS = true'),
    'debug self-host graph bakes true explicitly')
  ok((debugGraph.match(/\bDBG_INVARIANTS\b/g) || []).length > 20,
    'debug graph retains invariant call sites and helper bodies')
})

test('selfhost-source: no bare globalThis reads (env.globalThis import would break instantiation)', () => {
  const g = resolveModuleGraph(SELF, { resolveNode: true })
  const sources = { 'scripts/self.js': g.code }
  for (const [path, src] of Object.entries(g.modules))
    if (!path.includes('node_modules')) sources[path.replace(ROOT + '/', '')] = src

  const offenders = []
  const scan = (n, path) => {
    if (!Array.isArray(n)) return
    if ((n[0] === '.' || n[0] === '?.' || n[0] === '[]') && n[1] === 'globalThis')
      offenders.push(`${path}: globalThis.${typeof n[2] === 'string' ? n[2] : '…'}`)
    for (let i = 1; i < n.length; i++) scan(n[i], path)
  }
  for (const [path, src] of Object.entries(sources)) {
    let ast
    try { ast = parse(src) } catch { continue }
    scan(ast, path)
  }
  ok(offenders.length === 0,
    offenders.length
      ? `bare globalThis read(s) in self-host source — each becomes an env.globalThis import:\n  ${offenders.join('\n  ')}\n  use \`typeof process !== 'undefined' && process.env.X\` instead`
      : `clean across ${Object.keys(sources).length} self-host kernel files`)
})
