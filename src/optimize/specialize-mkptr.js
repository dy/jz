/**
 * Call-site specialization by literal-argument signature — whole-module pass,
 * invoked from src/wat/assemble.js alongside treeshake/hoistConstantPool.
 *
 * @module optimize/specialize-mkptr
 */
import { walkAst } from '../ast.js'
import { ptrBits, i64Hex, PTR } from '../../layout.js'

/**
 * Specialize `(call $F arg1 arg2 …)` call sites by literal-arg signature.
 *
 * For each call target with a stable (param-types, result-type) signature,
 * scan all call sites and group by "literal-arg signature" (which args are
 * `i32.const N` literals vs runtime-dynamic). For groups with ≥ MIN_USES, emit
 * a specialized trampoline `$F_L1_L2_…` that bakes literals into the call:
 *
 *   (func $F_L1_L2 (param $a2 T2) (result R)
 *     (call $F (i32.const L1) (local.get $a2)))
 *
 * Call sites are rewritten `(call $F (i32.const L1) a2)` → `(call $F_L1_L2 a2)`.
 * Savings per site: ~2 B per dropped literal arg.
 *
 * For `$__mkptr`, every combo has type+aux literal so we special-case the body:
 * fold the prefix into `(i64.const TEMPLATE)` instead of a trampoline call —
 * avoids a runtime indirection for the hottest path.
 *
 * @param funcs    — flat list of func IR nodes (sec.funcs + sec.stdlib + sec.start)
 * @param addFunc  — callback `(watString) => void` to register new helpers
 */
export function specializeMkptr(funcs, addFunc) {
  // Per-target specification: param-types, result-type. Threshold tuned so helper cost amortizes.
  // Any target not listed here is left untouched. Order matters only for readability.
  const SPECS = {
    '$__mkptr':     { params: ['i32', 'i32', 'i32'], result: 'f64', inline: true },
    '$__alloc_hdr':   { params: ['i32', 'i32'],        result: 'i32' },
    '$__alloc_hdr_n': { params: ['i32', 'i32', 'i32'], result: 'i32' },
    '$__typed_idx': { params: ['i64', 'i32'],        result: 'f64' },
    '$__str_idx':   { params: ['i64', 'i32'],        result: 'f64' },
  }
  // 4 is the measured break-even: a specialized helper (trampoline / inline i64.const
  // template) costs ~12 B to define and saves ~2–4 B per site, so 4 sites amortize it.
  // Lower (3) net-inflates the watr self-compile; 5 leaves 4-use combos on the table. The
  // threshold (20) is already optimal — its combos cluster far
  // above 20 (the ~2 k-site $__strBase relativization) with nothing in the 5–19 band.
  const MIN_USES = 4

  // Dynamic arguments share one interned trie key; literal arguments use their
  // number directly. Counting through this trie allocates only for a NEW
  // signature, not once per call site (the self-host has millions of sites and
  // no tracing GC between region exits).
  const DYNAMIC_SIG = 'D'
  const sigPart = a => Array.isArray(a) && a[0] === 'i32.const' && typeof a[1] === 'number'
    ? a[1] : DYNAMIC_SIG
  const sigKey = (call, nParams) => {
    let key = '', anyLit = false
    for (let i = 0; i < nParams; i++) {
      const part = sigPart(call[2 + i])
      if (i) key += '|'
      if (part === DYNAMIC_SIG) key += 'D'
      else { key += 'L:' + part; anyLit = true }
    }
    return anyLit ? key : null
  }

  // Pass 1 counts signatures only. The former implementation retained one
  // `{parent, idx, fullKey, parts}` record per candidate until the module-wide
  // count settled; on compiler-sized modules that site ledger alone consumed
  // the remaining wasm32 heap. Pass 3 now performs a second, post-order walk:
  // linear time, bounded solver state, and the same leaf-first rewrite order.
  let counts = new Map()  // target → nested arg-part Maps → compact leaf tuple
  let countEntries = []   // first-seen full-signature order (output-order authority)
  const collectCall = (node, parent) => {
    if (!parent || !Array.isArray(node) || node[0] !== 'call' || typeof node[1] !== 'string' || !SPECS[node[1]]) return
    const spec = SPECS[node[1]]
    if (node.length !== 2 + spec.params.length) return
    let row = counts.get(node[1])
    if (!row) { row = new Map(); counts.set(node[1], row) }
    let anyLit = false
    for (let i = 0; i < spec.params.length; i++) {
      const part = sigPart(node[2 + i])
      if (part !== DYNAMIC_SIG) anyLit = true
      if (i === spec.params.length - 1) {
        if (anyLit) {
          let leaf = row.get(part)
          if (!leaf) {
            leaf = [node[1] + '##' + sigKey(node, spec.params.length), 1]
            row.set(part, leaf)
            countEntries.push(leaf)
          } else leaf[1]++
        }
      } else {
        let next = row.get(part)
        if (!next) { next = new Map(); row.set(part, next) }
        row = next
      }
    }
  }
  const collectOptions = { enter: collectCall }
  for (const func of funcs) walkAst(func, collectOptions)

  // Pass 2: for each eligible (target, sig), emit helper.
  const specialized = new Set()
  for (const [k, n] of countEntries) if (n >= MIN_USES) specialized.add(k)
  if (!specialized.size) return

  const variantName = (target, sigParts) => target.slice(1) + '_' + sigParts
    .map(p => p === 'D' ? 'd' : p.slice(2)).join('_')

  for (const fullKey of specialized) {
    const [target, sig] = fullKey.split('##')
    const parts = sig.split('|')
    const spec = SPECS[target]
    const name = variantName(target, parts)

    // $__mkptr inline fast path: bake (type, aux) literals into i64.const template.
    if (target === '$__mkptr' && spec.inline && parts[0].startsWith('L:') && parts[1].startsWith('L:')) {
      const type = +parts[0].slice(2), aux = +parts[1].slice(2)
      const tmpl = ptrBits(type, aux)  // box prefix (offset OR'd in at runtime below)
      // Third arg (offset) may also be literal — emit (f64.const nan:…) then.
      if (parts[2].startsWith('L:')) {
        // Fully literal: all sites can be f64.const — no helper needed, handled in rewrite below.
        continue
      }
      // i64Hex, not tmpl.toString(16) — the identical self-compile hazard
      // i64Hex's own doc documents (layout.js): under self-host, a BigInt
      // whose bits carry a PTR-tag-shaped pattern (any real box prefix,
      // this one included — type=BIGINT's own tag nibble at bit 47 makes
      // 0x7FFA… exactly such a pattern) routes `.toString(radix)` through
      // readI64/isPlanTaggedBigint, which the kernel's own fixpoint proves
      // (wrongly, ordering-sensitively) boxed — so the runtime tag-check
      // "sees" a valid tag and unboxes a raw literal as if it were a
      // pointer, reading unrelated heap bytes (confirmed live: watr's
      // NaN-boxed i64.parse constant corrupted into string-pool "NaN"/
      // "Infinity" fragments — kind/isBigInt's O2-only typeof regression,
      // fix/shape8-member-callee). i64Hex computes the hex digits via
      // BigInt shift/and/Number — never a `.toString()` call — so it never
      // reaches that dispatch at all, native or self-hosted.
      addFunc(`(func $${name} (param $o i32) (result f64)
        (f64.reinterpret_i64 (i64.or (i64.const ${i64Hex(tmpl)}) (i64.extend_i32_u (local.get $o)))))`)
      continue
    }

    // Generic trampoline: (func $F_LITS (param …dyn) (result R) (call $F lits+dyn))
    const dynArgs = []
    const callArgs = []
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith('L:')) {
        callArgs.push(`(i32.const ${parts[i].slice(2)})`)
      } else {
        dynArgs.push(`(param $a${i} ${spec.params[i]})`)
        callArgs.push(`(local.get $a${i})`)
      }
    }
    addFunc(`(func $${name} ${dynArgs.join(' ')} (result ${spec.result}) (call ${target} ${callArgs.join(' ')}))`)
  }

  // Pass 3: second post-order walk, preserving the old reverse-preorder
  // leaf-first behavior without retaining a module-sized site ledger.
  const rewrite = (c, parent, idx) => {
    if (!parent || c[0] !== 'call' || typeof c[1] !== 'string') return
    const target = c[1]
    const spec = SPECS[target]
    if (!spec || c.length !== 2 + spec.params.length) return
    const key = sigKey(c, spec.params.length)
    if (!key) return
    const fullKey = target + '##' + key
    if (!specialized.has(fullKey)) return
    const parts = key.split('|')

    // $__mkptr fully literal (rare — mkPtrIR usually folds these ahead of us, but defensive):
    if (target === '$__mkptr' && parts[0].startsWith('L:') && parts[1].startsWith('L:') && parts[2].startsWith('L:')) {
      const type = +parts[0].slice(2), aux = +parts[1].slice(2), off = +parts[2].slice(2)
      const n = ['f64.const', 'nan:' + i64Hex(ptrBits(type, aux, off))]
      n.type = 'f64'
      // This node REPLACES c (the original call), which mkPtrIR's own fold
      // would already have tagged `.schemaSid` on had it reached the fold
      // check first — carry that fact forward onto the replacement (src/
      // compile/index.js's post-treeshake collector walks THIS node, never
      // sees `c` again after this assignment).
      if (type === PTR.OBJECT) n.schemaSid = aux
      parent[idx] = n
      return
    }

    const name = variantName(target, parts)
    const dynArgs = []
    for (let j = 0; j < parts.length; j++) if (parts[j] === 'D') dynArgs.push(c[2 + j])
    const newCall = ['call', '$' + name, ...dynArgs]
    newCall.type = spec.result
    // Same carry-forward as the fully-literal fold above, for the
    // $__mkptr_T_A_d named-variant case (type+aux literal, offset dynamic —
    // narrow.js's devirt re-box of a recursive OBJECT param takes exactly
    // this path): `c` (the original `call $__mkptr`) is about to become
    // unreachable from the tree; nothing else will ever tag `newCall`.
    if (target === '$__mkptr' && parts[0].startsWith('L:') && +parts[0].slice(2) === PTR.OBJECT && parts[1].startsWith('L:'))
      newCall.schemaSid = +parts[1].slice(2)
    parent[idx] = newCall
  }
  for (const func of funcs) walkAst(func, { exit: rewrite })
}
