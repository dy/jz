/**
 * Auto-detect optimization tuning from source characteristics.
 *
 * Scans the prepared AST + ctx.func.list to infer program properties
 * and returns suggested optimization overrides. When the user does not
 * explicitly configure individual passes, these suggestions are merged
 * in before resolveOptimize() so the compiler self-tunes.
 *
 * @module auto-config
 */

import { ctx } from './ctx.js'

const LOOP_OPS = new Set(['for', 'while', 'do', 'do-while'])
const TYPED_CTORS = new Set([
  'new.Float32Array', 'new.Float64Array', 'new.Int8Array', 'new.Int16Array',
  'new.Int32Array', 'new.Uint8Array', 'new.Uint16Array', 'new.Uint32Array',
  'new.Uint8ClampedArray',
])

function nodeSize(node) {
  if (!Array.isArray(node)) return 1
  let n = 1
  for (let i = 1; i < node.length; i++) n += nodeSize(node[i])
  return n
}

function scanNode(node, stats, loopDepth) {
  if (!Array.isArray(node)) return
  const op = node[0]

  if (LOOP_OPS.has(op)) {
    stats.loopCount++
    const d = loopDepth + 1
    if (d > stats.maxLoopDepth) stats.maxLoopDepth = d
    for (let i = 1; i < node.length; i++) scanNode(node[i], stats, d)
    return
  }

  if (op === '()') {
    stats.callSites++
    const callee = node[1]
    if (typeof callee === 'string' && TYPED_CTORS.has(callee)) {
      stats.typedArrayCount++
      const args = node[2]
      const argList = args == null ? [] : (Array.isArray(args) && args[0] === ',') ? args.slice(1) : [args]
      const lenLit = typeof argList[0] === 'number' ? argList[0] : null
      if (lenLit != null && lenLit > stats.maxTypedArrayLen) stats.maxTypedArrayLen = lenLit
    }
  }

  if (op === 'str') stats.stringLiteralCount++
  if (op === '=>') stats.closureCount++

  for (let i = 1; i < node.length; i++) scanNode(node[i], stats, loopDepth)
}

function scanStats(ast, code) {
  const stats = {
    sourceChars: code?.length || 0,
    funcCount: 0,
    maxFuncBodySize: 0,
    loopCount: 0,
    maxLoopDepth: 0,
    typedArrayCount: 0,
    maxTypedArrayLen: 0,
    stringLiteralCount: 0,
    closureCount: 0,
    callSites: 0,
  }

  if (ctx.func?.list) {
    stats.funcCount = ctx.func.list.length
    for (const f of ctx.func.list) {
      if (f.body) {
        const sz = nodeSize(f.body)
        if (sz > stats.maxFuncBodySize) stats.maxFuncBodySize = sz
        scanNode(f.body, stats, 0)
      }
    }
  }
  if (ast) scanNode(ast, stats, 0)
  return stats
}

/**
 * Detect optimization config from source characteristics.
 * Returns an object of pass overrides; empty object means "use defaults".
 */
export function detectOptimizeConfig(ast, code) {
  const s = scanStats(ast, code)
  const cfg = {}

  // Machine-generated or large code: watr's WAT-level CSE/DCE/inline fights
  // jz's already-optimized IR and inflates output. Disable it automatically.
  const isLarge = s.sourceChars > 4000 || s.funcCount > 40 || s.maxFuncBodySize > 300
  const isMachineLike = s.callSites > 300 && s.stringLiteralCount < 10
  if (isLarge || isMachineLike) cfg.watr = false

  // Typed-array heavy: tighten scalarization thresholds when we see large
  // fixed-size arrays; keep defaults for small/dynamic ones.
  if (s.typedArrayCount > 0 && s.maxTypedArrayLen > 0) {
    cfg.scalarTypedArrayLen = Math.min(32, Math.max(8, s.maxTypedArrayLen + 4))
    cfg.scalarTypedLoopUnroll = s.maxLoopDepth > 1 ? 8 : 16
    cfg.scalarTypedNestedUnroll = s.maxLoopDepth > 1 ? 32 : 128
  }

  // String-heavy: ensure pool sorting is on (already default, but explicit).
  if (s.stringLiteralCount > 30) {
    cfg.sortStrPoolByFreq = true
  }

  // Closure-heavy: ptr hoists pay off.
  if (s.closureCount > 4) {
    cfg.hoistPtrType = true
    cfg.hoistInvariantPtrOffset = true
  }

  return cfg
}
