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
