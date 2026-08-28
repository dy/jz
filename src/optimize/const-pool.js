/**
 * Whole-module f64 constant pooling — invoked from src/wat/assemble.js
 * alongside treeshake/specializeMkptr.
 *
 * @module optimize/const-pool
 */
import { walkAst } from '../ast.js'

/**
 * Hoist frequently-repeated f64 constants into mutable globals.
 * f64.const is 9 bytes; global.get with idx<128 is 2 bytes — saves 7 B per reuse.
 * Pool entries sorted by usage descending, so hottest get lowest indices (1-byte LEB128).
 * Break-even: N ≥ 2 uses (pool cost: 11 B global decl + 2N bytes vs 9N original).
 *
 * Mutates `funcs` in place; writes new global decls via `addGlobal(name, constLiteral)`.
 */
// `String(number)` keeps only ~9 significant digits in the self-compile kernel (jz's number
// formatter — see README "differences"). The old pool keyed constants by `n:${c[1]}` (a toString)
// and emitted them via that same string, so in the kernel a constant both LOST precision
// (0.041666666666666664 → 0x1.5555558325751p-5) and could MERGE with a distinct value sharing its
// 9-digit prefix. Key by the exact 64 bits instead (a Float64Array/Uint32Array union — the
// numHashLiteral pattern, which self-compiles; the sign bit distinguishes -0/+0 for free) and emit
// the original NUMBER, which `declGlobal` lowers to a binary `f64.const` (exact, no string).
const _FCB = new Float64Array(1), _FCBu = new Uint32Array(_FCB.buffer)
const f64BitsKey = (n) => { _FCB[0] = n; return `n:${_FCBu[0]}:${_FCBu[1]}` }

export function hoistConstantPool(funcs, addGlobal) {
  const MIN_USES = 2
  // Single walk: count occurrences AND record each f64.const site for direct rewrite.
  // Avoids a second full-AST traversal in the rewrite phase.
  const counts = new Map()
  // NOTE: not `valueOf` — a local named like an Object method self-compile-miscompiles (the
  // kernel's dynamic dispatch confuses it). key → exact original c[1] (number, or source string).
  const exactVal = new Map()
  const sites = []  // { parent, idx, key }
  const collectConst = (node, parent, idx) => {
    if (!parent || !Array.isArray(node) || node[0] !== 'f64.const' ||
        (typeof node[1] !== 'number' && typeof node[1] !== 'string')) return
    const k = typeof node[1] === 'number' ? f64BitsKey(node[1]) : `s:${node[1]}`
    counts.set(k, (counts.get(k) || 0) + 1)
    if (!exactVal.has(k)) exactVal.set(k, node[1])
    sites.push({ parent, idx, key: k })
  }
  for (let i = 0; i < funcs.length; i++) walkAst(funcs[i], { enter: collectConst })

  const hoist = new Map()
  const sorted = [...counts].filter(([, n]) => n >= MIN_USES).sort((a, b) => b[1] - a[1])
  let gId = 0
  for (const [k] of sorted) {
    const name = `__fc${gId++}`
    // The EXACT original c[1] (a number → binary f64.const; or a source hex/decimal string),
    // never the lossy k-derived toString.
    addGlobal(name, exactVal.get(k))
    hoist.set(k, name)
  }
  if (!hoist.size) return

  // Rewrite recorded sites directly. Idempotent: if parent[idx] is no longer the
  // f64.const we recorded (shared subtrees), skip.
  for (let i = 0; i < sites.length; i++) {
    const { parent, idx, key } = sites[i]
    const g = hoist.get(key)
    if (!g) continue
    const c = parent[idx]
    if (!Array.isArray(c) || c[0] !== 'f64.const') continue
    const gn = ['global.get', `$${g}`]
    // Carry `.schemaSid` (mkPtrIR/specializeMkptr's fold, src/ir.js's doc)
    // forward onto the replacement — this rewrite discards `c`, the only
    // place the tag lived; src/compile/index.js's post-treeshake collector
    // never sees the pre-hoist site again.
    if (c.schemaSid != null) gn.schemaSid = c.schemaSid
    parent[idx] = gn
  }
}
