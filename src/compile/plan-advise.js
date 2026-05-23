import { ctx, warn } from '../ctx.js'
import { refsName, REFS_IN_EXPR } from '../ast.js'
import { intLiteralValue } from '../static.js'
import { VAL } from '../reps.js'
import { adviseJsstringCarrier } from './narrow.js'

/** Compile-time advisories — heap growth, Map iteration order, SIMD hints. */
const HEAP_LOOP_OPS = new Set(['for', 'for-in', 'for-of', 'while', 'do', 'do-while'])
const HEAP_VALS = new Set([
  VAL.ARRAY, VAL.STRING, VAL.OBJECT, VAL.HASH, VAL.SET, VAL.MAP,
  VAL.CLOSURE, VAL.TYPED, VAL.REGEX, VAL.BUFFER,
])

function returnsHeap(func) {
  if (func.sig.ptrKind != null) return true
  return func.valResult != null && HEAP_VALS.has(func.valResult)
}

function isHeapAlloc(node) {
  if (!Array.isArray(node)) return false
  const op = node[0]
  if (op === '{}') {
    // `['{}', [';', …]]` is a block body, not an object literal.
    if (node.length === 2 && Array.isArray(node[1]) && node[1][0] === ';') return false
    return node.length > 1
  }
  if (op === '[]') return node.length === 2
  if (op === '()' && Array.isArray(node[1]) && node[1][0] === '.') {
    const method = node[1][2]
    if (method === 'push' || method === 'concat') return true
  }
  return false
}

function containsHeapAlloc(node) {
  if (!Array.isArray(node)) return false
  if (isHeapAlloc(node)) return true
  for (let i = 1; i < node.length; i++)
    if (containsHeapAlloc(node[i])) return true
  return false
}

function heapLoopBody(node) {
  if (!Array.isArray(node) || !HEAP_LOOP_OPS.has(node[0])) return null
  return node[node.length - 1]
}

function heapLoopAllocSites(body) {
  const sites = []
  const walk = (node) => {
    if (!Array.isArray(node)) return
    if (HEAP_LOOP_OPS.has(node[0])) {
      const lb = heapLoopBody(node)
      if (lb && containsHeapAlloc(lb))
        sites.push({ loc: node.loc ?? lb.loc })
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body)
  return sites
}

function bodyHeapAllocates(body) {
  return body != null && containsHeapAlloc(body)
}

/** Mirrors `applyArenaRewind` eligibility in src/assemble.js (AST-level). */
function isArenaRewindable(func) {
  if (func.raw) return false
  if (func.sig.params.length !== 0) return false
  if (func.sig.results.length !== 1) return false
  if (func.sig.ptrKind != null) return false
  if (returnsHeap(func)) return false
  if (func.sig.results[0] === 'f64' && func.valResult !== VAL.NUMBER && func.valResult != null)
    return false
  if (func.sig.results[0] !== 'f64' && func.sig.results[0] !== 'i32') return false
  return bodyHeapAllocates(func.body)
}

function exportedFuncNames() {
  const names = new Set()
  for (const [key, val] of Object.entries(ctx.func.exports)) {
    const name = val === true ? key : (typeof val === 'string' ? val : null)
    if (name) names.add(name)
  }
  return names
}

/** Bump-allocator growth advisories — no-op without an `opts.warnings` sink. */
function adviseHeapGrowth() {
  if (!ctx.warnings) return
  if (ctx.transform.alloc === false) return

  const exported = exportedFuncNames()

  for (const func of ctx.func.list) {
    if (func.raw || !func.body) continue

    const fn = func.name
    const isExport = exported.has(fn)

    if (isExport && returnsHeap(func)) {
      warn('heap-return',
        `export '${fn}' returns a heap value — repeated calls grow linear memory; call memory.reset() between batches from the host`,
        { fn, loc: func.body.loc })
      continue
    }

    const loopSites = heapLoopAllocSites(func.body)
    for (const site of loopSites) {
      warn('heap-loop',
        `${isExport ? `export '${fn}'` : `'${fn}'`} allocates heap values inside a loop — peak memory grows with trip count; call memory.reset() between batches from the host`,
        { fn, loc: site.loc })
    }

    if (isExport && !returnsHeap(func) && bodyHeapAllocates(func.body)
        && !isArenaRewindable(func) && loopSites.length === 0) {
      const code = func.sig.params.length > 0 ? 'arena-rewind-skipped' : 'heap-per-call'
      const detail = func.sig.params.length > 0
        ? `export '${fn}' allocates heap values but cannot rewind per call (parameters or returned pointers prevent arena rewind)`
        : `export '${fn}' allocates heap values — jz does not reclaim between calls`
      warn(code,
        `${detail}; call memory.reset() between batches from the host`,
        { fn, loc: func.body.loc })
    }
  }
}

const SET_MAP_ITER_OPS = new Set(['for-in', 'for-of'])
const SET_MAP_METHODS = new Set(['keys', 'values', 'entries', 'forEach'])
const SET_MAP_SLOT_ORDER = 'uses slot order, not insertion order — results may differ from JavaScript'

function newSetMapKind(node) {
  if (!Array.isArray(node)) return null
  if (node[0] === 'new') {
    const ctor = node[1]
    const name = typeof ctor === 'string' ? ctor
      : Array.isArray(ctor) && ctor[0] === '()' && typeof ctor[1] === 'string' ? ctor[1]
      : null
    if (name === 'Set') return 'set'
    if (name === 'Map') return 'map'
  }
  if (node[0] === '()' && typeof node[1] === 'string') {
    if (node[1] === 'new.Set') return 'set'
    if (node[1] === 'new.Map') return 'map'
  }
  return null
}

function collectSetMapBindings(body) {
  const bindings = new Map()
  const walk = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
        const kind = newSetMapKind(d[2])
        if (kind) bindings.set(d[1], kind)
      }
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body)
  return bindings
}

function exprSetMapKind(expr, bindings) {
  const direct = newSetMapKind(expr)
  if (direct) return direct
  return typeof expr === 'string' ? bindings.get(expr) || null : null
}

function isJsonStringifyCall(node) {
  if (!Array.isArray(node) || node[0] !== '()') return false
  const callee = node[1]
  if (callee === 'JSON.stringify') return true
  return Array.isArray(callee) && callee[0] === '.' && callee[1] === 'JSON' && callee[2] === 'stringify'
}

function adviseSetMapIterationOrder() {
  if (!ctx.warnings) return

  for (const func of ctx.func.list) {
    if (func.raw || !func.body) continue
    const fn = func.name
    const bindings = collectSetMapBindings(func.body)

    const warnOrder = (msg, loc) => warn('set-map-order', msg, { fn, loc })
    const label = (kind) => kind === 'set' ? 'Set' : 'Map'

    const walk = (node) => {
      if (!Array.isArray(node)) return
      const op = node[0]

      if (SET_MAP_ITER_OPS.has(op)) {
        const kind = exprSetMapKind(node[2], bindings)
        if (kind) warnOrder(`${label(kind)} iteration ${SET_MAP_SLOT_ORDER}`, node.loc ?? node[2]?.loc)
      }

      if (op === '()' && Array.isArray(node[1]) && node[1][0] === '.') {
        const [, recv, method] = node[1]
        const kind = SET_MAP_METHODS.has(method) ? exprSetMapKind(recv, bindings) : null
        if (kind) warnOrder(`${label(kind)}.${method}() ${SET_MAP_SLOT_ORDER}`, node.loc ?? recv?.loc)
      }

      if (isJsonStringifyCall(node)) {
        const kind = exprSetMapKind(node[2], bindings)
        if (kind) warnOrder(`JSON.stringify on a ${kind} serializes entries in slot order, not insertion order — output may differ from JavaScript`, node.loc)
      }

      if (op === '...') {
        const kind = exprSetMapKind(node[1], bindings)
        if (kind) warnOrder(`spread over a ${kind} follows slot order, not insertion order — element order may differ from JavaScript`, node.loc)
      }

      for (let i = 1; i < node.length; i++) walk(node[i])
    }
    walk(func.body)
  }
}

function forInductionVar(step) {
  if (!Array.isArray(step)) return null
  if (step[0] === '++' || step[0] === '--') return typeof step[1] === 'string' ? step[1] : null
  if (step[0] === '-' && Array.isArray(step[1]) && step[1][0] === '++')
    return typeof step[1][1] === 'string' ? step[1][1] : null
  if ((step[0] === '+=' || step[0] === '-=') && step[2]?.[0] == null && step[2]?.[1] === 1)
    return typeof step[1] === 'string' ? step[1] : null
  return null
}

function indexStrideOnVar(indexExpr, iv) {
  if (!Array.isArray(indexExpr)) return 1
  const op = indexExpr[0]
  if (indexExpr === iv) return 1
  if (op === '[]' && indexExpr[2] === iv) return 1
  if (op === '*' && ((indexExpr[1] === iv && intLiteralValue(indexExpr[2]) > 1)
    || (indexExpr[2] === iv && intLiteralValue(indexExpr[1]) > 1)))
    return intLiteralValue(indexExpr[1] === iv ? indexExpr[2] : indexExpr[1])
  if (op === '+') {
    for (let i = 1; i < indexExpr.length; i++) {
      const s = indexStrideOnVar(indexExpr[i], iv)
      if (s > 1) return s
    }
  }
  return 1
}

const SIMD_REDUCE_OPS = new Set(['+=', '|=', '&=', '^=', '-=', '*=', '/=', '%='])

function simdLoopIssues(body, iv) {
  let indexed = false, carried = false, maxStride = 1
  const walk = (node) => {
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op === '=>') return
    if (op === '[]' && node.length === 3) {
      const idx = node[2]
      if (idx === iv || (Array.isArray(idx) && refsName(idx, iv, REFS_IN_EXPR))) indexed = true
      const stride = indexStrideOnVar(idx, iv)
      if (stride > maxStride) maxStride = stride
    }
    if (SIMD_REDUCE_OPS.has(op) && typeof node[1] === 'string' && node[1] !== iv) carried = true
    if (op === '=' && typeof node[1] === 'string' && node[1] !== iv) {
      const rhs = node[2]
      if (rhs === node[1] || (Array.isArray(rhs) && refsName(rhs, node[1], REFS_IN_EXPR))) carried = true
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body)
  return { indexed, carried, maxStride }
}

function adviseSimdLoops() {
  if (!ctx.warnings) return
  if (ctx.transform.optimize?.vectorizeLaneLocal === false) return

  for (const func of ctx.func.list) {
    if (func.raw || !func.body) continue
    const fn = func.name

    const walk = (node) => {
      if (!Array.isArray(node)) return
      if (node[0] === 'for' && node.length >= 5) {
        const [, , , step, body] = node
        const iv = forInductionVar(step)
        if (iv) {
          const { indexed, carried, maxStride } = simdLoopIssues(body, iv)
          if (indexed && carried) {
            warn('simd-loop-carried',
              `'${fn}' loop carries a scalar updated each iteration — SIMD vectorization skipped; split the reduction or use a separate accumulator`,
              { fn, loc: node.loc })
          }
          if (indexed && maxStride > 1) {
            warn('simd-aos-stride',
              `'${fn}' indexed access stride ${maxStride} on loop counter — split into one typed array per field for SIMD (array-of-structures blocks vectorization)`,
              { fn, loc: node.loc })
          }
        }
      }
      for (let i = 1; i < node.length; i++) walk(node[i])
    }
    walk(func.body)
  }
}

/** Compile-time advisories at end of plan — extensible home for soft warnings. */
export function adviseProgram(programFacts) {
  adviseHeapGrowth()
  adviseSetMapIterationOrder()
  if (programFacts) adviseJsstringCarrier(programFacts.paramReps, programFacts.valueUsed)
  adviseSimdLoops()
}

