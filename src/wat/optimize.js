/**
 * WAT AST optimizer — size/runtime passes over watr's s-expression IR.
 *
 * jz owns its optimizer; watr is used *only* as the WAT→binary encoder.
 * Pairs with src/optimize/ (jz-IR-level) — folder context disambiguates.
 *
 * @module wat/optimize
 */

import compile from 'watr/compile'

// Fixpoint round caps — empirical convergence bounds, not correctness limits.
// Each pass only makes monotonic progress, so hitting a cap merely leaves a few
// residual simplifications for the next compile rather than producing wrong output.
const MAX_PROP_ROUNDS = 6     // forward-prop / set-get / tee fixpoint per scope
const MAX_INLINE_ROUNDS = 16  // single-caller inline-chain depth (deep generated stdlib)

// === WAT optimizer passes ===

// — AST helpers (formerly watr/util.js) — every node is an s-expression
// array `[head, ...args]`; non-arrays are immediates.
const clone = (node) => Array.isArray(node) ? node.map(clone) : node

/** Walk depth-first pre-order, read-only. fn(node, parent, idx). */
const walk = (node, fn, parent, idx) => {
  fn(node, parent, idx)
  if (Array.isArray(node)) for (let i = 0; i < node.length; i++) walk(node[i], fn, node, i)
}

/** Walk depth-first post-order. fn may return a replacement node or mutate in place. */
const walkPost = (node, fn, parent, idx) => {
  if (Array.isArray(node)) for (let i = 0; i < node.length; i++) walkPost(node[i], fn, node, i)
  const result = fn(node, parent, idx)
  if (result !== undefined && parent) parent[idx] = result
  return result !== undefined ? result : node
}

/** Result value type of an op from its name prefix (formerly watr/const.js).
 *  Comparisons/eqz on scalar int/float collapse to i32; else the name prefix. */
const resultType = (op) => {
  if (typeof op !== 'string') return null
  const dot = op.indexOf('.')
  if (dot < 0) return null
  const prefix = op.slice(0, dot)
  const scalar = prefix === 'i32' || prefix === 'i64' || prefix === 'f32' || prefix === 'f64'
  if (scalar && /^(eqz?|ne|[lg][te])(_[su])?$/.test(op.slice(dot + 1))) return 'i32'
  if (scalar || prefix === 'v128') return prefix
  if (op === 'memory.size' || op === 'memory.grow') return 'i32'
  return null
}

/**
 * Recursively count AST nodes — fast size heuristic without compiling.
 * @param {any} node
 * @returns {number}
 */
const count = (node) => {
  if (!Array.isArray(node)) return 1
  let n = 1
  for (let i = 0; i < node.length; i++) n += count(node[i])
  return n
}

/**
 * Compile AST and measure binary size in bytes.
 * @param {Array} ast
 * @returns {number}
 */
const binarySize = (ast) => {
  try { return compile(ast).length } catch { return Infinity }
}

/**
 * Fast structural equality of two AST nodes.
 * Stops at first difference. Handles BigInt without stringification.
 */
const equal = (a, b) => {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (typeof a === 'bigint') return a === b
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false
  return true
}

/**
 * Locate the parts of an `(if ...)` node:
 *   condIdx → index of the condition expression
 *   cond    → the condition expression itself
 *   thenBranch / elseBranch → the (then ...) / (else ...) sub-arrays, or null
 * The condition sits after any leading `param`/`result` annotations and before
 * the `then`/`else` arms.
 */
const parseIf = (node) => {
  let condIdx = 1
  while (condIdx < node.length) {
    const c = node[condIdx]
    if (Array.isArray(c) && (c[0] === 'then' || c[0] === 'else' || c[0] === 'result' || c[0] === 'param')) {
      condIdx++
      continue
    }
    break
  }
  let thenBranch = null, elseBranch = null
  for (let i = condIdx + 1; i < node.length; i++) {
    const c = node[i]
    if (!Array.isArray(c)) continue
    if (c[0] === 'then') thenBranch = c
    else if (c[0] === 'else') elseBranch = c
  }
  return { condIdx, cond: node[condIdx], thenBranch, elseBranch }
}

// ==================== TREESHAKE ====================

/**
 * Remove unused functions, globals, types, tables.
 * Keeps exports and their transitive dependencies.
 * @param {Array} ast
 * @returns {Array}
 */
const treeshake = (ast) => {
  if (!Array.isArray(ast) || ast[0] !== 'module') return ast

  // Index spaces. Each entry is shared between its $name key and its numeric idx
  // key, so name/index lookups hit the same record. nodeMap covers reverse lookup
  // (used during the filtering pass for unnamed definitions).
  const funcs = new Map(), globals = new Map(), types = new Map()
  const tables = new Map(), memories = new Map()
  const nodeMap = new Map() // node → entry

  const register = (map, node, idx, isImport = false) => {
    const named = typeof node[1] === 'string' && node[1][0] === '$'
    const name = named ? node[1] : idx
    const inlineExported = !isImport && node.some(s => Array.isArray(s) && s[0] === 'export')
    const entry = { node, idx, used: inlineExported, isImport }
    map.set(name, entry)
    if (named) map.set(idx, entry)
    nodeMap.set(node, entry)
    return entry
  }

  let funcIdx = 0, globalIdx = 0, typeIdx = 0, tableIdx = 0, memIdx = 0
  const elems = [], data = [], exports = [], starts = []

  for (const node of ast.slice(1)) {
    if (!Array.isArray(node)) continue
    const kind = node[0]
    if (kind === 'type')   register(types,   node, typeIdx++)
    else if (kind === 'func')   register(funcs,   node, funcIdx++)
    else if (kind === 'global') register(globals, node, globalIdx++)
    else if (kind === 'table')  register(tables,  node, tableIdx++)
    else if (kind === 'memory') register(memories, node, memIdx++)
    else if (kind === 'import') {
      // Each import sub-item occupies its own slot in the relevant index space.
      for (const sub of node) {
        if (!Array.isArray(sub)) continue
        if (sub[0] === 'func')        register(funcs,    sub, funcIdx++,   true)
        else if (sub[0] === 'global') register(globals,  sub, globalIdx++, true)
        else if (sub[0] === 'table')  register(tables,   sub, tableIdx++,  true)
        else if (sub[0] === 'memory') register(memories, sub, memIdx++,    true)
      }
    }
    else if (kind === 'export') exports.push(node)
    else if (kind === 'start') starts.push(node)
    else if (kind === 'elem') elems.push(node)
    else if (kind === 'data') data.push(node)
  }

  // Worklist: function entries whose body still needs to be scanned for refs.
  const work = []
  const enqueue = (entry) => { if (entry && !entry.scanned) work.push(entry) }
  const markFunc = (ref) => {
    const e = funcs.get(ref); if (!e) return
    if (!e.used) e.used = true
    enqueue(e)
  }
  const markGlobal = (ref) => { const e = globals.get(ref); if (e) e.used = true }
  const markTable  = (ref) => { const e = tables.get(ref);  if (e) e.used = true }
  const markMemory = (ref) => { if (typeof ref === 'string' && ref[0] !== '$') ref = +ref; const e = memories.get(ref); if (e) e.used = true }
  const markType   = (ref) => { const e = types.get(ref);   if (e) e.used = true }

  // Roots: explicit exports, start funcs, elem-referenced funcs, inline-exported items.
  for (const exp of exports) {
    for (const sub of exp) {
      if (!Array.isArray(sub)) continue
      const [kind, ref] = sub
      if (kind === 'func') markFunc(ref)
      else if (kind === 'global') markGlobal(ref)
      else if (kind === 'table') markTable(ref)
      else if (kind === 'memory') markMemory(ref)
    }
  }
  for (const start of starts) {
    let ref = start[1]
    if (typeof ref === 'string' && ref[0] !== '$') ref = +ref
    markFunc(ref)
  }
  for (const elem of elems) {
    walk(elem, n => {
      if (Array.isArray(n) && n[0] === 'ref.func') markFunc(n[1])
      else if (typeof n === 'string' && n[0] === '$') markFunc(n)
    })
  }
  for (const d of data) {
    const first = d[1]
    if (Array.isArray(first) && first[0] === 'memory') markMemory(first[1])
    else if (typeof first === 'string' && first[0] === '$') markMemory(first)
    else if (Array.isArray(first)) markMemory(0)
  }
  for (const m of [funcs, globals, tables, memories]) for (const e of m.values()) if (e.used) enqueue(e)

  // If nothing anchors the module (no exports, start, elem, or inline exports),
  // assume the module is consumed elsewhere and keep everything.
  const hasAnchor = exports.length > 0 || starts.length > 0 || elems.length > 0 || work.length > 0
  if (!hasAnchor) {
    for (const m of [funcs, globals, tables, memories]) for (const e of m.values()) e.used = true
    return ast
  }

  // Drain worklist: each function body gets walked exactly once.
  while (work.length) {
    const entry = work.pop()
    if (entry.scanned) continue
    entry.scanned = true
    if (entry.isImport) continue
    walk(entry.node, n => {
      if (!Array.isArray(n)) {
        if (typeof n === 'string' && n[0] === '$') markFunc(n)
        return
      }
      const [op, ref] = n
      if (op === 'call' || op === 'return_call' || op === 'ref.func') markFunc(ref)
      else if (op === 'global.get' || op === 'global.set') markGlobal(ref)
      else if (op === 'type') markType(ref)
      else if (op === 'call_indirect' || op === 'return_call_indirect') {
        for (const sub of n) if (typeof sub === 'string' && sub[0] === '$') markTable(sub)
      }
      if (typeof op === 'string' && (op.startsWith('memory.') || op.includes('.load') || op.includes('.store'))) {
        markMemory(0)
      }
    })
  }

  // Filter: keep used definitions. nodeMap handles unnamed entries directly.
  const result = ['module']
  for (const node of ast.slice(1)) {
    if (!Array.isArray(node)) { result.push(node); continue }
    const kind = node[0]
    if (kind === 'func' || kind === 'global' || kind === 'type') {
      if (nodeMap.get(node)?.used) result.push(node)
    } else if (kind === 'import') {
      // Keep import only if any of its sub-items is used.
      let used = false
      for (const sub of node) {
        if (!Array.isArray(sub)) continue
        const e = nodeMap.get(sub)
        if (e?.used) { used = true; break }
      }
      if (used) result.push(node)
    } else {
      result.push(node)
    }
  }
  return result
}

// ==================== CONSTANT FOLDING ====================

/** IEEE 754 roundTiesToEven (bankers' rounding) */
const roundEven = (x) => x - Math.floor(x) !== 0.5 ? Math.round(x) : 2 * Math.round(x / 2)

// Bit-exact reinterpret helpers (preserve NaN payloads).
const _rb8 = new ArrayBuffer(8)
const _rf64 = new Float64Array(_rb8)
const _ri64 = new BigInt64Array(_rb8)
const _rb4 = new ArrayBuffer(4)
const _rf32 = new Float32Array(_rb4)
const _ri32 = new Int32Array(_rb4)
const i64FromF64 = (x) => { _rf64[0] = x; return _ri64[0] }
const f64FromI64 = (x) => { _ri64[0] = BigInt.asIntN(64, x); return _rf64[0] }
const i32FromF32 = (x) => { _rf32[0] = x; return _ri32[0] }
const f32FromI32 = (x) => { _ri32[0] = x | 0; return _rf32[0] }

/** Build i32 comparison folder: returns 1/0 */
const i32c = (fn) => (a, b) => fn(a, b) ? 1 : 0
/** Build unsigned i32 comparison folder */
const u32c = (fn) => (a, b) => fn(a >>> 0, b >>> 0) ? 1 : 0
/** Build i64 comparison folder */
const i64c = (fn) => (a, b) => fn(a, b) ? 1 : 0
/** Build unsigned i64 comparison folder */
const u64c = (fn) => (a, b) => fn(BigInt.asUintN(64, a), BigInt.asUintN(64, b)) ? 1 : 0

/**
 * Constant folders, keyed by op. Each entry is the fold function; the result
 * value-type is derived once via `resultType` (see `fold`).
 */
const FOLDABLE = {
  // i32 arithmetic
  'i32.add': (a, b) => (a + b) | 0,
  'i32.sub': (a, b) => (a - b) | 0,
  'i32.mul': (a, b) => Math.imul(a, b),
  'i32.div_s': (a, b) => b !== 0 ? (a / b) | 0 : null,
  'i32.div_u': (a, b) => b !== 0 ? ((a >>> 0) / (b >>> 0)) | 0 : null,
  'i32.rem_s': (a, b) => b !== 0 ? (a % b) | 0 : null,
  'i32.rem_u': (a, b) => b !== 0 ? ((a >>> 0) % (b >>> 0)) | 0 : null,
  'i32.and': (a, b) => a & b,
  'i32.or':  (a, b) => a | b,
  'i32.xor': (a, b) => a ^ b,
  'i32.shl':   (a, b) => a << (b & 31),
  'i32.shr_s': (a, b) => a >> (b & 31),
  'i32.shr_u': (a, b) => a >>> (b & 31),
  'i32.rotl': (a, b) => { b &= 31; return ((a << b) | (a >>> (32 - b))) | 0 },
  'i32.rotr': (a, b) => { b &= 31; return ((a >>> b) | (a << (32 - b))) | 0 },
  'i32.eq':   i32c((a, b) => a === b),
  'i32.ne':   i32c((a, b) => a !== b),
  'i32.lt_s': i32c((a, b) => a < b),
  'i32.lt_u': u32c((a, b) => a < b),
  'i32.gt_s': i32c((a, b) => a > b),
  'i32.gt_u': u32c((a, b) => a > b),
  'i32.le_s': i32c((a, b) => a <= b),
  'i32.le_u': u32c((a, b) => a <= b),
  'i32.ge_s': i32c((a, b) => a >= b),
  'i32.ge_u': u32c((a, b) => a >= b),
  'i32.eqz':   (a) => a === 0 ? 1 : 0,
  'i32.clz':   (a) => Math.clz32(a),
  'i32.ctz':   (a) => a === 0 ? 32 : 31 - Math.clz32(a & -a),
  'i32.popcnt': (a) => { let c = 0; while (a) { c += a & 1; a >>>= 1 } return c },
  'i32.wrap_i64':   (a) => Number(BigInt.asIntN(32, a)),
  'i32.extend8_s':  (a) => (a << 24) >> 24,
  'i32.extend16_s': (a) => (a << 16) >> 16,

  // i64 (using BigInt)
  'i64.add': (a, b) => BigInt.asIntN(64, a + b),
  'i64.sub': (a, b) => BigInt.asIntN(64, a - b),
  'i64.mul': (a, b) => BigInt.asIntN(64, a * b),
  'i64.div_s': (a, b) => b !== 0n ? BigInt.asIntN(64, a / b) : null,
  'i64.div_u': (a, b) => b !== 0n ? BigInt.asUintN(64, BigInt.asUintN(64, a) / BigInt.asUintN(64, b)) : null,
  'i64.rem_s': (a, b) => b !== 0n ? BigInt.asIntN(64, a % b) : null,
  'i64.rem_u': (a, b) => b !== 0n ? BigInt.asUintN(64, BigInt.asUintN(64, a) % BigInt.asUintN(64, b)) : null,
  'i64.and': (a, b) => BigInt.asIntN(64, a & b),
  'i64.or':  (a, b) => BigInt.asIntN(64, a | b),
  'i64.xor': (a, b) => BigInt.asIntN(64, a ^ b),
  'i64.shl':   (a, b) => BigInt.asIntN(64, a << (b & 63n)),
  'i64.shr_s': (a, b) => BigInt.asIntN(64, a >> (b & 63n)),
  'i64.shr_u': (a, b) => BigInt.asUintN(64, BigInt.asUintN(64, a) >> (b & 63n)),
  'i64.eq':   i64c((a, b) => a === b),
  'i64.ne':   i64c((a, b) => a !== b),
  'i64.lt_s': i64c((a, b) => a < b),
  'i64.lt_u': u64c((a, b) => a < b),
  'i64.gt_s': i64c((a, b) => a > b),
  'i64.gt_u': u64c((a, b) => a > b),
  'i64.le_s': i64c((a, b) => a <= b),
  'i64.le_u': u64c((a, b) => a <= b),
  'i64.ge_s': i64c((a, b) => a >= b),
  'i64.ge_u': u64c((a, b) => a >= b),
  'i64.eqz': (a) => a === 0n ? 1 : 0,
  'i64.extend_i32_s': (a) => BigInt(a),
  'i64.extend_i32_u': (a) => BigInt(a >>> 0),
  'i64.extend8_s':    (a) => BigInt.asIntN(64, BigInt.asIntN(8, a)),
  'i64.extend16_s':   (a) => BigInt.asIntN(64, BigInt.asIntN(16, a)),
  'i64.extend32_s':   (a) => BigInt.asIntN(64, BigInt.asIntN(32, a)),

  // f32/f64 (NaN/precision-aware via Math.fround)
  'f32.add': (a, b) => Math.fround(a + b),
  'f32.sub': (a, b) => Math.fround(a - b),
  'f32.mul': (a, b) => Math.fround(a * b),
  'f32.div': (a, b) => Math.fround(a / b),
  'f32.neg':   (a) => Math.fround(-a),
  'f32.abs':   (a) => Math.fround(Math.abs(a)),
  'f32.sqrt':  (a) => Math.fround(Math.sqrt(a)),
  'f32.ceil':  (a) => Math.fround(Math.ceil(a)),
  'f32.floor': (a) => Math.fround(Math.floor(a)),
  'f32.trunc': (a) => Math.fround(Math.trunc(a)),
  'f32.nearest': (a) => Math.fround(roundEven(a)),

  'f64.add': (a, b) => a + b,
  'f64.sub': (a, b) => a - b,
  'f64.mul': (a, b) => a * b,
  'f64.div': (a, b) => a / b,
  'f64.neg':   (a) => -a,
  'f64.abs':   Math.abs,
  'f64.sqrt':  Math.sqrt,
  'f64.ceil':  Math.ceil,
  'f64.floor': Math.floor,
  'f64.trunc': Math.trunc,
  'f64.nearest': roundEven,

  // Bit-exact reinterprets (preserve NaN payloads)
  'i32.reinterpret_f32': i32FromF32,
  'f32.reinterpret_i32': f32FromI32,
  'i64.reinterpret_f64': i64FromF64,
  'f64.reinterpret_i64': f64FromI64,

  // Numeric conversions (value-preserving where representable)
  'f32.convert_i32_s': (a) => Math.fround(a | 0),
  'f32.convert_i32_u': (a) => Math.fround(a >>> 0),
  'f32.convert_i64_s': (a) => Math.fround(Number(BigInt.asIntN(64, a))),
  'f32.convert_i64_u': (a) => Math.fround(Number(BigInt.asUintN(64, a))),
  'f64.convert_i32_s': (a) => (a | 0),
  'f64.convert_i32_u': (a) => (a >>> 0),
  'f64.convert_i64_s': (a) => Number(BigInt.asIntN(64, a)),
  'f64.convert_i64_u': (a) => Number(BigInt.asUintN(64, a)),
  'f32.demote_f64':    (a) => Math.fround(a),
  'f64.promote_f32':   (a) => Math.fround(a),
}

/**
 * Parse a WAT `nan` / `nan:canonical` / `nan:arithmetic` / `nan:0xPAYLOAD`
 * literal to a JS number with the exact bit pattern. `Number('nan:0x…')`
 * collapses to canonical NaN, destroying the payload that NaN-boxing schemes
 * (jz, etc.) encode their pointer/sentinel bits into. Returns null if `s` is
 * not a NaN literal so callers can fall through to plain Number parsing.
 */
const _parseNanF64 = (s, i = s?.indexOf?.('nan')) => {
  if (i < 0 || i == null) return null
  let tail = s.slice(i + 4).replaceAll('_', ''),
      bits = (s[i + 3] === ':' && tail !== 'canonical' && tail !== 'arithmetic' ? BigInt(tail) : 0x8000000000000n)
  _ri64[0] = BigInt.asIntN(64, bits | 0x7ff0000000000000n | (s[0] === '-' ? 1n << 63n : 0n))
  return _rf64[0]
}
const _parseNanF32 = (s, i = s?.indexOf?.('nan')) => {
  if (i < 0 || i == null) return null
  let tail = s.slice(i + 4).replaceAll('_', ''),
      bits = (s[i + 3] === ':' && tail !== 'canonical' && tail !== 'arithmetic' ? parseInt(tail) : 0x400000)
  _ri32[0] = (bits | 0x7f800000 | (s[0] === '-' ? 0x80000000 : 0)) | 0
  return _rf32[0]
}

/**
 * Extract constant value from node.
 * @param {any} node
 * @returns {{type: string, value: number|bigint}|null}
 */
const getConst = (node) => {
  if (!Array.isArray(node) || node.length !== 2) return null
  const [op, val] = node
  if (op === 'i32.const') return { type: 'i32', value: (typeof val === 'string' ? parseInt(val.replaceAll('_', '')) : val) | 0 }
  if (op === 'i64.const') return { type: 'i64', value: typeof val === 'string' ? BigInt(val.replaceAll('_', '')) : BigInt(val) }
  if (op === 'f32.const') {
    const n = _parseNanF32(val)
    return { type: 'f32', value: n !== null ? n : Math.fround(Number(val)) }
  }
  if (op === 'f64.const') {
    const n = _parseNanF64(val)
    return { type: 'f64', value: n !== null ? n : Number(val) }
  }
  return null
}

/**
 * Create const node from value.
 * @param {string} type
 * @param {number|bigint} value
 * @returns {Array}
 */
const makeConst = (type, value) => {
  if (type === 'i32') return ['i32.const', value | 0]
  if (type === 'i64') return ['i64.const', value]
  if (type === 'f32') return ['f32.const', Math.fround(value)]
  if (type === 'f64') return ['f64.const', value]
  return null
}

/**
 * Fold constant expressions.
 * @param {Array} ast
 * @returns {Array}
 */
const fold = (ast) => {
  return walkPost(ast, (node) => {
    if (!Array.isArray(node)) return
    const fn = FOLDABLE[node[0]]
    if (!fn) return

    // Arity comes from the NODE — every WAT op is fixed-arity, so node.length
    // fully determines unary vs binary. NEVER from Function.length: the
    // self-host kernel's closures don't carry a faithful `.length`, and the
    // old `fn.length === 1/2` checks silently disabled ALL folding in-kernel
    // (the L2 self-host divergence — unfolded consts fed the vectorizer
    // shapes native never produces).
    // Unary
    if (node.length === 2) {
      const a = getConst(node[1])
      if (!a) return
      const r = fn(a.value)
      if (r === null || r === undefined) return
      return makeConst(resultType(node[0]), r)
    }
    // Binary
    if (node.length === 3) {
      const a = getConst(node[1]), b = getConst(node[2])
      if (!a || !b) return
      const r = fn(a.value, b.value)
      if (r === null || r === undefined) return
      return makeConst(resultType(node[0]), r)
    }
  })
}

// ==================== IDENTITY REMOVAL ====================

/**
 * Create identity checker for commutative binary ops:
 *   neutral op x → x  and  x op neutral → x
 */
const commutativeIdentity = (neutral) => (a, b) => {
  const ca = getConst(a), cb = getConst(b)
  if (ca?.value === neutral) return b
  if (cb?.value === neutral) return a
  return null
}

/**
 * Create identity checker for right-neutral binary ops:
 *   x op neutral → x
 */
const rightIdentity = (neutral) => (a, b) => getConst(b)?.value === neutral ? a : null

/** Identity operations that can be simplified */
const IDENTITIES = {
  // x + 0 → x, 0 + x → x
  'i32.add': commutativeIdentity(0),
  'i64.add': commutativeIdentity(0n),
  // x - 0 → x
  'i32.sub': rightIdentity(0),
  'i64.sub': rightIdentity(0n),
  // x * 1 → x, 1 * x → x
  'i32.mul': commutativeIdentity(1),
  'i64.mul': commutativeIdentity(1n),
  // x / 1 → x
  'i32.div_s': rightIdentity(1),
  'i32.div_u': rightIdentity(1),
  'i64.div_s': rightIdentity(1n),
  'i64.div_u': rightIdentity(1n),
  // x & -1 → x, -1 & x → x (all bits set)
  'i32.and': commutativeIdentity(-1),
  'i64.and': commutativeIdentity(-1n),
  // x | 0 → x, 0 | x → x
  'i32.or': commutativeIdentity(0),
  'i64.or': commutativeIdentity(0n),
  // x ^ 0 → x, 0 ^ x → x
  'i32.xor': commutativeIdentity(0),
  'i64.xor': commutativeIdentity(0n),
  // x << 0 → x, x >> 0 → x
  'i32.shl': rightIdentity(0),
  'i32.shr_s': rightIdentity(0),
  'i32.shr_u': rightIdentity(0),
  'i64.shl': rightIdentity(0n),
  'i64.shr_s': rightIdentity(0n),
  'i64.shr_u': rightIdentity(0n),
  // f + 0 → x (careful with -0.0, skip for floats)
  // f * 1 → x (careful with NaN, skip for floats)
}

/**
 * Remove identity operations.
 * @param {Array} ast
 * @returns {Array}
 */
const identity = (ast) => {
  return walkPost(ast, (node) => {
    if (!Array.isArray(node) || node.length !== 3) return
    const fn = IDENTITIES[node[0]]
    if (!fn) return
    const result = fn(node[1], node[2])
    if (result === null) return  // no optimization, keep original
    return result
  })
}

// ==================== STRENGTH REDUCTION ====================

/**
 * Strength reduction: replace expensive ops with cheaper equivalents.
 * @param {Array} ast
 * @returns {Array}
 */
const strength = (ast) => {
  return walkPost(ast, (node) => {
    if (!Array.isArray(node) || node.length !== 3) return
    const [op, a, b] = node

    // x * 2^n → x << n
    if (op === 'i32.mul') {
      const cb = getConst(b)
      if (cb && cb.value > 0 && (cb.value & (cb.value - 1)) === 0) {
        const shift = Math.log2(cb.value)
        if (Number.isInteger(shift)) return ['i32.shl', a, ['i32.const', shift]]
      }
      const ca = getConst(a)
      if (ca && ca.value > 0 && (ca.value & (ca.value - 1)) === 0) {
        const shift = Math.log2(ca.value)
        if (Number.isInteger(shift)) return ['i32.shl', b, ['i32.const', shift]]
      }
    }
    if (op === 'i64.mul') {
      const cb = getConst(b)
      if (cb && cb.value > 0n && (cb.value & (cb.value - 1n)) === 0n) {
        const shift = BigInt(cb.value.toString(2).length - 1)
        return ['i64.shl', a, ['i64.const', shift]]
      }
      const ca = getConst(a)
      if (ca && ca.value > 0n && (ca.value & (ca.value - 1n)) === 0n) {
        const shift = BigInt(ca.value.toString(2).length - 1)
        return ['i64.shl', b, ['i64.const', shift]]
      }
    }

    // x / 2^n → x >> n (unsigned only, signed division is more complex)
    if (op === 'i32.div_u') {
      const cb = getConst(b)
      if (cb && cb.value > 0 && (cb.value & (cb.value - 1)) === 0) {
        const shift = Math.log2(cb.value)
        if (Number.isInteger(shift)) return ['i32.shr_u', a, ['i32.const', shift]]
      }
    }
    if (op === 'i64.div_u') {
      const cb = getConst(b)
      if (cb && cb.value > 0n && (cb.value & (cb.value - 1n)) === 0n) {
        const shift = BigInt(cb.value.toString(2).length - 1)
        return ['i64.shr_u', a, ['i64.const', shift]]
      }
    }

    // x % 2^n → x & (2^n - 1) (unsigned only)
    if (op === 'i32.rem_u') {
      const cb = getConst(b)
      if (cb && cb.value > 0 && (cb.value & (cb.value - 1)) === 0) {
        return ['i32.and', a, ['i32.const', cb.value - 1]]
      }
    }
    if (op === 'i64.rem_u') {
      const cb = getConst(b)
      if (cb && cb.value > 0n && (cb.value & (cb.value - 1n)) === 0n) {
        return ['i64.and', a, ['i64.const', cb.value - 1n]]
      }
    }
  })
}

// ==================== BRANCH SIMPLIFICATION ====================

/**
 * Simplify branches with constant conditions.
 * @param {Array} ast
 * @returns {Array}
 */
const branch = (ast) => {
  return walkPost(ast, (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]

    // (if (i32.const 0) then else) → else
    // (if (i32.const N) then else) → then (N != 0)
    if (op === 'if') {
      const { condIdx, cond, thenBranch, elseBranch } = parseIf(node)
      const c = getConst(cond)
      if (!c) return
      const taken = c.value !== 0 && c.value !== 0n ? thenBranch : elseBranch
      if (taken && taken.length > 1) {
        const contents = taken.slice(1)
        // Preserve the if's block type (result/param). A typed `if` leaves a value
        // on the stack; collapsing it to the taken branch must keep that branch's
        // value in a same-typed block, else the contents land in a void context and
        // the value is left dangling → "expected 0 elements on the stack for fallthru".
        const blockType = node.slice(1, condIdx).filter(p => Array.isArray(p) && (p[0] === 'result' || p[0] === 'param'))
        if (blockType.length) return ['block', ...blockType, ...contents]
        return contents.length === 1 ? contents[0] : ['block', ...contents]
      }
      return ['nop']
    }

    // (br_if $label (i32.const 0)) → nop
    // (br_if $label (i32.const N)) → br $label (N != 0)
    if (op === 'br_if' && node.length >= 3) {
      const cond = node[node.length - 1]
      const c = getConst(cond)
      if (!c) return
      if (c.value === 0 || c.value === 0n) return ['nop']
      return ['br', node[1]]
    }

    // (select a b (i32.const 0)) → b
    // (select a b (i32.const N)) → a (N != 0)
    if (op === 'select' && node.length >= 4) {
      const cond = node[node.length - 1]
      const c = getConst(cond)
      if (!c) return
      if (c.value === 0 || c.value === 0n) return node[2] // b
      return node[1] // a
    }
  })
}

// ==================== GUARD-AWARE TAG REFINEMENT ====================

/**
 * Fold NaN-box tag reads under dominating tag guards (jz-domain knowledge).
 *
 * jz reads a value's 4-bit NaN-box tag in three equivalent forms:
 *   A. (i32.and (i32.wrap_i64 (i64.shr_u PTR (i64.const 47))) (i32.const 15))
 *   B. (i32.wrap_i64 (i64.and (i64.shr_u PTR (i64.const 47)) (i64.const 15)))
 *   C. (call $__ptr_type PTR)
 * where PTR is (i64.reinterpret_f64 (local.get $X)) or an i64 local copy of it.
 *
 * After `inlineOnce` splices a generic helper (e.g. $__len's 5-way tag
 * dispatch) into an arm already guarded by `tag(X) == K`, the recomputed tag
 * is a known constant — but no structural pass can see it: forms A and B
 * differ shape-wise, and the value flows through reinterpret/copy locals.
 * This pass tracks tag-of-X facts through if-arms and folds tag reads to
 * constants; the regular fold/branch/vacuum passes then delete the dead
 * dispatch arms. This is the single biggest source of wasm-opt's remaining
 * slack on jz output (~10% on typed-array modules).
 *
 * Soundness model — facts and aliases are keyed by the f64 SOURCE local $X
 * (tags live in the value's bits, so only local writes can invalidate, never
 * calls/stores):
 *   - any local.set/tee of $X kills its fact and every alias derived from it
 *   - leaving a block kills facts/aliases for locals written inside it
 *     (a br may have skipped the write)
 *   - entering a loop kills facts for locals written anywhere in it
 *     (the back edge re-enters after the write)
 *   - then/else facts are layered over a snapshot and restored on exit;
 *     writes inside either arm kill outer facts afterward
 *   - within straight-line code, sequential registration is exact: wasm has
 *     no goto, so execution between branch points is linear
 */
const guardRefine = (ast) => {
  if (Array.isArray(ast)) for (const node of ast) if (Array.isArray(node) && node[0] === 'func') refineGuards(node)
  return ast
}

const EMPTY_SET = new Set()

const refineGuards = (fn) => {
  const ptrAlias = new Map()  // i64 local → f64 source local (reinterpret copy)
  const tagAlias = new Map()  // i32 local → f64 source local (holds tag(X))
  const eqFact = new Map()    // f64 local → known tag K
  const neFact = new Map()    // f64 local → Set of excluded tags

  const intVal = (n) => {
    if (!Array.isArray(n) || n.length !== 2 || (n[0] !== 'i32.const' && n[0] !== 'i64.const')) return null
    const v = typeof n[1] === 'string' ? Number(n[1].replaceAll('_', '')) : Number(n[1])
    return Number.isFinite(v) ? v : null
  }
  const i32Val = (n) => Array.isArray(n) && n[0] === 'i32.const' ? intVal(n) : null

  // PTR node → f64 source local, or null.
  const ptrSrc = (n) => {
    if (!Array.isArray(n)) return null
    if (n[0] === 'i64.reinterpret_f64' && Array.isArray(n[1]) && n[1][0] === 'local.get' && typeof n[1][1] === 'string') return n[1][1]
    if (n[0] === 'local.get' && typeof n[1] === 'string') return ptrAlias.get(n[1]) ?? null
    return null
  }
  // tag-of-X node (forms A/B/C or a tag-alias local read) → X, or null.
  const tagSrc = (n) => {
    if (!Array.isArray(n)) return null
    const op = n[0]
    if (op === 'local.get' && typeof n[1] === 'string') return tagAlias.get(n[1]) ?? null
    if (op === 'call' && n[1] === '$__ptr_type' && n.length === 3) return ptrSrc(n[2])
    const shifted = (m) => Array.isArray(m) && m[0] === 'i64.shr_u' && intVal(m[2]) === 47 ? ptrSrc(m[1]) : null
    if (op === 'i32.and' && n.length === 3) {  // form A (mask either side)
      const [a, b] = i32Val(n[2]) === 15 ? [n[1], null] : i32Val(n[1]) === 15 ? [n[2], null] : [null, null]
      if (a && Array.isArray(a) && a[0] === 'i32.wrap_i64') return shifted(a[1])
    }
    if (op === 'i32.wrap_i64' && Array.isArray(n[1]) && n[1][0] === 'i64.and') {  // form B
      const m = n[1]
      if (intVal(m[2]) === 15) return shifted(m[1])
      if (intVal(m[1]) === 15) return shifted(m[2])
    }
    return null
  }

  const killLocal = (name) => {
    ptrAlias.delete(name); tagAlias.delete(name); eqFact.delete(name); neFact.delete(name)
    for (const [p, x] of ptrAlias) if (x === name) ptrAlias.delete(p)
    for (const [t, x] of tagAlias) if (x === name) tagAlias.delete(t)
  }
  // Write-sets are queried per if/loop/block; memoize bottom-up so each node is
  // visited once per function, not once per enclosing construct. Keyed by node
  // identity — sound because walkSeq only ever *replaces* whole subtrees
  // (parent[idx] = const), never adds writes to an existing one.
  const writesMemo = new Map()
  const writesOf = (n) => {
    if (!Array.isArray(n)) return EMPTY_SET
    let s = writesMemo.get(n)
    if (s) return s
    s = new Set()
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') s.add(n[1])
    for (let i = 1; i < n.length; i++) for (const w of writesOf(n[i])) s.add(w)
    writesMemo.set(n, s)
    return s
  }
  const snap = () => [new Map(eqFact), new Map([...neFact].map(([k, s]) => [k, new Set(s)])), new Map(ptrAlias), new Map(tagAlias)]
  const reset = (m, src) => { m.clear(); for (const [k, v] of src) m.set(k, v) }
  const restore = ([e, n, p, t]) => { reset(eqFact, e); reset(neFact, n); reset(ptrAlias, p); reset(tagAlias, t) }

  // Facts implied by `cond` being truthy (sense=true) / falsy (sense=false).
  const condFacts = (cond, sense, out) => {
    if (!Array.isArray(cond)) return out
    const op = cond[0]
    if (op === 'i32.eqz') return condFacts(cond[1], !sense, out)
    if (op === 'i32.and' && sense && cond.length === 3) { condFacts(cond[1], true, out); condFacts(cond[2], true, out); return out }
    if (op === 'i32.or' && !sense && cond.length === 3) { condFacts(cond[1], false, out); condFacts(cond[2], false, out); return out }
    if ((op === 'i32.eq' || op === 'i32.ne') && cond.length === 3) {
      let x = tagSrc(cond[1]), k = i32Val(cond[2])
      if (x == null || k == null) { x = tagSrc(cond[2]); k = i32Val(cond[1]) }
      if (x != null && k != null) out.push({ x, k, eq: (op === 'i32.eq') === sense })
      return out
    }
    const x = tagSrc(cond)  // bare tag as condition: truthy ⇒ tag≠0, falsy ⇒ tag==0
    if (x != null) out.push({ x, k: 0, eq: !sense })
    return out
  }
  const addFacts = (fs) => {
    for (const { x, k, eq } of fs) {
      if (eq) eqFact.set(x, k)
      else { let s = neFact.get(x); if (!s) neFact.set(x, s = new Set()); s.add(k) }
    }
  }

  const walkSeq = (node, parent, idx) => {
    if (!Array.isArray(node)) return
    const op = node[0]

    if (op === 'local.set' || op === 'local.tee') {
      if (Array.isArray(node[2])) walkSeq(node[2], node, 2)
      const name = node[1]
      if (typeof name !== 'string') return
      killLocal(name)
      const v = node[2]
      if (Array.isArray(v)) {
        if (v[0] === 'i64.reinterpret_f64' && Array.isArray(v[1]) && v[1][0] === 'local.get' && typeof v[1][1] === 'string') ptrAlias.set(name, v[1][1])
        else if (v[0] === 'local.get' && typeof v[1] === 'string' && ptrAlias.has(v[1])) ptrAlias.set(name, ptrAlias.get(v[1]))
        else { const tx = tagSrc(v); if (tx != null) tagAlias.set(name, tx) }
      }
      return
    }

    if (op === 'if') {
      const { condIdx } = parseIf(node)
      if (Array.isArray(node[condIdx])) walkSeq(node[condIdx], node, condIdx)
      const cond = node[condIdx]  // re-read: the walk may have folded it
      const { thenBranch, elseBranch } = parseIf(node)
      const writes = writesOf(node)
      const pre = snap()
      addFacts(condFacts(cond, true, []))
      if (thenBranch) for (let i = 1; i < thenBranch.length; i++) walkSeq(thenBranch[i], thenBranch, i)
      restore(pre)
      addFacts(condFacts(cond, false, []))
      if (elseBranch) for (let i = 1; i < elseBranch.length; i++) walkSeq(elseBranch[i], elseBranch, i)
      restore(pre)
      for (const w of writes) killLocal(w)
      return
    }

    if (op === 'loop') {
      const writes = writesOf(node)
      for (const w of writes) killLocal(w)
      for (let i = 1; i < node.length; i++) walkSeq(node[i], node, i)
      for (const w of writes) killLocal(w)
      return
    }

    if (op === 'block') {
      for (let i = 1; i < node.length; i++) walkSeq(node[i], node, i)
      for (const w of writesOf(node)) killLocal(w)
      return
    }

    // Whole-node tag read under an equality fact → constant.
    const tx = tagSrc(node)
    if (tx != null && eqFact.has(tx) && parent) { parent[idx] = ['i32.const', eqFact.get(tx)]; return }

    // eq/ne against a constant under a ne-fact (eq-facts are covered by the
    // tag-read fold above plus the regular `fold` pass).
    if ((op === 'i32.eq' || op === 'i32.ne') && node.length === 3) {
      let x = tagSrc(node[1]), k = i32Val(node[2])
      if (x == null || k == null) { x = tagSrc(node[2]); k = i32Val(node[1]) }
      if (x != null && k != null && neFact.get(x)?.has(k) && parent) {
        parent[idx] = ['i32.const', op === 'i32.eq' ? 0 : 1]
        return
      }
    }

    for (let i = 1; i < node.length; i++) walkSeq(node[i], node, i)
  }

  for (let i = 1; i < fn.length; i++) walkSeq(fn[i], fn, i)
}

// ==================== DEAD CODE ELIMINATION ====================

/** Control flow terminators */
const TERMINATORS = new Set(['unreachable', 'return', 'br', 'br_table'])

/**
 * Remove dead code after control flow terminators.
 * @param {Array} ast
 * @returns {Array}
 */
const deadcode = (ast) => {
  // Process each function body
  walk(ast, (node) => {
    if (!Array.isArray(node)) return
    const kind = node[0]

    // Process blocks: func, block, loop, if branches
    if (kind === 'func' || kind === 'block' || kind === 'loop') {
      eliminateDeadInBlock(node)
    }
    if (kind === 'if') {
      // Process then/else branches
      for (let i = 1; i < node.length; i++) {
        if (Array.isArray(node[i]) && (node[i][0] === 'then' || node[i][0] === 'else')) {
          eliminateDeadInBlock(node[i])
        }
      }
    }
  })

  return ast
}

/**
 * Remove instructions after terminators within a block.
 * @param {Array} block
 */
const eliminateDeadInBlock = (block) => {
  let terminated = false
  let firstTerminator = -1

  for (let i = 1; i < block.length; i++) {
    const node = block[i]

    // Skip type annotations
    if (Array.isArray(node)) {
      const op = node[0]
      if (op === 'param' || op === 'result' || op === 'local' || op === 'type' || op === 'export') continue

      if (terminated) {
        if (firstTerminator === -1) firstTerminator = i
      }

      if (TERMINATORS.has(op)) {
        terminated = true
        firstTerminator = i + 1
      }
    } else if (typeof node === 'string') {
      // String instructions like 'unreachable', 'return', 'drop', 'nop'
      if (terminated) {
        if (firstTerminator === -1) firstTerminator = i
      }

      if (TERMINATORS.has(node)) {
        terminated = true
        firstTerminator = i + 1
      }
    }
  }

  // Remove dead code
  if (firstTerminator > 0 && firstTerminator < block.length) {
    block.splice(firstTerminator)
  }
}

// ==================== LOCAL REUSE ====================

/**
 * Reuse locals of the same type to reduce total local count.
 * Basic version: deduplicate unused locals.
 * @param {Array} ast
 * @returns {Array}
 */
const localReuse = (ast) => {
  walk(ast, (node) => {
    if (!Array.isArray(node) || node[0] !== 'func') return

    // Collect local declarations and their types
    const localDecls = []
    const localTypes = new Map() // $name → type
    const usedLocals = new Set()

    // Find all local declarations and usages
    for (let i = 1; i < node.length; i++) {
      const sub = node[i]
      if (!Array.isArray(sub)) continue

      if (sub[0] === 'local') {
        localDecls.push({ node: sub, idx: i })
        // (local $name type) or (local type)
        if (typeof sub[1] === 'string' && sub[1][0] === '$') {
          localTypes.set(sub[1], sub[2])
        }
      }
      if (sub[0] === 'param') {
        // Params are also locals
        if (typeof sub[1] === 'string' && sub[1][0] === '$') {
          localTypes.set(sub[1], sub[2])
          usedLocals.add(sub[1]) // params always used
        }
      }
    }

    // Find which locals are actually used
    walk(node, (n) => {
      if (!Array.isArray(n)) return
      const op = n[0]
      if (op === 'local.get' || op === 'local.set' || op === 'local.tee') {
        const ref = n[1]
        if (typeof ref === 'string') usedLocals.add(ref)
      }
    })

    // Remove unused local declarations
    for (let i = localDecls.length - 1; i >= 0; i--) {
      const { idx, node: decl } = localDecls[i]
      const name = typeof decl[1] === 'string' && decl[1][0] === '$' ? decl[1] : null
      if (name && !usedLocals.has(name)) {
        node.splice(idx, 1)
      }
    }
  })

  return ast
}

// ==================== PROPAGATION & LOCAL ELIMINATION ====================

/** Operators with side effects: calls, mutators, control flow, exceptions, drops. */
const IMPURE_OPS = new Set([
  'call', 'call_indirect', 'return_call', 'return_call_indirect',
  'table.set', 'table.grow', 'table.fill', 'table.copy', 'table.init',
  'struct.set', 'struct.new',
  'array.set', 'array.new', 'array.new_fixed', 'array.new_data', 'array.new_elem',
  'array.init_data', 'array.init_elem', 'ref.i31',
  'global.set', 'local.set', 'local.tee',
  'unreachable', 'return',
  'br', 'br_if', 'br_table', 'br_on_null', 'br_on_non_null', 'br_on_cast', 'br_on_cast_fail',
  'throw', 'rethrow', 'throw_ref', 'try_table',
  'data.drop', 'elem.drop',
])

/** Substrings that flag an op as side-effecting (loads can trap, stores/atomics/memory ops mutate). */
const IMPURE_SUBSTRINGS = ['.store', 'memory.', '.atomic.']

/**
 * Pure means: no side effects, no traps we care about, no control flow.
 * Conservative — returns false for anything that might trap, mutate state, or branch.
 */
const isPure = (node) => {
  if (!Array.isArray(node)) return true
  const op = node[0]
  if (typeof op !== 'string') return false
  if (IMPURE_OPS.has(op)) return false
  for (const sub of IMPURE_SUBSTRINGS) if (op.includes(sub)) return false
  for (let i = 1; i < node.length; i++) if (Array.isArray(node[i]) && !isPure(node[i])) return false
  return true
}

/** Count all local.get/set/tee occurrences in one walk */
const countLocalUses = (node) => {
  const counts = new Map()
  const ensure = name => { if (!counts.has(name)) counts.set(name, { gets: 0, sets: 0, tees: 0 }); return counts.get(name) }
  walk(node, n => {
    if (!Array.isArray(n) || n.length < 2 || typeof n[1] !== 'string') return
    if (n[0] === 'local.get') ensure(n[1]).gets++
    else if (n[0] === 'local.set') ensure(n[1]).sets++
    else if (n[0] === 'local.tee') ensure(n[1]).tees++
  })
  return counts
}

/** A constant whose inlined form (opcode + immediate) is no wider than the ~2 B
 *  `local.get` it would replace — so propagating it to every use is byte-neutral
 *  at worst, and still drops the `local.set` + the `local` decl. f32/f64 consts
 *  (5/9 B) lose on reuse, so only narrow i32/i64 literals qualify. */
const isTinyConst = (node) => {
  const c = getConst(node)
  if (!c) return false
  if (c.type === 'i32') { const v = c.value | 0; return v >= -64 && v <= 63 }
  if (c.type === 'i64') { const v = typeof c.value === 'bigint' ? c.value : BigInt(c.value); return v >= -64n && v <= 63n }
  return false
}

/** A pure local→local copy value `(local.get $src)`, with $src ≠ the local being set.
 *  Substituting it for a `(local.get $dst)` is byte-neutral (local.get for local.get),
 *  so — unlike a reused wide constant — it can never grow an instruction, and it turns
 *  the copy `$dst = $src` into a dead store the next pass drops. Self-copies are
 *  excluded: they're no-ops that would re-trigger `changed` every round. (Propagating a
 *  copy lengthens $src's live range, which can rarely cost coalesceLocals a slot — a
 *  few bytes — but net-shrinks across the corpus, e.g. −1.7 KB on the watr self-host.) */
const isLocalCopy = (val, dest) =>
  Array.isArray(val) && val[0] === 'local.get' && val.length === 2 &&
  typeof val[1] === 'string' && val[1] !== dest

/** Can this tracked value be substituted for a local.get?
 *  - single use of a pure value: always shrinks (drops the set, the lone get, the decl);
 *  - any use of a tiny constant: byte-neutral at worst, still drops the set + decl;
 *  - any use of a pure local copy: byte-neutral, frees the copy as a dead store.
 *  Anything else (a wide constant reused many times, an impure expr) could inflate
 *  or reorder side effects, so it's left alone. Copy validity (the source not being
 *  reassigned between copy and use) is enforced by the same purgeRefs/branch-clear
 *  machinery that guards every tracked value. */
const canSubst = (k) => (k.pure && k.singleUse) || isTinyConst(k.val) || k.copy

/** Drop tracked values that read `$name`: rewriting `$name` makes them stale. */
const purgeRefs = (known, name) => {
  for (const [key, tracked] of known) {
    let refs = false
    walk(tracked.val, n => { if (Array.isArray(n) && (n[0] === 'local.get' || n[0] === 'local.tee') && n[1] === name) refs = true })
    if (refs) known.delete(key)
  }
}

/** True if `node` recursively contains an op that may read linear memory.
 *  Tracked values whose RHS reads memory go stale after any intervening
 *  memory-mutating op (`*.store`, `memory.copy/fill/init`, atomic stores/rmw). */
const readsMemory = (node) => {
  if (!Array.isArray(node)) return false
  const op = node[0]
  if (typeof op === 'string') {
    if (op.includes('.load') || op === 'memory.copy' || op === 'memory.size') return true
  }
  for (let i = 1; i < node.length; i++) if (readsMemory(node[i])) return true
  return false
}

/** True if `node` references state a `call` could mutate.
 *  Calls cannot touch caller locals (those live in the function frame), so
 *  pure expressions over locals + constants survive any intervening call; only
 *  memory loads, global reads, and table reads (or further calls) can be stale
 *  after one. */
const readsCallableState = (node) => {
  if (!Array.isArray(node)) return false
  const op = node[0]
  if (typeof op === 'string') {
    if (op === 'global.get' || op === 'table.get' || op === 'table.size') return true
    if (op === 'call' || op === 'call_indirect' || op === 'return_call' || op === 'return_call_indirect') return true
    if (op.includes('.load') || op === 'memory.copy' || op === 'memory.size') return true
  }
  for (let i = 1; i < node.length; i++) if (readsCallableState(node[i])) return true
  return false
}

/** True if `node` recursively contains an op that may write linear memory. */
const writesMemory = (node) => {
  if (!Array.isArray(node)) return false
  const op = node[0]
  if (typeof op === 'string') {
    if (op.endsWith('.store') || op === 'memory.copy' || op === 'memory.fill' || op === 'memory.init') return true
    // Atomic RMW / store / notify all mutate memory; `.atomic.load` doesn't.
    if (op.includes('.atomic.') && !op.endsWith('.load')) return true
  }
  for (let i = 1; i < node.length; i++) if (writesMemory(node[i])) return true
  return false
}

/** Try substitute local.get nodes with known values.
 *  When entering a nested scope (block/loop/if), drop tracking for any local
 *  that's re-assigned inside the subtree — the outer-tracked value is stale
 *  there. Without this, an outer `(local.set $x C)` would clobber an inner
 *  `(local.set $x V) (local.get $x)` (the inner get rewritten to `C` instead
 *  of `V`). Mostly latent until something — typically coalesceLocals — reuses
 *  one slot for the outer and inner roles, after which it surfaces as silent
 *  memory corruption. */
const substGets = (node, known) => {
  if (!Array.isArray(node)) return node
  const op = node[0]
  if (op === 'local.get' && node.length === 2) {
    const k = typeof node[1] === 'string' && known.get(node[1])
    if (k && canSubst(k)) return clone(k.val)
    return node
  }
  let inner = known
  if (isBranchScope(op)) {
    let cloned = null
    walk(node, n => {
      if (!Array.isArray(n)) return
      if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string' && known.has(n[1])) {
        if (!cloned) cloned = new Map(known)
        cloned.delete(n[1])
      }
    })
    if (cloned) inner = cloned
  }
  for (let i = 1; i < node.length; i++) {
    const r = substGets(node[i], inner)
    if (r !== node[i]) node[i] = r
    // WASM evaluates operands left-to-right. A `local.set`/`local.tee` in this
    // child updates the local before the next sibling reads it — drop tracked
    // entries that are now stale, else a pre-tee constant leaks into the next
    // sibling's `local.get` (visible after `coalesceLocals` aliases the tee'd
    // local with a sibling-read local, e.g. `alloc($x<<3, $x)` collapsing to
    // `alloc(BIG, SMALL)`).
    if (i + 1 < node.length && Array.isArray(node[i])) {
      walk(node[i], n => {
        if (!Array.isArray(n)) return
        if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string') {
          if (inner === known) inner = new Map(known)
          inner.delete(n[1])
          purgeRefs(inner, n[1])
        }
      })
    }
  }
  return node
}

/**
 * Forward propagation pass: track local.set values and substitute local.gets.
 * Returns true if any substitution was made.
 * @param {Array} funcNode
 * @param {Set<string>} params
 * @param {Map<string,{gets:number,sets:number,tees:number}>} useCounts
 */
const forwardPropagate = (funcNode, params, useCounts) => {
  let changed = false
  const getUseCount = name => useCounts.get(name) || { gets: 0, sets: 0, tees: 0 }
  const known = new Map()

  for (let i = 1; i < funcNode.length; i++) {
    const instr = funcNode[i]
    if (!Array.isArray(instr)) continue
    const op = instr[0]

    if (op === 'param' || op === 'result' || op === 'local' || op === 'type' || op === 'export') continue

    // Track local.set / local.tee values (tee writes too — its result also leaves
    // the value on the stack but the local is updated identically to set).
    if ((op === 'local.set' || op === 'local.tee') && instr.length === 3 && typeof instr[1] === 'string') {
      // substGets returns its argument unchanged unless the whole subtree
      // resolves to a substitution (bare `(local.get $x)` root case) — assign
      // back so the bare-RHS pattern actually propagates.
      const sr = substGets(instr[2], known)
      if (sr !== instr[2]) { instr[2] = sr; changed = true }
      // Nested `local.set`/`local.tee` inside the RHS already ran when the next
      // statement begins — drop tracked values that read those locals, else a
      // later `local.get` substitutes a stale expression (e.g. `$ptr`'s
      // `(local.get $ai0)` after a nested `(local.tee $ai0 …)` overwrites it).
      walk(instr[2], n => {
        if (!Array.isArray(n)) return
        if ((n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string')
          { known.delete(n[1]); purgeRefs(known, n[1]) }
      })
      const uses = getUseCount(instr[1])
      purgeRefs(known, instr[1]) // entries that read this local just went stale
      // Any tracked value whose RHS reads memory must be invalidated by the
      // RHS itself if it writes memory (rare — only via nested store/copy/etc.,
      // which would also pass through the post-statement purge below).
      if (writesMemory(instr[2])) {
        for (const [key, tracked] of known) if (tracked.readsMem) known.delete(key)
      }
      known.set(instr[1], {
        val: instr[2], pure: isPure(instr[2]),
        readsMem: readsMemory(instr[2]),
        singleUse: uses.gets <= 1 && uses.sets <= 1 && uses.tees === 0,
        copy: isLocalCopy(instr[2], instr[1])
      })
      continue
    }

    // Invalidate at control-flow boundaries
    if (isBranchScope(op)) known.clear()
    // Calls invalidate tracked values that read state a callee can mutate
    // (memory, globals, tables, nested calls). Pure expressions over locals
    // and constants survive — callees can't reach caller locals.
    if (op === 'call' || op === 'call_indirect' || op === 'return_call' || op === 'return_call_indirect')
      for (const [key, tracked] of known) if (readsCallableState(tracked.val)) known.delete(key)

    // Substitute: standalone local.get (walkPost can't replace root)
    if (op === 'local.get' && instr.length === 2 && typeof instr[1] === 'string') {
      const tracked = known.get(instr[1])
      if (tracked && canSubst(tracked)) {
        const replacement = clone(tracked.val)
        instr.length = 0; instr.push(...(Array.isArray(replacement) ? replacement : [replacement]))
        changed = true; continue
      }
    }

    // Substitute nested local.gets (skip control-flow nodes — locals may be reassigned inside)
    if (op !== 'block' && op !== 'loop' && op !== 'if') {
      const prev = clone(instr)
      substGets(instr, known)
      if (!equal(prev, instr)) changed = true
      // Invalidate tracking for any names written by a nested set/tee — those
      // writes happened mid-expression and the substGets above used the
      // pre-write tracked value (correct), but later reads must see the new
      // (untracked) value, not the stale constant.
      walk(instr, n => {
        if (Array.isArray(n) && (n[0] === 'local.set' || n[0] === 'local.tee') && typeof n[1] === 'string')
          { known.delete(n[1]); purgeRefs(known, n[1]) }
      })
      // Memory write in this statement (any nested store / memory.copy / etc.)
      // invalidates every tracked value whose RHS reads memory: inlining one
      // later would substitute a now-stale load. Without this, a swap idiom
      //   (local.set $t (f64.load $p)) (f64.store $p (f64.load $q)) (f64.store $q (local.get $t))
      // collapses to two stores that round-trip the same value:
      //   (f64.store $p (f64.load $q)) (f64.store $q (f64.load $p))   ;; bug
      if (writesMemory(instr)) {
        for (const [key, tracked] of known) if (tracked.readsMem) known.delete(key)
      }
    }
  }

  return changed
}

/**
 * Remove adjacent (local.set $x expr) (local.get $x) pairs when $x has no other uses.
 * Returns true if any pair was removed.
 * @param {Array} funcNode
 * @param {Set<string>} params
 * @param {Map<string,{gets:number,sets:number,tees:number}>} useCounts
 */
const eliminateSetGetPairs = (funcNode, params, useCounts) => {
  let changed = false

  for (let i = 1; i < funcNode.length - 1; i++) {
    const setNode = funcNode[i]
    const getNode = funcNode[i + 1]
    if (!Array.isArray(setNode) || setNode[0] !== 'local.set' || setNode.length !== 3) continue
    if (!Array.isArray(getNode) || getNode[0] !== 'local.get' || getNode.length !== 2) continue
    const name = setNode[1]
    if (getNode[1] !== name || params.has(name)) continue
    const uses = useCounts.get(name) || { gets: 0, sets: 0, tees: 0 }
    // Must be exactly 1 set and 1 get (the pair), no tees
    if (uses.sets !== 1 || uses.gets !== 1 || uses.tees !== 0) continue
    // Replace the pair with just the expression
    const expr = clone(setNode[2])
    funcNode.splice(i, 2, ...(Array.isArray(expr) ? [expr] : [expr]))
    changed = true
    i-- // adjust index because we removed 2 and inserted 1
  }

  return changed
}

/**
 * Convert (local.set $x expr) (local.get $x) to (local.tee $x expr)
 * when $x has additional uses beyond this pair.
 * @param {Array} funcNode
 * @param {Set<string>} params
 * @param {Map<string,{gets:number,sets:number,tees:number}>} useCounts
 */
const createLocalTees = (funcNode, params, useCounts) => {
  let changed = false

  for (let i = 1; i < funcNode.length - 1; i++) {
    const setNode = funcNode[i]
    const getNode = funcNode[i + 1]
    if (!Array.isArray(setNode) || setNode[0] !== 'local.set' || setNode.length !== 3) continue
    if (!Array.isArray(getNode) || getNode[0] !== 'local.get' || getNode.length !== 2) continue
    const name = setNode[1]
    if (getNode[1] !== name || params.has(name)) continue
    const uses = useCounts.get(name) || { gets: 0, sets: 0, tees: 0 }
    // Only if there's more than just this set+get pair
    if (uses.sets + uses.gets + uses.tees <= 2) continue
    // Replace with local.tee (set+get combined)
    funcNode.splice(i, 2, ['local.tee', name, clone(setNode[2])])
    changed = true
  }

  return changed
}

/**
 * Remove dead stores and unused local declarations in a reverse pass.
 * Returns true if anything was removed.
 * @param {Array} funcNode
 * @param {Set<string>} params
 * @param {Map<string,{gets:number,sets:number,tees:number}>} useCounts
 */
const eliminateDeadStores = (funcNode, params, useCounts) => {
  let changed = false
  const getPostUseCount = name => useCounts.get(name) || { gets: 0, sets: 0, tees: 0 }

  for (let i = funcNode.length - 1; i >= 1; i--) {
    const sub = funcNode[i]
    if (!Array.isArray(sub)) continue
    const name = typeof sub[1] === 'string' ? sub[1] : null
    if (!name || params.has(name)) continue
    const uses = getPostUseCount(name)
    // Dead store: set but never read.
    if (sub[0] === 'local.set' && uses.gets === 0 && uses.tees === 0) {
      // `(local.set $x VALUE)` — drop the store with its value, but only when
      // VALUE is pure (its side effects would otherwise still need to run).
      if (sub.length === 3) {
        if (isPure(sub[2])) { funcNode.splice(i, 1); changed = true }
      }
      // Bare `(local.set $x)` — the value is implicit on the stack (e.g. an
      // exception payload landing from a `try_table` catch). Demote to `drop`
      // so the dead store goes away without unbalancing the stack.
      else if (sub.length === 2) {
        funcNode[i] = ['drop']; changed = true
      }
    }
    // Unused local declaration
    else if (sub[0] === 'local' && name[0] === '$' && uses.gets === 0 && uses.sets === 0 && uses.tees === 0) {
      funcNode.splice(i, 1); changed = true
    }
  }

  return changed
}

/**
 * Drop `(local.set $x A)` when the very next statement re-sets $x without reading it
 * first (A pure). The two writes are adjacent, so A's value is overwritten before any
 * observation — it's dead. The whole-function {@link eliminateDeadStores} misses this:
 * it only fires when $x is read NOWHERE, whereas here $x is live later, just not
 * between these two writes. Pairs with copy-propagation, which rewrites
 * `$x=$y; $x=f($x)` to `$x=$y; $x=f($y)` — an adjacent dead store this removes,
 * collapsing the round-trip jz's value-model lowering leaves behind.
 * @param {Array} funcNode  a straight-line scope (body / block / loop / then / else)
 * @param {Set<string>} params
 */
const eliminateAdjacentDeadStores = (funcNode, params) => {
  let changed = false
  for (let i = 1; i < funcNode.length - 1; i++) {
    const a = funcNode[i], b = funcNode[i + 1]
    // `a` must be a plain set (a tee leaves its value on the stack — not removable);
    // `b` may be a set OR a tee (both overwrite the local before `a`'s value is read).
    if (!Array.isArray(a) || a[0] !== 'local.set' || a.length !== 3) continue
    if (!Array.isArray(b) || (b[0] !== 'local.set' && b[0] !== 'local.tee') || b.length !== 3 || b[1] !== a[1]) continue
    if (params.has(a[1]) || !isPure(a[2])) continue
    // Dead only if b's value doesn't read $x before overwriting it.
    let reads = false
    walk(b[2], n => { if (Array.isArray(n) && (n[0] === 'local.get' || n[0] === 'local.tee') && n[1] === a[1]) reads = true })
    if (reads) continue
    funcNode.splice(i, 1); changed = true; i--
  }
  return changed
}

/**
 * Propagate values through locals and eliminate single-use/dead locals.
 * Constants propagate to all uses; pure single-use exprs inline into get site.
 * Multi-pass with batch counting for convergence.
 */
/** Block-like nodes whose body is a straight-line instruction list (after any header). */
const isScopeNode = (n) => Array.isArray(n) &&
  (n[0] === 'func' || n[0] === 'block' || n[0] === 'loop' || n[0] === 'then' || n[0] === 'else')

/** Branch-target scopes: ops that carry an optional label/result header and can be jumped to via br/br_if. */
const isBranchScope = (op) => op === 'block' || op === 'loop' || op === 'if'

const propagate = (ast) => {
  walk(ast, (funcNode) => {
    if (!Array.isArray(funcNode) || funcNode[0] !== 'func') return

    const params = new Set()
    for (const sub of funcNode)
      if (Array.isArray(sub) && sub[0] === 'param' && typeof sub[1] === 'string') params.add(sub[1])

    // Propagation runs per straight-line scope: the function body and every nested
    // `block`/`loop`/`then`/`else` (including ones embedded in an expression, e.g. the
    // `(block (result i32) …)` an inlined call leaves behind). Collect scopes deepest-
    // first so inner simplifications shrink the use-counts the outer scopes see.
    // Use-counts are always whole-function — a set/get pair or dead store is only
    // touched when it's globally the sole occurrence, so per-scope work stays sound.
    const scopes = []
    walkPost(funcNode, n => { if (isScopeNode(n)) scopes.push(n) })

    // One use-count per round, shared by every scope: substitutions only ever
    // *drop* gets, so a stale count can only make a sub-pass act more cautiously
    // (skip a not-yet-provably-dead store, decline a not-yet-provably-single use) —
    // never wrongly. The next round re-counts and mops up. (Recounting per sub-pass
    // per scope is O(scopes·funcSize) and crippling on big modules.)
    for (let round = 0; round < MAX_PROP_ROUNDS; round++) {
      const useCounts = countLocalUses(funcNode)
      let progressed = false
      for (const scope of scopes) {
        if (forwardPropagate(scope, params, useCounts)) progressed = true
        if (eliminateSetGetPairs(scope, params, useCounts)) progressed = true
        if (createLocalTees(scope, params, useCounts)) progressed = true
        if (eliminateDeadStores(scope, params, useCounts)) progressed = true
        if (eliminateAdjacentDeadStores(scope, params)) progressed = true
      }
      if (!progressed) break
    }
  })

  return ast
}

// ==================== FUNCTION INLINING ====================

/**
 * Inline tiny functions (single expression, no locals, no params or simple params).
 * @param {Array} ast
 * @returns {Array}
 */
const inline = (ast) => {
  if (!Array.isArray(ast) || ast[0] !== 'module') return ast

  // Collect inlinable functions
  const inlinable = new Map() // $name → { body, params }

  for (const node of ast.slice(1)) {
    if (!Array.isArray(node) || node[0] !== 'func') continue

    const name = typeof node[1] === 'string' && node[1][0] === '$' ? node[1] : null
    if (!name) continue

    // Check if function is small enough to inline
    let params = []
    let body = []
    let hasLocals = false
    let hasExport = false

    for (let i = 1; i < node.length; i++) {
      const sub = node[i]
      if (!Array.isArray(sub)) continue
      if (sub[0] === 'param') {
        // Collect param names and types
        if (typeof sub[1] === 'string' && sub[1][0] === '$') {
          params.push({ name: sub[1], type: sub[2] })
        } else {
          // Unnamed params - harder to inline
          params = null
          break
        }
      } else if (sub[0] === 'local') {
        hasLocals = true
      } else if (sub[0] === 'export') {
        hasExport = true
      } else if (sub[0] !== 'result' && sub[0] !== 'type') {
        body.push(sub)
      }
    }

    // Inline: no locals, <= 4 params, single expression body, not exported
    if (params && !hasLocals && !hasExport && params.length <= 4 && body.length === 1) {
      // Check if function mutates any of its params (local.set/tee on param),
      // or contains a control-transfer op (`return`, `return_call`,
      // `return_call_indirect`). Inlining such bodies into a different-typed
      // caller would propagate the transfer to the caller, returning from the
      // wrong function with the wrong type. Lifting the body into a
      // `(block $exit ...)` and rewriting returns to `(br $exit X)` would
      // unlock these — left for a future pass.
      const paramNames = new Set(params.map(p => p.name))
      let mutatesParam = false
      let hasReturn = false
      walk(body[0], (n) => {
        if (!Array.isArray(n)) return
        if ((n[0] === 'local.set' || n[0] === 'local.tee') && paramNames.has(n[1])) {
          mutatesParam = true
        }
        if (n[0] === 'return' || n[0] === 'return_call' || n[0] === 'return_call_indirect') {
          hasReturn = true
        }
      })
      if (!mutatesParam && !hasReturn) {
        inlinable.set(name, { body: body[0], params })
      }
    }
  }

  // Replace calls with inlined body
  if (inlinable.size === 0) return ast

  walkPost(ast, (node) => {
    if (!Array.isArray(node) || node[0] !== 'call') return
    const fname = node[1]
    if (!inlinable.has(fname)) return

    const { body, params } = inlinable.get(fname)
    const args = node.slice(2)

    // Simple case: no params
    if (params.length === 0) {
      return clone(body)
    }

    // Substitute params with args
    const substituted = walkPost(clone(body), (n) => {
      if (!Array.isArray(n) || n[0] !== 'local.get') return
      const local = n[1]
      const paramIdx = params.findIndex(p => p.name === local)
      if (paramIdx !== -1 && args[paramIdx]) {
        return clone(args[paramIdx])
      }
    })

    return substituted
  })

  return ast
}

// ==================== INLINE-ONCE ====================

let inlineUid = 0

/**
 * Inline functions that are called from exactly one place into their lone caller,
 * then delete them. Unlike {@link inline} (which duplicates tiny stateless bodies),
 * this never duplicates code and never inflates: each inlined function drops a
 * function-section entry, a type-section entry (if now unused), and a `call`
 * instruction, paying back only a `block`/`local.set` wrapper. This is what
 * `wasm-opt -Oz` does — collapsing helper chains down to a couple of functions —
 * and it's the bulk of the gap between hand-tuned WASM and naive codegen.
 *
 * A function `$f` qualifies when it is, all of:
 *  • named, with named params and locals (numeric indices can't be safely renamed);
 *  • referenced exactly once across the whole module, by a plain `call` (no
 *    `return_call`, `ref.func`, `elem`, `export`, or `start` reference, and not
 *    recursive);
 *  • single-result or void (a multi-value result can't be modeled as `(block (result …))`);
 *  • free of numeric (depth-relative) branch labels — those would shift under the
 *    extra block nesting — and of `return_call*` in its body.
 *
 * `(call $f a0 a1 …)` becomes
 *   (block $__inlN (result T)?
 *     (local.set $__inlN_p0 a0) (local.set $__inlN_p1 a1) …   ;; args evaluated once, in order
 *     …body, params/locals renamed to $__inlN_*, `return X` → `br $__inlN X`…)
 * and the renamed params+locals are appended to the caller's `local` decls; the
 * body's own block/loop/if labels are renamed too so they can't shadow the caller's.
 * Runs to a fixpoint so helper chains fully collapse.
 *
 * @param {Array} ast
 * @returns {Array}
 */
const inlineOnce = (ast) => {
  if (!Array.isArray(ast) || ast[0] !== 'module') return ast

  const HEAD = new Set(['export', 'type', 'param', 'result', 'local'])
  const bodyStart = (fn) => {
    let i = 2
    while (i < fn.length && (typeof fn[i] === 'string' || (Array.isArray(fn[i]) && HEAD.has(fn[i][0])))) i++
    return i
  }
  const isBranch = op => op === 'br' || op === 'br_if' || op === 'br_table'
  // A subtree we can't lift into a (block …): depth-relative branch labels (shift
  // under added nesting) or tail calls (would escape the wrapping block).
  const unsafe = (n) => {
    if (!Array.isArray(n)) return false
    const op = n[0]
    if (op === 'return_call' || op === 'return_call_indirect' || op === 'return_call_ref') return true
    if (op === 'try' || op === 'try_table' || op === 'delegate' || op === 'rethrow') return true  // exception labels — not handled by the relabeler below
    if (isBranch(op)) for (let i = 1; i < n.length; i++) if (typeof n[i] === 'number' || (typeof n[i] === 'string' && /^\d+$/.test(n[i]))) return true
    for (let i = 1; i < n.length; i++) if (unsafe(n[i])) return true
    return false
  }
  const callsSelf = (n, name) => {
    if (!Array.isArray(n)) return false
    if ((n[0] === 'call' || n[0] === 'return_call') && n[1] === name) return true
    for (let i = 1; i < n.length; i++) if (callsSelf(n[i], name)) return true
    return false
  }
  // Locals must be re-zeroed each time the inlined block is entered IF the
  // callee body actually relies on zero-init — i.e. some path reads the local
  // before any unconditional write. In the original callee they got fresh
  // zero-init per call; after inlining they're outer-func locals, zeroed only
  // at outer entry, so a caller-loop that re-enters the inlined block reads
  // stale values otherwise. Returns null for any type we can't safely
  // zero-init here (skip inlining such callees).
  const zeroFor = (t) => {
    if (t === 'i32') return ['i32.const', 0]
    if (t === 'i64') return ['i64.const', 0n]
    if (t === 'f32') return ['f32.const', 0]
    if (t === 'f64') return ['f64.const', 0]
    if (t === 'v128') return ['v128.const', 'i64x2', 0n, 0n]
    // Nullable ref types (`(ref null …)`, `funcref`, `externref`, `anyref`, etc.)
    // zero-init to `ref.null …` per call; emitting that here would need the exact
    // heap-type. Non-nullable refs aren't zero-init at all (codegen must seed
    // them). Either way, skip — let the call survive.
    return null
  }

  // Locals whose first observed use is a read — or whose first write is inside
  // a conditional branch, where the alternate path bypasses it — depend on
  // zero-init and need a reset when inlined into a caller-loop. Locals that
  // are unconditionally written before any read (the common scratch pattern,
  // e.g. `(local.set $bits (local.get $ptr))` opening a helper) don't, and
  // emitting a spurious reset would only inflate that local's set-count and
  // block downstream propagation/coalescing. Mirrors `coalesceLocals`'
  // `readsZero` heuristic.
  const needsReset = (body, name) => {
    let seen = false, conditional = false, depth = 0
    const visit = (n) => {
      if (seen || !Array.isArray(n)) return
      const op = n[0]
      const isSet = op === 'local.set' || op === 'local.tee'
      if ((isSet || op === 'local.get') && n[1] === name) {
        if (isSet) for (let i = 2; i < n.length && !seen; i++) visit(n[i])
        if (seen) return
        seen = true
        if (op === 'local.get' || depth > 0) conditional = true
        return
      }
      const isIf = op === 'if'
      for (let i = 1; i < n.length && !seen; i++) {
        const c = n[i]
        const cond = isIf && Array.isArray(c) && (c[0] === 'then' || c[0] === 'else')
        if (cond) depth++
        visit(c)
        if (cond) depth--
      }
    }
    for (const n of body) { if (seen) break; visit(n) }
    // If the local is never used (dead), no reset; the dead decl will be pruned.
    if (!seen) return false
    return conditional
  }

  // Module-level references that pin a function (can't be removed/inlined-away).
  const collectPinned = (n, pinned) => {
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === 'export' && Array.isArray(n[2]) && n[2][0] === 'func' && typeof n[2][1] === 'string') pinned.add(n[2][1])
    else if (op === 'start' && typeof n[1] === 'string') pinned.add(n[1])
    else if (op === 'ref.func' && typeof n[1] === 'string') pinned.add(n[1])
    else if (op === 'elem') for (const c of n) if (typeof c === 'string' && c[0] === '$') pinned.add(c)
    for (const c of n) collectPinned(c, pinned)
  }

  for (let round = 0; round < MAX_INLINE_ROUNDS; round++) {
    const funcs = ast.filter(n => Array.isArray(n) && n[0] === 'func')
    const funcByName = new Map()
    for (const n of funcs) if (typeof n[1] === 'string') funcByName.set(n[1], n)

    // Count plain-call references across the WHOLE module (anonymous exported funcs
    // call helpers too); flag any non-call reference (return_call etc.).
    const callRefs = new Map(), otherRef = new Set()
    const countRefs = (n) => {
      if (!Array.isArray(n)) return
      const op = n[0]
      if (op === 'call' && typeof n[1] === 'string') callRefs.set(n[1], (callRefs.get(n[1]) || 0) + 1)
      else if (op === 'return_call' && typeof n[1] === 'string') otherRef.add(n[1])
      for (let i = 1; i < n.length; i++) countRefs(n[i])
    }
    countRefs(ast)
    const pinned = new Set()
    for (const n of ast) if (!Array.isArray(n) || n[0] !== 'func') collectPinned(n, pinned)
    // a func may carry its own (export "name") — the signature scan below rejects those too

    // Pick a callee.
    let calleeName = null
    for (const [name, fn] of funcByName) {
      if (pinned.has(name) || otherRef.has(name)) continue
      if (callRefs.get(name) !== 1) continue
      if (callsSelf(fn, name)) continue
      // named params/locals only (we'll rename them); reject locals with types
      // we can't zero-init on block re-entry.
      let ok = true, nResult = 0
      for (let i = 2; i < fn.length; i++) {
        const c = fn[i]
        if (typeof c === 'string') continue
        if (!Array.isArray(c)) { ok = false; break }
        if (c[0] === 'param' || c[0] === 'local') {
          if (typeof c[1] !== 'string' || c[1][0] !== '$') { ok = false; break }
          if (c[0] === 'local' && !zeroFor(c[2])) { ok = false; break }
        }
        else if (c[0] === 'result') nResult += c.length - 1
        else if (c[0] === 'export') { ok = false; break }
        else if (c[0] === 'type') continue
        else break
      }
      if (!ok || nResult > 1) continue
      let bad = false
      for (let i = bodyStart(fn); i < fn.length; i++) if (unsafe(fn[i])) { bad = true; break }
      if (bad) continue
      calleeName = name; break
    }
    if (!calleeName) break

    const callee = funcByName.get(calleeName)
    const params = [], locals = []
    let inlResult = null
    for (let i = 2; i < callee.length; i++) {
      const c = callee[i]
      if (typeof c === 'string' || !Array.isArray(c)) continue
      if (c[0] === 'param') params.push({ name: c[1], type: c[2] })
      else if (c[0] === 'result') { if (c.length > 1) inlResult = c[1] }
      else if (c[0] === 'local') locals.push({ name: c[1], type: c[2] })
      else if (c[0] === 'export' || c[0] === 'type') continue
      else break
    }
    const cBody = callee.slice(bodyStart(callee))

    const uid = ++inlineUid
    const exit = `$__inl${uid}`
    const rename = new Map()
    for (const p of params) rename.set(p.name, `$__inl${uid}_${p.name.slice(1)}`)
    for (const l of locals) rename.set(l.name, `$__inl${uid}_${l.name.slice(1)}`)
    // The callee's own block/loop/if labels would shadow same-named labels in the
    // caller after nesting (and break depth resolution) — give them fresh names too.
    const labelRename = new Map()
    const collectLabels = (n) => {
      if (!Array.isArray(n)) return
      if (isBranchScope(n[0]) && typeof n[1] === 'string' && n[1][0] === '$' && !labelRename.has(n[1]))
        labelRename.set(n[1], `$__inl${uid}L_${n[1].slice(1)}`)
      for (let i = 1; i < n.length; i++) collectLabels(n[i])
    }
    for (const n of cBody) collectLabels(n)
    const sub = (n) => {
      if (!Array.isArray(n)) return n
      const op = n[0]
      if ((op === 'local.get' || op === 'local.set' || op === 'local.tee') && typeof n[1] === 'string' && rename.has(n[1]))
        return [op, rename.get(n[1]), ...n.slice(2).map(sub)]
      if (op === 'return') return ['br', exit, ...n.slice(1).map(sub)]
      if (isBranchScope(op) && typeof n[1] === 'string' && labelRename.has(n[1]))
        return [op, labelRename.get(n[1]), ...n.slice(2).map(sub)]
      if (isBranch(op)) return [op, ...n.slice(1).map(c => (typeof c === 'string' && labelRename.has(c)) ? labelRename.get(c) : sub(c))]
      return n.map((c, i) => i === 0 ? c : sub(c))
    }

    // Splice into the (unique) caller (which may be an anonymous exported func).
    let done = false
    for (const fn of funcs) {
      if (fn === callee || done) continue
      const start = bodyStart(fn)
      for (let i = start; i < fn.length; i++) {
        const replaced = walkPost(fn[i], (n) => {
          if (done || !Array.isArray(n) || n[0] !== 'call' || n[1] !== calleeName) return
          const args = n.slice(2)
          if (args.length !== params.length) return  // arity mismatch — leave it
          const setup = params.map((p, k) => ['local.set', rename.get(p.name), args[k]])
          // Re-zero only the callee locals that actually depend on the per-call
          // zero-init (read-before-write, or first-write inside a conditional
          // branch). Unconditionally-written-before-read scratch locals don't
          // need a reset, and emitting one inflates their set-count enough to
          // break propagation/coalescing of the helper that follows.
          const resets = locals
            .filter(l => needsReset(cBody, l.name))
            .map(l => ['local.set', rename.get(l.name), zeroFor(l.type)])
          const inner = cBody.map(sub)
          done = true
          return inlResult
            ? ['block', exit, ['result', inlResult], ...setup, ...resets, ...inner]
            : ['block', exit, ...setup, ...resets, ...inner]
        })
        if (replaced !== fn[i]) fn[i] = replaced
        if (done) {
          const decls = [...params, ...locals].map(p => ['local', rename.get(p.name), p.type])
          if (decls.length) fn.splice(bodyStart(fn), 0, ...decls)
          break
        }
      }
      if (done) break
    }
    if (!done) break  // call site not found inside a func body — give up

    const idx = ast.indexOf(callee)
    if (idx >= 0) ast.splice(idx, 1)
  }

  return ast
}

// ==================== MERGE BLOCKS ====================

/**
 * Does `body` contain a branch instruction targeting `label`, ignoring inner
 * blocks/loops that re-bind the same label?
 */
const targetsLabel = (body, label) => {
  let found = false
  const search = (n, shadowed) => {
    if (found || !Array.isArray(n)) return
    const op = n[0]
    let inner = shadowed
    if ((op === 'block' || op === 'loop') && typeof n[1] === 'string' && n[1] === label) inner = true
    if (!shadowed) {
      if (op === 'br' || op === 'br_if' || op === 'br_on_null' || op === 'br_on_non_null' ||
          op === 'br_on_cast' || op === 'br_on_cast_fail') {
        if (n[1] === label) { found = true; return }
      } else if (op === 'br_table') {
        for (let j = 1; j < n.length; j++) {
          if (typeof n[j] === 'string') { if (n[j] === label) { found = true; return } }
          else break
        }
      } else if (op === 'catch' || op === 'catch_ref') {
        // `try_table` catch clause `(catch $tag $label)` / `(catch_ref $tag $label)`
        // branches to an enclosing block label just like `br` does.
        if (n[2] === label) { found = true; return }
      } else if (op === 'catch_all' || op === 'catch_all_ref') {
        // `(catch_all $label)` / `(catch_all_ref $label)`
        if (n[1] === label) { found = true; return }
      }
    }
    for (let i = 1; i < n.length; i++) search(n[i], inner)
  }
  for (const node of body) search(node, false)
  return found
}

/**
 * Unwrap redundant blocks whose label is never targeted. The block's stack
 * effect is determined entirely by its body, so removing the `block`/`end`
 * framing is sound as long as no `br` reaches into the block from inside.
 *
 * Three complementary patterns:
 *
 * 1. **Block at scope level** (sibling in `func`/`block`/`loop`/`then`/`else`):
 *    splice body into the parent scope. Works for untyped, `(result T)`-typed,
 *    or even `(param …)`-typed blocks — in all cases the body produces the
 *    same net stack effect as the framed block did, at the same position.
 * 2. **Result-typed block in expression position** (`(block (result T) expr)`
 *    as the value of some operand): collapse to `expr` if the body is a
 *    single value expression. Catches the wrappers jz codegen leaves around
 *    arena allocations once `propagate` has folded the intermediate
 *    set/get pairs to a single call.
 * 3. **Result-typed block as the sole operand of a void consumer** at scope:
 *    `(local.set $x (block (result T) stmt* expr))` → splice `stmt*` into
 *    the parent scope and rewrite the consumer to `(local.set $x expr)`.
 *    Same shape for `global.set` and `drop`. Cleans up the multi-stmt
 *    wrappers `inlineOnce` leaves when inlining helpers whose return value
 *    is fed into a single set/drop.
 *
 * Pattern 2 runs first (post-order) so patterns 1+3 see cleaned-up parents.
 * @param {Array} ast
 * @returns {Array}
 */
const mergeBlocks = (ast) => {
  walkPost(ast, (node) => {
    if (!Array.isArray(node) || node[0] !== 'block') return
    let bi = 1, label = null
    if (typeof node[1] === 'string' && node[1][0] === '$') { label = node[1]; bi = 2 }
    let hasResult = false
    while (bi < node.length) {
      const c = node[bi]
      if (Array.isArray(c) && (c[0] === 'param' || c[0] === 'type')) { bi++; continue }
      if (Array.isArray(c) && c[0] === 'result') { hasResult = true; bi++; continue }
      break
    }
    const body = node.slice(bi)
    if (!hasResult || body.length !== 1) return
    const only = body[0]
    if (!Array.isArray(only)) return
    if (label && targetsLabel(body, label)) return
    node.length = 0
    for (const tok of only) node.push(tok)
  })

  walk(ast, (node) => {
    if (!isScopeNode(node)) return
    let i = 1
    while (i < node.length) {
      const child = node[i]
      if (!Array.isArray(child)) { i++; continue }

      // Pattern 3: void-consumer wrapping a result-typed block at scope level.
      //   (local.set $x (block $L (result T) stmt* expr))   →   stmt* (local.set $x expr)
      // Same logic for `global.set` and `drop`. The block's body produces a
      // single value at the end; the leading stmts run for side-effect and
      // can move into the parent scope unchanged. Label must be unreferenced
      // (an inner `br $L value` would skip later stmts after splicing).
      // Catches the (block (result T) … (local.get $tmp)) wrappers inlineOnce
      // leaves around inlined helper bodies.
      {
        const cop = child[0]
        const oi = (cop === 'local.set' || cop === 'global.set') ? 2
                 : cop === 'drop' ? 1 : -1
        if (oi >= 0 && child.length === oi + 1) {
          const operand = child[oi]
          if (Array.isArray(operand) && operand[0] === 'block') {
            let bi = 1, label = null
            if (typeof operand[1] === 'string' && operand[1][0] === '$') { label = operand[1]; bi = 2 }
            let hasResult = false
            while (bi < operand.length) {
              const c = operand[bi]
              if (Array.isArray(c) && (c[0] === 'param' || c[0] === 'type')) { bi++; continue }
              if (Array.isArray(c) && c[0] === 'result') { hasResult = true; bi++; continue }
              break
            }
            const body = hasResult ? operand.slice(bi) : null
            if (body && body.length >= 2 && !(label && targetsLabel(body, label))) {
              const expr = body[body.length - 1]
              const setup = body.slice(0, -1)
              child[oi] = expr
              node.splice(i, 1, ...setup, child)
              continue  // re-examine position i (now setup[0]) — may itself be a splice candidate
            }
          }
        }
      }

      if (child[0] !== 'block') { i++; continue }
      let bi = 1, label = null
      if (typeof child[1] === 'string' && child[1][0] === '$') { label = child[1]; bi = 2 }
      // Skip leading typing annotations; they describe the block's stack effect,
      // which the body already produces verbatim, so they're discarded on splice.
      while (bi < child.length) {
        const c = child[bi]
        if (Array.isArray(c) && (c[0] === 'param' || c[0] === 'result' || c[0] === 'type')) { bi++; continue }
        break
      }
      const body = child.slice(bi)
      if (label && targetsLabel(body, label)) { i++; continue }
      node.splice(i, 1, ...body)
      i += body.length
    }
  })
  return ast
}

// ==================== COALESCE LOCALS ====================

/**
 * Share local slots between same-type locals with non-overlapping live ranges.
 * Live range = [first pos, last pos] of any local.get/set/tee, extended over
 * any loop containing a reference (so a value read across loop iterations stays
 * intact). Greedy slot assignment by start position. Params and unnamed/numeric
 * references are left alone; `localReuse` later removes the renamed-away decls.
 *
 * Soundness: WASM zero-initializes locals at function entry, so a local whose
 * first reference (in walk order) is a `local.get` *relies* on that implicit
 * zero — coalescing it into a slot whose previous user left a non-zero residue
 * would silently change behavior (e.g. a `for (let i=0; …)` loop counter
 * inheriting `N*4` from a sibling temp). Such "read-first" locals can still
 * serve as a slot's *primary* (the slot then keeps the function's zero start),
 * but can never be a donor merged into an existing slot.
 * @param {Array} ast
 * @returns {Array}
 */
const coalesceLocals = (ast) => {
  walk(ast, (funcNode) => {
    if (!Array.isArray(funcNode) || funcNode[0] !== 'func') return

    const decls = new Map()
    for (const sub of funcNode) {
      if (Array.isArray(sub) && sub[0] === 'local' &&
          typeof sub[1] === 'string' && sub[1][0] === '$' && typeof sub[2] === 'string') {
        decls.set(sub[1], sub[2])
      }
    }
    if (decls.size < 2) return

    const uses = new Map()
    const loopStack = []
    let pos = 0, abort = false, condDepth = 0

    const visit = (n) => {
      if (abort || !Array.isArray(n)) return
      const op = n[0]
      const isLoop = op === 'loop'
      if (isLoop) loopStack.push({ start: pos, end: pos })
      const isSet = op === 'local.set' || op === 'local.tee'

      if (isSet || op === 'local.get') {
        const name = n[1]
        if (typeof name !== 'string' || name[0] !== '$') { abort = true; return }
        // Execution order: evaluate set/tee value BEFORE recording the write,
        // so a `(local.set $x (… (local.get $x) …))` is correctly seen as a
        // read-then-write of $x (firstOp = local.get).
        if (isSet) for (let i = 2; i < n.length; i++) visit(n[i])
        const here = pos++
        if (decls.has(name)) {
          let u = uses.get(name)
          if (!u) { u = { start: here, end: here, firstOp: op, firstCond: condDepth > 0, loops: new Set() }; uses.set(name, u) }
          if (here > u.end) u.end = here
          for (const ls of loopStack) u.loops.add(ls)
        }
      } else {
        pos++
        const isIf = op === 'if'
        for (let i = 1; i < n.length; i++) {
          const c = n[i]
          const cond = isIf && Array.isArray(c) && (c[0] === 'then' || c[0] === 'else')
          if (cond) condDepth++
          visit(c)
          if (cond) condDepth--
        }
      }

      if (isLoop) { const ls = loopStack.pop(); ls.end = pos }
    }
    visit(funcNode)
    if (abort) return

    // A use inside a loop must stay live for the whole loop — the next
    // iteration could read what this iteration wrote.
    for (const u of uses.values()) {
      for (const ls of u.loops) {
        if (ls.start < u.start) u.start = ls.start
        if (ls.end > u.end) u.end = ls.end
      }
    }

    const ordered = [...uses.entries()].sort((a, b) => a[1].start - b[1].start)
    const rename = new Map()
    const slots = []
    for (const [name, range] of ordered) {
      // Read-first locals depend on the implicit zero; locals first seen inside
      // an if/else branch may be skipped on the alternate path — either way
      // they'd observe a prior slot's residue if reused. They may *start* a
      // fresh slot (the function's zero init), but never *join* one.
      const readsZero = range.firstOp === 'local.get' || range.firstCond
      const type = decls.get(name)
      const slot = readsZero ? null : slots.find(s => s.type === type && s.end < range.start)
      if (slot) { rename.set(name, slot.primary); if (range.end > slot.end) slot.end = range.end }
      else slots.push({ primary: name, type, end: range.end })
    }
    if (rename.size === 0) return

    walk(funcNode, (n) => {
      if (Array.isArray(n) &&
          (n[0] === 'local.get' || n[0] === 'local.set' || n[0] === 'local.tee') &&
          rename.has(n[1])) {
        n[1] = rename.get(n[1])
      }
    })
  })
  return ast
}

// ==================== VACUUM ====================

/**
 * Remove no-op code: nops, drop of pure expressions, empty branches,
 * and select with identical arms.
 * @param {Array} ast
 * @returns {Array}
 */
const vacuum = (ast) => {
  return walkPost(ast, (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]

    // Remove nop entirely (return array marker; parent or post-pass cleans it)
    if (op === 'nop') return ['nop']

    // (drop PURE) → nop
    if (op === 'drop' && node.length === 2 && isPure(node[1])) {
      return ['nop']
    }

    // (select x x cond) → x — only when cond is PURE. An impure cond may set a
    // local that a later op reads (e.g. an address `local.tee` the matching store
    // reuses); dropping it would leave that local stale. Keep the select otherwise.
    if (op === 'select' && node.length >= 4 && equal(node[1], node[2]) && isPure(node[3])) return node[1]

    if (op === 'if') {
      const { cond, thenBranch, elseBranch } = parseIf(node)
      const thenEmpty = !thenBranch || thenBranch.length <= 1
      const elseEmpty = !elseBranch || elseBranch.length <= 1

      // (if cond () ()) → nop or (drop cond)
      if (thenEmpty && elseEmpty) return isPure(cond) ? ['nop'] : ['drop', cond]

      // (if cond (then X) (else)) → drop the empty else
      if (elseBranch && elseEmpty && !thenEmpty) {
        return node.filter(c => c !== elseBranch)
      }
    }

    // Clean out nops, drop-of-pure sequences, and empty annotations from blocks
    if (isScopeNode(node)) {
      const cleaned = [op]
      for (let i = 1; i < node.length; i++) {
        const child = node[i]
        if (child === 'nop' || (Array.isArray(child) && child[0] === 'nop')) continue
        // Pure expression followed by standalone drop → remove both
        const next = node[i + 1]
        const isDrop = next === 'drop' || (Array.isArray(next) && next[0] === 'drop' && next.length === 1)
        if (Array.isArray(child) && isPure(child) && isDrop) {
          i++ // skip the drop too
          continue
        }
        cleaned.push(child)
      }
      if (cleaned.length !== node.length) return cleaned
    }
  })
}

// ==================== PEEPHOLE ====================

/** Peephole optimizations: simple algebraic identities.
 *  Every rule that DROPS an operand guards on isPure: an impure operand must still
 *  be evaluated for its side effects. The load-bearing case is a typed-array element
 *  store, whose address is a `local.tee` inside the value expression (the element's
 *  own read); dropping that operand (e.g. `(a[i] op a[i]) & 0`) would strand the
 *  store with a stale address — a silent miscompile. When impure, keep the op (it
 *  still yields the same value AND runs the operand). */
const selfFold = (val) => (a, b) => equal(a, b) && isPure(a) ? val : null
const PEEPHOLE = {
  // Self-cancelling / tautological binary ops — drop both (equal) operands.
  'i32.sub': selfFold(['i32.const', 0]),
  'i64.sub': selfFold(['i64.const', 0n]),
  'i32.xor': selfFold(['i32.const', 0]),
  'i64.xor': selfFold(['i64.const', 0n]),
  'i32.eq':  selfFold(['i32.const', 1]),
  'i64.eq':  selfFold(['i32.const', 1]),
  'i32.ne':  selfFold(['i32.const', 0]),
  'i64.ne':  selfFold(['i32.const', 0]),
  'i32.lt_s': selfFold(['i32.const', 0]),
  'i32.lt_u': selfFold(['i32.const', 0]),
  'i32.gt_s': selfFold(['i32.const', 0]),
  'i32.gt_u': selfFold(['i32.const', 0]),
  'i32.le_s': selfFold(['i32.const', 1]),
  'i32.le_u': selfFold(['i32.const', 1]),
  'i32.ge_s': selfFold(['i32.const', 1]),
  'i32.ge_u': selfFold(['i32.const', 1]),
  'i64.lt_s': selfFold(['i32.const', 0]),
  'i64.lt_u': selfFold(['i32.const', 0]),
  'i64.gt_s': selfFold(['i32.const', 0]),
  'i64.gt_u': selfFold(['i32.const', 0]),
  'i64.le_s': selfFold(['i32.const', 1]),
  'i64.le_u': selfFold(['i32.const', 1]),
  'i64.ge_s': selfFold(['i32.const', 1]),
  'i64.ge_u': selfFold(['i32.const', 1]),

  // Zero/all-bits absorption — drops the NON-const operand, so guard its purity.
  'i32.mul': (a, b) => {
    if (getConst(b)?.value === 0 && isPure(a)) return ['i32.const', 0]
    if (getConst(a)?.value === 0 && isPure(b)) return ['i32.const', 0]
    return null
  },
  'i64.mul': (a, b) => {
    if (getConst(b)?.value === 0n && isPure(a)) return ['i64.const', 0n]
    if (getConst(a)?.value === 0n && isPure(b)) return ['i64.const', 0n]
    return null
  },
  'i32.and': (a, b) => {
    if (equal(a, b) && isPure(b)) return a
    if (getConst(b)?.value === 0 && isPure(a)) return ['i32.const', 0]
    if (getConst(a)?.value === 0 && isPure(b)) return ['i32.const', 0]
    return null
  },
  'i64.and': (a, b) => {
    if (equal(a, b) && isPure(b)) return a
    if (getConst(b)?.value === 0n && isPure(a)) return ['i64.const', 0n]
    if (getConst(a)?.value === 0n && isPure(b)) return ['i64.const', 0n]
    return null
  },
  'i32.or': (a, b) => {
    if (equal(a, b) && isPure(b)) return a
    if (getConst(b)?.value === -1 && isPure(a)) return ['i32.const', -1]
    if (getConst(a)?.value === -1 && isPure(b)) return ['i32.const', -1]
    return null
  },
  'i64.or': (a, b) => {
    if (equal(a, b) && isPure(b)) return a
    if (getConst(b)?.value === -1n && isPure(a)) return ['i64.const', -1n]
    if (getConst(a)?.value === -1n && isPure(b)) return ['i64.const', -1n]
    return null
  },

  // (local.set $x (local.get $x)) → nop
  'local.set': (a, b) => Array.isArray(b) && b[0] === 'local.get' && b[1] === a ? ['nop'] : null,
}

/**
 * Apply peephole optimizations.
 * @param {Array} ast
 * @returns {Array}
 */
const peephole = (ast) => {
  return walkPost(ast, (node) => {
    if (!Array.isArray(node) || node.length !== 3) return
    const fn = PEEPHOLE[node[0]]
    if (!fn) return
    const result = fn(node[1], node[2])
    if (result !== null) return result
  })
}

// ==================== GLOBAL CONSTANT PROPAGATION ====================

/** Bytes a signed-LEB128 integer encodes to. */
const slebSize = (v) => {
  let x = typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v) || 0))
  let n = 1
  while (true) {
    const b = x & 0x7fn
    x >>= 7n
    if ((x === 0n && (b & 0x40n) === 0n) || (x === -1n && (b & 0x40n) !== 0n)) return n
    n++
  }
}
/** Encoded byte size of a constant init instruction (opcode + immediate). */
const constInstrSize = (node) => {
  if (!Array.isArray(node)) return 4
  switch (node[0]) {
    case 'i32.const': case 'i64.const': return 1 + slebSize(node[1])
    case 'f32.const': return 5
    case 'f64.const': return 9
    case 'v128.const': return 18
    default: return 4 // ref.null/ref.func/global.get — conservative
  }
}
const GLOBAL_GET_SIZE = 2 // 0x23 opcode + 1-byte globalidx (typical)

/**
 * Replace `global.get` of an immutable, const-initialised global with the
 * constant — but only when it doesn't grow the module. A `global.get` costs
 * ~2 B; an `i32.const 12345` costs 4 B; an `f64.const` costs 9 B. Naively
 * inlining a big constant read from many sites trades a few cheap reads + one
 * global decl for many fat immediates — pure bloat (and the node-count size
 * guard can't see it: same number of AST nodes). So we only propagate a global
 * when `refs·constSize ≤ refs·2 + declSize`; when every read is replaced and
 * the global isn't exported, its now-dead decl is dropped here too.
 * @param {Array} ast
 * @returns {Array}
 */
const globals = (ast) => {
  if (!Array.isArray(ast) || ast[0] !== 'module') return ast

  // Immutable globals with a constant init: name → init node.
  const constGlobals = new Map()
  const exported = new Set() // globals pinned by an export — keep the decl

  for (const node of ast.slice(1)) {
    if (!Array.isArray(node)) continue
    if (node[0] === 'export' && Array.isArray(node[2]) && node[2][0] === 'global' && typeof node[2][1] === 'string') { exported.add(node[2][1]); continue }
    if (node[0] !== 'global') continue
    const name = typeof node[1] === 'string' && node[1][0] === '$' ? node[1] : null
    if (!name) continue
    // (global $g (export "x") …) inline export → pinned
    if (node.some(c => Array.isArray(c) && c[0] === 'export')) exported.add(name)
    const typeSlot = node[2]
    if (Array.isArray(typeSlot) && typeSlot[0] === 'mut') continue       // mutable
    if (Array.isArray(typeSlot) && typeSlot[0] === 'import') continue    // imported
    const init = node[3]
    if (getConst(init)) constGlobals.set(name, init)
  }
  if (constGlobals.size === 0) return ast

  // Drop any global that is ever written (defensive — an immutable global can't
  // be, but a malformed module might) and tally read counts.
  const reads = new Map()
  walk(ast, (n) => {
    if (!Array.isArray(n)) return
    const ref = n[1]
    if (typeof ref !== 'string' || ref[0] !== '$') return
    if (n[0] === 'global.set') constGlobals.delete(ref)
    else if (n[0] === 'global.get') reads.set(ref, (reads.get(ref) || 0) + 1)
  })

  // Keep only globals where propagation is size-neutral or better.
  const propagate = new Set()
  for (const [name, init] of constGlobals) {
    const r = reads.get(name) || 0
    if (r === 0) continue // dead anyway — leave to treeshake
    const cs = constInstrSize(init)
    const declSize = cs + 2 // valtype + mutability byte + init expr + `end`
    const before = r * GLOBAL_GET_SIZE + declSize
    const after = r * cs + (exported.has(name) ? declSize : 0)
    if (after <= before) propagate.add(name)
  }
  if (propagate.size === 0) return ast

  walkPost(ast, (node) => {
    if (!Array.isArray(node) || node[0] !== 'global.get' || node.length !== 2) return
    if (propagate.has(node[1])) return clone(constGlobals.get(node[1]))
  })
  // Their reads are all gone now — remove the decls we're free to remove.
  for (let i = ast.length - 1; i >= 1; i--) {
    const n = ast[i]
    if (Array.isArray(n) && n[0] === 'global' && typeof n[1] === 'string' && propagate.has(n[1]) && !exported.has(n[1])) ast.splice(i, 1)
  }
  return ast
}

// ==================== LOAD/STORE OFFSET FOLDING ====================

/** Match (type.load/store (i32.add ptr (type.const N))) and fold offset */
const offset = (ast) => {
  return walkPost(ast, (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (typeof op !== 'string' || (!op.endsWith('load') && !op.endsWith('store'))) return

    // Memory ops have memarg as first immediate after optional memoryidx, then operands
    // In AST form from parse: (i32.load offset=4 align=8 ptr) or (i32.load ptr)
    // Store: (i32.store offset=4 ptr val) — ptr is second-to-last, val is last
    // Load:  (i32.load offset=4 ptr)      — ptr is last
    const isStore = op.endsWith('store')

    // Find current offset from memparams
    let currentOffset = 0
    let memIdx = null
    let argStart = 1

    // Check for memory index
    if (typeof node[1] === 'string' && (node[1][0] === '$' || !isNaN(node[1]))) {
      memIdx = node[1]
      argStart = 2
    }

    // Check for memparams (offset=, align=)
    while (argStart < node.length && typeof node[argStart] === 'string' &&
           (node[argStart].startsWith('offset=') || node[argStart].startsWith('align='))) {
      if (node[argStart].startsWith('offset=')) {
        currentOffset = +node[argStart].slice(7)
      }
      argStart++
    }

    // Determine pointer index
    const ptrIdx = isStore ? node.length - 2 : node.length - 1
    const valIdx = isStore ? node.length - 1 : -1
    if (ptrIdx < argStart) return

    const ptr = node[ptrIdx]
    if (!Array.isArray(ptr) || ptr[0] !== 'i32.add' || ptr.length !== 3) return

    const a = ptr[1], b = ptr[2]
    const ca = getConst(a), cb = getConst(b)

    let base = null, addend = null
    if (ca && ca.type === 'i32') { addend = ca.value; base = b }
    else if (cb && cb.type === 'i32') { addend = cb.value; base = a }
    if (base === null || addend === null) return

    const newOffset = currentOffset + addend
    const newNode = [op]
    if (memIdx !== null) newNode.push(memIdx)
    newNode.push(`offset=${newOffset}`)
    // Preserve align if present
    let alignParam = null
    for (let i = argStart; i < ptrIdx; i++) {
      if (typeof node[i] === 'string' && node[i].startsWith('align=')) {
        alignParam = node[i]
      }
    }
    if (alignParam) newNode.push(alignParam)
    newNode.push(base)
    if (isStore) newNode.push(node[valIdx])
    return newNode
  })
}

// ==================== REDUNDANT BR REMOVAL ====================

/**
 * Remove br to a block's own label when it is the last instruction.
 * @param {Array} ast
 * @returns {Array}
 */
const unbranch = (ast) => {
  walk(ast, (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    // Loops: `br $loop_label` jumps BACK to loop top (continue), not out.
    // Only `block` allows trailing-br elision because `br $block_label` exits the block.
    if (op !== 'block') return

    // Get the block's label
    let labelIdx = 1
    let label = null
    if (typeof node[1] === 'string' && node[1][0] === '$') {
      label = node[1]
      labelIdx = 2
    }
    if (!label) return

    // Find the last executable instruction (skip result/type annotations)
    let lastIdx = -1
    for (let i = node.length - 1; i >= labelIdx; i--) {
      const child = node[i]
      if (!Array.isArray(child)) {
        if (child !== 'nop' && child !== 'end') lastIdx = i
        continue
      }
      const cop = child[0]
      if (cop === 'param' || cop === 'result' || cop === 'local' || cop === 'type' || cop === 'export') continue
      lastIdx = i
      break
    }
    if (lastIdx < 0) return

    const last = node[lastIdx]
    if (Array.isArray(last) && last[0] === 'br' && last[1] === label) {
      // `(br $L v…)` as a block's last instruction just leaves v… as the block's
      // result — splice the value operand(s) in its place (none → plain removal).
      node.splice(lastIdx, 1, ...last.slice(2))
    }
  })

  return ast
}

// ==================== WHILE-LOOP CANONICALIZATION ====================

/**
 * Collapse the `while`-emit idiom into a single loop.
 *
 *   (block $A
 *     (loop $B
 *       (br_if $A (i32.eqz cond))   ;; exit when cond is false
 *       …body…
 *       (br $B)                      ;; continue
 *     ))
 *
 * becomes
 *
 *   (loop $B
 *     (if cond (then …body… (br $B))))
 *
 * Saves ~3 B per while-loop (drop the outer block framing + the `i32.eqz`,
 * trade `br_if`→`if`). Safe only when:
 *  - the block contains nothing but the loop (plus optional `type` slot),
 *  - block / loop are void (no result),
 *  - $A is never targeted from within body (only the head `br_if` uses it).
 *
 * @param {Array} ast
 * @returns {Array}
 */
const loopify = (ast) => {
  walk(ast, (node) => {
    if (!Array.isArray(node) || node[0] !== 'block') return
    let bi = 1, label = null
    if (typeof node[1] === 'string' && node[1][0] === '$') { label = node[1]; bi = 2 }
    if (!label) return
    while (bi < node.length) {
      const c = node[bi]
      if (Array.isArray(c) && c[0] === 'type') { bi++; continue }
      if (Array.isArray(c) && (c[0] === 'param' || c[0] === 'result')) return // typed → skip
      break
    }
    if (node.length - bi !== 1) return
    const loop = node[bi]
    if (!Array.isArray(loop) || loop[0] !== 'loop') return
    let li = 1, loopLabel = null
    if (typeof loop[1] === 'string' && loop[1][0] === '$') { loopLabel = loop[1]; li = 2 }
    const loopHeader = []
    while (li < loop.length) {
      const c = loop[li]
      if (Array.isArray(c) && c[0] === 'type') { loopHeader.push(c); li++; continue }
      if (Array.isArray(c) && (c[0] === 'param' || c[0] === 'result')) return // typed → skip
      break
    }
    const body = loop.slice(li)
    if (body.length < 2) return
    const head = body[0]
    const tail = body[body.length - 1]
    if (!Array.isArray(head) || head[0] !== 'br_if' || head[1] !== label || head.length !== 3) return
    if (!Array.isArray(tail) || tail[0] !== 'br' || tail[1] !== loopLabel || tail.length !== 2) return
    const inner = body.slice(1, -1)
    if (targetsLabel(inner, label)) return

    // br_if exits when `cond` is non-zero — `if`'s then-arm runs when its
    // condition is non-zero. So the if-condition is the negation. Strip a
    // wrapping `i32.eqz` if present; otherwise wrap.
    let cond = head[2]
    if (Array.isArray(cond) && cond[0] === 'i32.eqz' && cond.length === 2) cond = cond[1]
    else cond = ['i32.eqz', cond]

    const newLoop = ['loop']
    if (loopLabel) newLoop.push(loopLabel)
    for (const h of loopHeader) newLoop.push(h)
    newLoop.push(['if', cond, ['then', ...inner, tail]])

    node.length = 0
    for (const tok of newLoop) node.push(tok)
  })
  return ast
}

// ==================== STRIP MUT FROM GLOBALS ====================

/**
 * Strip mutability from globals that are never written.
 * Enables globals constant-propagation for more globals.
 * @param {Array} ast
 * @returns {Array}
 */
const stripmut = (ast) => {
  if (!Array.isArray(ast) || ast[0] !== 'module') return ast

  const written = new Set()
  walk(ast, (n) => {
    if (Array.isArray(n) && n[0] === 'global.set' && typeof n[1] === 'string') written.add(n[1])
  })

  return walkPost(ast, (node) => {
    if (!Array.isArray(node) || node[0] !== 'global') return
    const name = typeof node[1] === 'string' && node[1][0] === '$' ? node[1] : null
    if (!name || written.has(name)) return

    const hasName = typeof node[1] === 'string' && node[1][0] === '$'
    const typeSlot = hasName ? node[2] : node[1]
    if (Array.isArray(typeSlot) && typeSlot[0] === 'mut') {
      const newNode = [...node]
      newNode[hasName ? 2 : 1] = typeSlot[1] // replace (mut T) with T
      return newNode
    }
  })
}

// ==================== IF-THEN-BR → BR_IF ====================

/**
 * Simplify (if cond (then (br $label))) → (br_if $label cond)
 * and (if cond (then) (else (br $label))) → (br_if $label (i32.eqz cond))
 * Only when the br is the sole instruction in the arm.
 * @param {Array} ast
 * @returns {Array}
 */
const brif = (ast) => {
  return walkPost(ast, (node) => {
    if (!Array.isArray(node) || node[0] !== 'if') return
    const { cond, thenBranch, elseBranch } = parseIf(node)
    const thenEmpty = !thenBranch || thenBranch.length <= 1
    const elseEmpty = !elseBranch || elseBranch.length <= 1

    // (if cond (then (br $l))) → (br_if $l cond)
    if (!thenEmpty && elseEmpty && thenBranch.length === 2) {
      const t = thenBranch[1]
      if (Array.isArray(t) && t[0] === 'br' && t.length === 2) return ['br_if', t[1], cond]
    }

    // (if cond (then) (else (br $l))) → (br_if $l (i32.eqz cond))
    if (thenEmpty && !elseEmpty && elseBranch.length === 2) {
      const e = elseBranch[1]
      if (Array.isArray(e) && e[0] === 'br' && e.length === 2) return ['br_if', e[1], ['i32.eqz', cond]]
    }
  })
}

// ==================== MERGE IDENTICAL IF ARMS ====================

/**
 * Fold identical trailing code out of if/else arms.
 * (if cond (then A X) (else B X)) → (if cond (then A) (else B)) X
 * @param {Array} ast
 * @returns {Array}
 */
const foldarms = (ast) => {
  return walkPost(ast, (node) => {
    if (!Array.isArray(node) || node[0] !== 'if') return
    const { thenBranch, elseBranch } = parseIf(node)
    if (!thenBranch || !elseBranch) return
    if (thenBranch.length <= 1 || elseBranch.length <= 1) return

    // Only fold when the if has an explicit result type.
    // Without a result annotation the branches are void; hoisting a suffix
    // like `drop` can expose a value and leave the if branches ill-typed.
    const hasResult = node.some(c => Array.isArray(c) && c[0] === 'result')
    if (!hasResult) return

    let common = 0
    const minLen = Math.min(thenBranch.length, elseBranch.length)
    for (let i = 1; i < minLen; i++) {
      if (!equal(thenBranch[thenBranch.length - i], elseBranch[elseBranch.length - i])) break
      common++
    }
    if (common === 0) return

    const hoisted = thenBranch.slice(thenBranch.length - common)
    const newThen = thenBranch.slice(0, thenBranch.length - common)
    const newElse = elseBranch.slice(0, elseBranch.length - common)

    const block = ['block']
    for (let i = 1; i < node.length; i++) {
      const c = node[i]
      if (Array.isArray(c) && (c[0] === 'then' || c[0] === 'else')) break
      if (Array.isArray(c) && (c[0] === 'result' || c[0] === 'type')) block.push(c)
    }

    // Inner if becomes void: the result/type annotation now lives on the outer block,
    // since the value-producing trailing instructions have moved there. Without
    // stripping, the inner (if (result f64)) claims to produce f64 from branches
    // whose trailing value-producing instructions just got hoisted out — invalid.
    const newIf = ['if']
    for (let i = 1; i < node.length; i++) {
      const c = node[i]
      if (Array.isArray(c) && (c[0] === 'then' || c[0] === 'else')) break
      if (Array.isArray(c) && (c[0] === 'result' || c[0] === 'type')) continue
      newIf.push(c)
    }
    newIf.push(newThen.length > 1 ? newThen : ['then'])
    newIf.push(newElse.length > 1 ? newElse : ['else'])

    block.push(newIf, ...hoisted)
    return block
  })
}

// ==================== DUPLICATE FUNCTION ELIMINATION ====================

/**
 * Fast structural hash for a function node, normalizing local names.
 * Uses a stack-based walk to avoid expensive JSON.stringify.
 */
const hashFunc = (node, localNames) => {
  const parts = []
  const stack = [node]
  while (stack.length) {
    const v = stack.pop()
    if (Array.isArray(v)) {
      stack.push('|')
      for (let i = v.length - 1; i >= 0; i--) stack.push(v[i])
      stack.push('[')
    } else if (typeof v === 'string') {
      parts.push(localNames.has(v) ? '$__L' : v)
    } else if (typeof v === 'bigint') {
      parts.push(v.toString() + 'n')
    } else if (typeof v === 'number') {
      parts.push(v.toString())
    } else if (v === null) {
      parts.push('null')
    } else if (v === true) {
      parts.push('t')
    } else if (v === false) {
      parts.push('f')
    } else {
      parts.push(String(v))
    }
  }
  return parts.join(',')
}

/**
 * Eliminate duplicate functions by hashing bodies.
 * Keeps the first occurrence and redirects all references to it.
 * @param {Array} ast
 * @returns {Array}
 */
const dedupe = (ast) => {
  if (!Array.isArray(ast) || ast[0] !== 'module') return ast

  // Hash function bodies (normalize local/param names to avoid false negatives)
  const signatures = new Map() // hash → canonical $name
  const redirects = new Map()  // duplicate $name → canonical $name

  for (const node of ast.slice(1)) {
    if (!Array.isArray(node) || node[0] !== 'func') continue
    const name = typeof node[1] === 'string' && node[1][0] === '$' ? node[1] : null
    if (!name) continue

    // Collect names that are internal to this function: the func name itself,
    // its params, locals, and any block/loop labels nested in the body. All of
    // these get normalized to a single token in the hash so that two funcs
    // differing only in identifier choices still dedupe.
    const localNames = new Set()
    if (typeof node[1] === 'string' && node[1][0] === '$') localNames.add(node[1])
    walk(node, (n) => {
      if (!Array.isArray(n) || typeof n[1] !== 'string' || n[1][0] !== '$') return
      const op = n[0]
      if (op === 'param' || op === 'local' || isBranchScope(op)) {
        localNames.add(n[1])
      }
    })

    const hash = hashFunc(node, localNames)

    if (signatures.has(hash)) {
      redirects.set(name, signatures.get(hash))
    } else {
      signatures.set(hash, name)
    }
  }

  if (redirects.size === 0) return ast

  // Rewrite all references: calls, ref.func, elem segments, call_indirect type
  walkPost(ast, (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if ((op === 'call' || op === 'return_call') && redirects.has(node[1])) {
      return [op, redirects.get(node[1]), ...node.slice(2)]
    }
    if (op === 'ref.func' && redirects.has(node[1])) {
      return ['ref.func', redirects.get(node[1])]
    }
    if (op === 'elem') {
      const funcs = node[node.length - 1]
      if (Array.isArray(funcs)) {
        return [...node.slice(0, -1), funcs.map(f => redirects.get(f) || f)]
      }
    }
    if (op === 'call_indirect' && node.length >= 3) {
      const typeRef = node[1]
      if (typeof typeRef === 'string' && redirects.has(typeRef)) {
        return ['call_indirect', redirects.get(typeRef), ...node.slice(2)]
      }
    }
  })

  return ast
}

// ==================== TYPE DEDUPLICATION ====================

/**
 * Merge structurally identical (type ...) definitions.
 * Keeps the first occurrence and redirects all references.
 * @param {Array} ast
 * @returns {Array}
 */
const dedupTypes = (ast) => {
  if (!Array.isArray(ast) || ast[0] !== 'module') return ast

  const signatures = new Map() // hash → canonical $name
  const redirects = new Map()  // duplicate $name → canonical $name

  for (const node of ast.slice(1)) {
    if (!Array.isArray(node) || node[0] !== 'type') continue
    const name = typeof node[1] === 'string' && node[1][0] === '$' ? node[1] : null
    if (!name) continue

    // Hash the type body, normalizing only the type's own name
    const hash = hashFunc(node, new Set([name]))

    if (signatures.has(hash)) {
      redirects.set(name, signatures.get(hash))
    } else {
      signatures.set(hash, name)
    }
  }

  if (redirects.size === 0) return ast

  // Remove duplicate type nodes
  for (let i = ast.length - 1; i >= 0; i--) {
    const node = ast[i]
    if (Array.isArray(node) && node[0] === 'type') {
      const name = typeof node[1] === 'string' && node[1][0] === '$' ? node[1] : null
      if (name && redirects.has(name)) ast.splice(i, 1)
    }
  }

  walkPost(ast, (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]

    // (func $f (type $t) ...)
    if (op === 'func') {
      for (let i = 1; i < node.length; i++) {
        const sub = node[i]
        if (Array.isArray(sub) && sub[0] === 'type' && typeof sub[1] === 'string' && redirects.has(sub[1])) {
          node[i] = ['type', redirects.get(sub[1])]
        }
      }
    }

    // (import "m" "n" (func (type $t)))
    if (op === 'import') {
      for (let i = 1; i < node.length; i++) {
        const sub = node[i]
        if (Array.isArray(sub)) {
          for (let j = 1; j < sub.length; j++) {
            const inner = sub[j]
            if (Array.isArray(inner) && inner[0] === 'type' && typeof inner[1] === 'string' && redirects.has(inner[1])) {
              sub[j] = ['type', redirects.get(inner[1])]
            }
          }
        }
      }
    }

    // call_indirect $t  or  (call_indirect (type $t) ...)
    if (op === 'call_indirect' || op === 'return_call_indirect') {
      if (typeof node[1] === 'string' && redirects.has(node[1])) {
        return [op, redirects.get(node[1]), ...node.slice(2)]
      }
      if (Array.isArray(node[1]) && node[1][0] === 'type' && typeof node[1][1] === 'string' && redirects.has(node[1][1])) {
        return [op, ['type', redirects.get(node[1][1])], ...node.slice(2)]
      }
    }
  })

  return ast
}

// ==================== DATA SEGMENT PACKING ====================

/** Parse a WAT data string literal into Uint8Array */
const parseDataString = (str) => {
  if (typeof str !== 'string' || str.length < 2 || str[0] !== '"') return new Uint8Array()
  const inner = str.slice(1, -1)
  const bytes = []
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\') {
      const next = inner[++i]
      if (next === 'x' || next === 'X') {
        bytes.push(parseInt(inner.slice(i + 1, i + 3), 16))
        i += 2
      } else if (/[0-9a-fA-F]/.test(next) && /[0-9a-fA-F]/.test(inner[i + 1])) {
        bytes.push(parseInt(inner.slice(i, i + 2), 16))
        i++
      } else if (next === 'n') bytes.push(10)
      else if (next === 't') bytes.push(9)
      else if (next === 'r') bytes.push(13)
      else if (next === '\\') bytes.push(92)
      else if (next === '"') bytes.push(34)
      else bytes.push(next.charCodeAt(0))
    } else {
      bytes.push(inner.charCodeAt(i))
    }
  }
  return new Uint8Array(bytes)
}

/** Encode Uint8Array as WAT data string literal */
const encodeDataString = (bytes) => {
  let str = '"'
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    if (b >= 32 && b < 127 && b !== 34 && b !== 92) {
      str += String.fromCharCode(b)
    } else {
      str += '\\' + b.toString(16).padStart(2, '0')
    }
  }
  return str + '"'
}

/** Trim trailing zeros from data content items.
 *  Assembles via Uint8Array.set (not push(...spread)) — a data segment can be
 *  hundreds of KB, and spreading it as call args overflows V8's argument stack. */
const trimTrailingZeros = (items) => {
  const chunks = []
  let total = 0
  for (const item of items) {
    let chunk
    if (typeof item === 'string') {
      chunk = parseDataString(item)
    } else if (Array.isArray(item) && item[0] === 'i8') {
      chunk = new Uint8Array(item.length - 1)
      for (let i = 1; i < item.length; i++) chunk[i - 1] = Number(item[i]) & 0xff
    } else {
      return items // non-trimmable item
    }
    chunks.push(chunk)
    total += chunk.length
  }
  const bytes = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { bytes.set(c, off); off += c.length }
  let end = bytes.length
  while (end > 0 && bytes[end - 1] === 0) end--
  if (end === bytes.length) return items
  if (end === 0) return []
  return [encodeDataString(bytes.subarray(0, end))]
}

/** Extract { memidx, offset } from an active data segment with constant offset */
const getDataOffset = (node) => {
  let idx = 1
  if (typeof node[idx] === 'string' && node[idx][0] === '$') idx++
  if (Array.isArray(node[idx]) && node[idx][0] === 'memory') {
    const mem = node[idx][1]
    idx++
    const off = node[idx]
    if (Array.isArray(off) && (off[0] === 'i32.const' || off[0] === 'i64.const')) {
      return { memidx: mem, offset: Number(off[1]) }
    }
    return null
  }
  const off = node[idx]
  if (Array.isArray(off) && (off[0] === 'i32.const' || off[0] === 'i64.const')) {
    return { memidx: 0, offset: Number(off[1]) }
  }
  return null
}

/** Get byte length of data segment content */
const getDataLength = (node) => {
  let idx = 1
  if (typeof node[idx] === 'string' && node[idx][0] === '$') idx++
  if (Array.isArray(node[idx]) && node[idx][0] === 'memory') idx++
  if (Array.isArray(node[idx]) && typeof node[idx][0] === 'string' && !node[idx][0].startsWith('"')) idx++
  let len = 0
  for (let i = idx; i < node.length; i++) {
    const item = node[i]
    if (typeof item === 'string') len += parseDataString(item).length
    else if (Array.isArray(item) && item[0] === 'i8') len += item.length - 1
    else return null
  }
  return len
}

/** Merge segment b into a (consecutive offsets, same memory) */
const mergeDataSegments = (a, b) => {
  let aIdx = 1
  if (typeof a[aIdx] === 'string' && a[aIdx][0] === '$') aIdx++
  if (Array.isArray(a[aIdx]) && a[aIdx][0] === 'memory') aIdx++
  if (Array.isArray(a[aIdx]) && typeof a[aIdx][0] === 'string' && !a[aIdx][0].startsWith('"')) aIdx++

  let bIdx = 1
  if (typeof b[bIdx] === 'string' && b[bIdx][0] === '$') bIdx++
  if (Array.isArray(b[bIdx]) && b[bIdx][0] === 'memory') bIdx++
  if (Array.isArray(b[bIdx]) && typeof b[bIdx][0] === 'string' && !b[bIdx][0].startsWith('"')) bIdx++

  const aContent = a.slice(aIdx)
  const bContent = b.slice(bIdx)

  if (aContent.length === 1 && bContent.length === 1 &&
      typeof aContent[0] === 'string' && typeof bContent[0] === 'string') {
    const aBytes = parseDataString(aContent[0])
    const bBytes = parseDataString(bContent[0])
    const merged = new Uint8Array(aBytes.length + bBytes.length)
    merged.set(aBytes)
    merged.set(bBytes, aBytes.length)
    a.length = aIdx
    a.push(encodeDataString(merged))
    return true
  }

  a.length = aIdx
  a.push(...aContent, ...bContent)
  return true
}

/**
 * Pack data segments: trim trailing zeros and merge adjacent constant-offset segments.
 * @param {Array} ast
 * @returns {Array}
 */
const packData = (ast) => {
  if (!Array.isArray(ast) || ast[0] !== 'module') return ast

  // Trim trailing zeros
  for (const node of ast) {
    if (!Array.isArray(node) || node[0] !== 'data') continue
    let contentStart = 1
    if (typeof node[1] === 'string' && node[1][0] === '$') contentStart = 2
    if (contentStart < node.length && Array.isArray(node[contentStart]) &&
        typeof node[contentStart][0] === 'string' && !node[contentStart][0].startsWith('"')) {
      contentStart++
    }
    const content = node.slice(contentStart)
    if (content.length === 0) continue
    const trimmed = trimTrailingZeros(content)
    if (trimmed.length !== content.length || (trimmed.length > 0 && trimmed[0] !== content[0])) {
      node.length = contentStart
      node.push(...trimmed)
    }
  }

  // Merge adjacent active segments with same memory and consecutive offsets
  const dataNodes = []
  for (let i = 0; i < ast.length; i++) {
    const node = ast[i]
    if (Array.isArray(node) && node[0] === 'data') {
      const info = getDataOffset(node)
      if (info) {
        const len = getDataLength(node)
        if (len !== null) dataNodes.push({ ...info, node, index: i, len })
      }
    }
  }

  dataNodes.sort((a, b) => {
    const ma = String(a.memidx), mb = String(b.memidx)
    if (ma !== mb) return ma.localeCompare(mb)
    return a.offset - b.offset
  })

  const toRemove = new Set()
  for (let i = 0; i < dataNodes.length - 1; i++) {
    const a = dataNodes[i]
    const b = dataNodes[i + 1]
    if (toRemove.has(a.index) || String(a.memidx) !== String(b.memidx)) continue
    if (a.offset + a.len !== b.offset) continue
    if (mergeDataSegments(a.node, b.node)) {
      toRemove.add(b.index)
      a.len = getDataLength(a.node)
    }
  }

  if (toRemove.size > 0) {
    ast = ast.filter((_, i) => !toRemove.has(i))
  }

  return ast
}

// ==================== IMPORT FIELD MINIFICATION ====================

/** Create a shortener that maps names to a, b, ..., z, aa, ab, ... */
const makeShortener = () => {
  const map = new Map()
  let n = 0
  return (name) => {
    if (!map.has(name)) {
      let id = '', x = n++
      do {
        id = String.fromCharCode(97 + (x % 26)) + id
        x = Math.floor(x / 26) - 1
      } while (x >= 0)
      map.set(name, id || 'a')
    }
    return map.get(name)
  }
}

/**
 * Minify import module and field names for smaller binaries.
 * Only safe when you control the host environment.
 * @param {Array} ast
 * @returns {Array}
 */
const minifyImports = (ast) => {
  if (!Array.isArray(ast) || ast[0] !== 'module') return ast
  const shortMod = makeShortener()
  const shortField = makeShortener()

  for (const node of ast) {
    if (!Array.isArray(node) || node[0] !== 'import') continue
    if (typeof node[1] === 'string' && node[1][0] === '"') {
      node[1] = '"' + shortMod(node[1].slice(1, -1)) + '"'
    }
    if (typeof node[2] === 'string' && node[2][0] === '"') {
      node[2] = '"' + shortField(node[2].slice(1, -1)) + '"'
    }
  }

  return ast
}

// ==================== REORDER FUNCTIONS ====================

/**
 * Count direct calls and sort functions so hot ones come first.
 * Smaller LEB128 indices for frequent calls reduce binary size.
 * Imports must stay before defined functions to preserve the index space.
 * @param {Array} ast
 * @returns {Array}
 */
/** True iff every defined func has a $name and every func reference is by $name */
const reorderSafe = (ast) => {
  let safe = true
  walk(ast, (n) => {
    if (!safe || !Array.isArray(n)) return
    const op = n[0]
    if (op === 'func' && (typeof n[1] !== 'string' || n[1][0] !== '$')) safe = false
    else if ((op === 'call' || op === 'return_call' || op === 'ref.func') &&
             (typeof n[1] !== 'string' || n[1][0] !== '$')) safe = false
    else if (op === 'start' && (typeof n[1] !== 'string' || n[1][0] !== '$')) safe = false
    else if (op === 'elem') {
      // Numeric func indices in elem segments would break too
      for (const sub of n) {
        if (typeof sub === 'string' && sub[0] !== '$' && /^\d/.test(sub)) { safe = false; break }
        if (Array.isArray(sub) && sub[0] === 'ref.func' &&
            (typeof sub[1] !== 'string' || sub[1][0] !== '$')) { safe = false; break }
      }
    }
  })
  return safe
}

const reorder = (ast) => {
  if (!Array.isArray(ast) || ast[0] !== 'module') return ast
  // Sorting changes the function index space. Skip if any reference is numeric,
  // since we'd silently retarget unnamed callers/start/elem entries.
  if (!reorderSafe(ast)) return ast

  const callCounts = new Map()
  walk(ast, (n) => {
    if (!Array.isArray(n)) return
    if (n[0] === 'call' || n[0] === 'return_call') {
      callCounts.set(n[1], (callCounts.get(n[1]) || 0) + 1)
    }
  })

  // Imports must precede defined funcs (compile.js assigns indices in AST order).
  const imports = [], funcs = [], others = []
  for (const node of ast.slice(1)) {
    if (!Array.isArray(node)) { others.push(node); continue }
    if (node[0] === 'import') imports.push(node)
    else if (node[0] === 'func') funcs.push(node)
    else others.push(node)
  }

  funcs.sort((a, b) => (callCounts.get(b[1]) || 0) - (callCounts.get(a[1]) || 0))
  return ['module', ...imports, ...funcs, ...others]
}

// ==================== MAIN ====================

/**
 * Optimization passes, in the order they run within each round. Each entry is
 * `[optionKey, fn, defaultOn, doc]` — the single source of truth that the
 * dispatch loop, the `OPTS` catalogue, and `normalize` all derive from.
 * Passes that are off by default can bloat output or are expensive — opt-in.
 */
const PASSES = [
  ['stripmut',      stripmut,       true,  'strip mut from never-written globals'],
  ['globals',       globals,        true,  'propagate immutable global constants'],
  ['guardRefine',   guardRefine,    true,  'fold NaN-box tag reads under dominating tag guards'],
  ['fold',          fold,           true,  'constant folding'],
  ['identity',      identity,       true,  'remove identity ops (x + 0 → x)'],
  ['peephole',      peephole,       true,  'x-x→0, x&0→0, etc.'],
  ['strength',      strength,       true,  'strength reduction (x * 2 → x << 1)'],
  ['branch',        branch,         true,  'simplify constant branches'],
  ['propagate',     propagate,      true,  'forward-propagate single-use locals & tiny consts (never inflates)'],
  ['inlineOnce',    inlineOnce,     true,  'inline single-call functions into their lone caller (never duplicates)'],
  ['inline',        inline,         false, 'inline tiny functions — can duplicate bodies'],
  ['offset',        offset,         true,  'fold add+const into load/store offset'],
  ['unbranch',      unbranch,       true,  'remove redundant br at end of own block'],
  ['loopify',       loopify,        true,  'collapse block+loop+brif while-idiom into loop+if'],
  ['brif',          brif,           true,  'if-then-br → br_if'],
  ['foldarms',      foldarms,       false, 'merge identical trailing if arms — can add block wrapper'],
  ['deadcode',      deadcode,       true,  'eliminate dead code after unreachable/br/return'],
  ['vacuum',        vacuum,         true,  'remove nops, drop-of-pure, empty branches'],
  ['mergeBlocks',   mergeBlocks,    true,  'unwrap `(block $L …)` whose label is never targeted'],
  ['coalesce',      coalesceLocals, true,  'share local slots between same-type non-overlapping locals'],
  ['locals',        localReuse,     true,  'remove unused locals'],
  ['dedupe',        dedupe,         true,  'eliminate duplicate functions'],
  ['dedupTypes',    dedupTypes,     true,  'merge identical type definitions'],
  ['packData',      packData,       true,  'trim trailing zeros, merge adjacent data segments'],
  ['reorder',       reorder,        false, 'put hot functions first — no AST reduction'],
  ['treeshake',     treeshake,      true,  'remove unused funcs/globals/types/tables'],
  ['minifyImports', minifyImports,  false, 'shorten import names — enable only when you control the host'],
]

/** Option name → default-on map — the public catalogue of passes. */
const OPTS = Object.fromEntries(PASSES.map(p => [p[0], p[2]]))

/**
 * Normalize options to a { passName: bool } map. An explicit object is kept
 * as-is (preserving `log`/`verbose`), with any unmentioned pass filled to its
 * default; `true` selects the defaults; a string selects only the named
 * passes (or all of them via `'all'`).
 *
 * @param {boolean|string|Object} opts
 * @returns {Object}
 */
const normalize = (opts) => {
  if (opts === false) return {}
  if (opts !== true && typeof opts !== 'string') {
    const m = { ...opts }
    for (const p of PASSES) if (m[p[0]] === undefined) m[p[0]] = p[2]
    return m
  }
  const set = typeof opts === 'string' ? new Set(opts.split(/\s+/).filter(Boolean)) : null
  const m = {}
  for (const p of PASSES) m[p[0]] = set ? (set.has('all') || set.has(p[0])) : p[2]
  return m
}

/**
 * Optimize AST.
 *
 * @param {Array|string} ast - AST or WAT source
 * @param {boolean|string|Object} [opts=true] - Optimization options
 * @returns {Array} Optimized AST
 *
 * @example
 * optimize(ast)                      // all optimizations
 * optimize(ast, 'treeshake')         // only treeshake
 * optimize(ast, { fold: true })      // explicit
 */
/**
 * Could `inlineOnce`/`inline` grow the binary on this module? They are the only
 * size-*increasing* passes: splicing a callee body plus its `block`/param-setup
 * wrapper can exceed the `call` it removes. Every other pass strictly shrinks or
 * holds. So if no function is even a candidate (called exactly once, not pinned
 * by export/start/elem/ref.func, not its own exporter), nothing can inflate and
 * the size guard is dead weight. Cheap over-approximation of inlineOnce's own
 * gating — a false positive only costs the guarded path (correct, just slower).
 */
const mayInline = (ast) => {
  if (!Array.isArray(ast)) return false
  const callRefs = new Map(), pinned = new Set(), other = new Set()
  const scan = (n) => {
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === 'call' && typeof n[1] === 'string') callRefs.set(n[1], (callRefs.get(n[1]) || 0) + 1)
    else if (op === 'return_call' && typeof n[1] === 'string') other.add(n[1])
    else if (op === 'ref.func' && typeof n[1] === 'string') pinned.add(n[1])
    else if (op === 'export' && Array.isArray(n[2]) && n[2][0] === 'func' && typeof n[2][1] === 'string') pinned.add(n[2][1])
    else if (op === 'start' && typeof n[1] === 'string') pinned.add(n[1])
    else if (op === 'elem') for (const c of n) if (typeof c === 'string' && c[0] === '$') pinned.add(c)
    for (let i = 1; i < n.length; i++) scan(n[i])
  }
  scan(ast)
  for (const n of ast) {
    if (!Array.isArray(n) || n[0] !== 'func' || typeof n[1] !== 'string') continue
    const name = n[1]
    if (callRefs.get(name) !== 1 || pinned.has(name) || other.has(name)) continue
    if (n.some(c => Array.isArray(c) && c[0] === 'export')) continue // self-exporting func
    return true
  }
  return false
}

export default function optimize(ast, opts = true) {
  const strictGuard = opts === true  // default: zero tolerance for bloat
  opts = normalize(opts)

  const log = opts.log ? (msg, delta) => opts.log(msg, delta) : () => {}
  const verbose = opts.verbose || opts.log

  ast = clone(ast)

  // Fast path: jz owns this optimizer and feeds it a controlled, type-aware IR.
  // The only passes that can *grow* the binary are inlineOnce/inline; when no
  // function is an inline candidate (the common case for scalar REPL kernels)
  // nothing can inflate, so we skip watr's per-round `binarySize` re-compile
  // guard — up to four full encodes per call — and iterate to a fixpoint with
  // zero compiles. A round that changes nothing is the natural exit.
  if (!((opts.inlineOnce || opts.inline) && mayInline(ast))) {
    // inlineOnce/inline can't fire here, so skip them — their candidate scan
    // (a 16-round whole-module walk) is the second-costliest thing after
    // propagate, and it would only confirm what `mayInline` already proved.
    for (let round = 0; round < 3; round++) {
      const beforeRound = clone(ast)
      for (const [key, fn] of PASSES) if (opts[key] && key !== 'inlineOnce' && key !== 'inline') ast = fn(ast)
      if (equal(beforeRound, ast)) break // fixpoint
      if (verbose) log(`  round ${round + 1} applied`)
    }
    return ast
  }

  // Guarded path: inlining can inflate (a body bigger than the call it replaces),
  // so score each round on encoded bytes and revert any that grows the binary.
  // `binarySize` returns Infinity for invalid wat, so a broken round reverts too.
  // A round's starting size equals the prior round's ending size, so carry it
  // forward and compile once per round.
  let beforeRound = null
  let sizeBefore = binarySize(ast)
  for (let round = 0; round < 3; round++) {
    beforeRound = clone(ast)

    for (const [key, fn] of PASSES) if (opts[key]) ast = fn(ast)
    // Second propagate sweep: `inlineOnce`/`inline` (above) leave fresh
    // `(local.set $p arg) … (local.get $p)` wrappers around each inlined call;
    // re-running propagation collapses them within this same round, so the size
    // guard scores the cleaned result.
    if (opts.propagate && (opts.inlineOnce || opts.inline)) ast = propagate(ast)

    // A round that changed nothing can't have inflated — check convergence
    // before compiling so the fixpoint-confirming round costs zero compiles.
    if (equal(beforeRound, ast)) break

    const sizeAfter = binarySize(ast)
    const delta = sizeAfter - sizeBefore
    if (verbose || delta !== 0) log(`  round ${round + 1}: ${delta > 0 ? '+' : ''}${delta} bytes`, delta)

    // Default optimize must never inflate; explicit passes get slight leniency.
    const tolerance = strictGuard ? 0 : 16
    if (delta > tolerance) {
      if (verbose) log(`  ⚠ round ${round + 1} inflated by ${delta} bytes, reverting`, delta)
      ast = beforeRound
      break
    }
    sizeBefore = sizeAfter
  }

  return ast
}

/** Count AST nodes (fast size heuristic). */
export { count as size, count, binarySize }
export { optimize, treeshake, fold, deadcode, localReuse, identity, strength, branch, propagate, inline, inlineOnce, normalize, OPTS, vacuum, peephole, globals, offset, unbranch, loopify, stripmut, brif, foldarms, dedupe, reorder, dedupTypes, packData, minifyImports, mergeBlocks, coalesceLocals }
