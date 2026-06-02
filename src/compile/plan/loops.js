/**
 * Row-length pad-loop unrolling — recognizes the `pad-the-shorter-rows` shape
 * over a nested int-row table and emits the equivalent straight-line padding:
 *
 *   const table = [[1,2,3], [4,5], [6]]
 *   for (let i = row.length; i < N; i++) row[i] = 0
 *
 * becomes the per-row unrolled assignments (no loop body, no comparisons), as
 * long as the row's length is statically known (one of the entries in `table`)
 * and the pad bound `N` is also static. The transform binds a `rowlen` lookup
 * up front so reads of `table[i].length` collapse to scalar `rowlen[i]`.
 *
 * Two passes, each idempotent:
 *   - `bindNestedRowLengths`     introduces / threads the `rowlen` binding
 *   - `unrollRowLenPadLoops`     unrolls each qualifying pad loop in place
 *
 * @module compile/plan/loops
 */

import { ctx } from '../../ctx.js'
import { stmtList, T, some, isReassigned, hasControlTransfer } from '../../ast.js'
import { constIntExpr } from '../../static.js'
import { containsDeclOf, cloneWithSubst } from '../../type.js'
import { clonePlain, forLoopBodyIndex, withForLoopBody } from './common.js'

// Nested int row literal: `[[1,2],[3]]` → { flat, starts, lens }.
const parseNestedIntRowLit = (expr) => {
  if (!Array.isArray(expr) || expr[0] !== '[') return null
  let rows = expr.slice(1)
  if (rows.length === 1 && Array.isArray(rows[0]) && rows[0][0] === ',') rows = rows[0].slice(1)
  if (!rows.length) return null
  const flat = [], starts = [], lens = []
  for (const row of rows) {
    if (!Array.isArray(row) || row[0] !== '[') return null
    starts.push(flat.length)
    let elems = row.slice(1)
    if (elems.length === 1 && Array.isArray(elems[0]) && elems[0][0] === ',') elems = elems[0].slice(1)
    let rowLen = 0
    for (const el of elems) {
      const v = constIntExpr(el)
      if (v == null) return null
      flat.push(v)
      rowLen++
    }
    lens.push(rowLen)
  }
  return { flat, starts, lens }
}

const intRowLitIR = nums => ['[', ...nums.map(n => [null, n])]

const wrapStmtList = (stmts, orig) => {
  if (Array.isArray(orig) && orig[0] === ';') return [';', ...stmts]
  if (Array.isArray(orig) && orig[0] === '{}') return ['{}', [';', ...stmts]]
  return [';', ...stmts]
}

// `row[ci].length` on nested static int-row tables → `rowlen[ci]`.
// General: `const rows = [[…],…]; const row = rows[idx]; … row.length`.
export const bindNestedRowLengths = () => {
  let changed = false
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    const r = bindNestedRowLengthsInBody(func.body)
    if (r.changed) { func.body = r.node; changed = true }
  }
  return changed
}

const bindNestedRowLengthsInBody = (body) => {
  if (Array.isArray(body) && body[0] === '=>') {
    const inner = bindNestedRowLengthsInBody(body[2])
    if (!inner.changed) return { node: body, changed: false }
    return { node: [body[0], body[1], inner.node], changed: true }
  }

  const direct = bindNestedRowLengthsSeq(body)
  if (direct.changed) return direct

  const stmts = stmtList(body)
  if (!stmts?.length) return { node: body, changed: false }

  let changed = false
  const out = []
  for (const stmt of stmts) {
    if (Array.isArray(stmt) && stmt[0] === 'while') {
      const r = bindNestedRowLengthsInBody(stmt[2])
      if (r.changed) { changed = true; out.push(['while', stmt[1], r.node]); continue }
    }
    if (Array.isArray(stmt) && stmt[0] === 'for') {
      const idx = forLoopBodyIndex(stmt)
      const r = bindNestedRowLengthsInBody(stmt[idx])
      if (r.changed) { changed = true; out.push(withForLoopBody(stmt, r.node)); continue }
    }
    if (Array.isArray(stmt) && stmt[0] === 'if') {
      const thenR = bindNestedRowLengthsInBody(stmt[2])
      const elseR = stmt.length > 3 ? bindNestedRowLengthsInBody(stmt[3]) : null
      if (thenR.changed || elseR?.changed) {
        changed = true
        out.push(stmt.length > 3 ? ['if', stmt[1], thenR.node, elseR.node] : ['if', stmt[1], thenR.node])
        continue
      }
    }
    out.push(stmt)
  }
  return changed ? { node: wrapStmtList(out, body), changed: true } : { node: body, changed: false }
}

const bindNestedRowLengthsSeq = (body) => {
  const stmts = stmtList(body)
  if (!stmts) return { node: body, changed: false }

  const progRows = new Map()
  const rowAliases = new Map()

  for (const stmt of stmts) {
    if (!Array.isArray(stmt) || (stmt[0] !== 'let' && stmt[0] !== 'const') || stmt.length !== 2) continue
    const decl = stmt[1]
    if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
    const parsed = parseNestedIntRowLit(decl[2])
    if (parsed) progRows.set(decl[1], parsed)
  }

  for (const stmt of stmts) {
    if (!Array.isArray(stmt) || (stmt[0] !== 'let' && stmt[0] !== 'const') || stmt.length !== 2) continue
    const decl = stmt[1]
    if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
    const rhs = decl[2]
    if (!Array.isArray(rhs) || rhs[0] !== '[]' || typeof rhs[1] !== 'string') continue
    const rows = progRows.get(rhs[1])
    if (!rows) continue
    rowAliases.set(decl[1], { prog: rhs[1], rowExpr: rhs[2], lens: rows.lens })
  }

  if (!rowAliases.size) return { node: body, changed: false }

  const needsLen = (node) => {
    if (!Array.isArray(node)) return false
    const op = node[0]
    if (op === '.' && typeof node[1] === 'string' && rowAliases.has(node[1]) && node[2] === 'length') return true
    if (op === '[]' && typeof node[1] === 'string' && rowAliases.has(node[1])) {
      const idx = node[2]
      if (Array.isArray(idx) && idx[0] === '%' && Array.isArray(idx[2])
          && idx[2][0] === '.' && idx[2][1] === node[1] && idx[2][2] === 'length') return true
    }
    for (let i = 1; i < node.length; i++) if (needsLen(node[i])) return true
    return false
  }
  if (!stmts.some(s => needsLen(s))) return { node: body, changed: false }

  const rowIndexExpr = (rowExpr, progName) =>
    (Array.isArray(rowExpr) && rowExpr[0] === '[]' && rowExpr[1] === progName)
      ? clonePlain(rowExpr[2]) : clonePlain(rowExpr)

  const lensSyms = new Map()
  for (const alias of rowAliases.values()) {
    if (lensSyms.has(alias.prog)) continue
    const id = ctx.func.uniq++
    lensSyms.set(alias.prog, { name: `${T}rowlen${id}`, lens: alias.lens })
  }

  const rewrite = (node) => {
    if (!Array.isArray(node)) return node
    const op = node[0]
    if (op === '=>') {
      const inner = rewrite(node[2])
      return inner === node[2] ? node : [node[0], node[1], inner]
    }
    if (op === '.' && typeof node[1] === 'string' && rowAliases.has(node[1]) && node[2] === 'length') {
      const { rowExpr, prog } = rowAliases.get(node[1])
      return ['[]', lensSyms.get(prog).name, rowIndexExpr(rowExpr, prog)]
    }
    if (op === '[]' && typeof node[1] === 'string' && rowAliases.has(node[1])) {
      const alias = rowAliases.get(node[1])
      const idx = node[2]
      if (Array.isArray(idx) && idx[0] === '%' && Array.isArray(idx[2])
          && idx[2][0] === '.' && idx[2][1] === node[1] && idx[2][2] === 'length') {
        const tab = lensSyms.get(alias.prog)
        return ['%', rewrite(idx[1]), ['[]', tab.name, rowIndexExpr(alias.rowExpr, alias.prog)]]
      }
    }
    return node.map((part, i) => i === 0 ? part : rewrite(part))
  }

  const prologue = [...lensSyms.values()].map(tab =>
    ['const', ['=', tab.name, intRowLitIR(tab.lens)]])

  const out = [...prologue]
  for (const stmt of stmts) out.push(rewrite(stmt))
  return { node: wrapStmtList(out, body), changed: true }
}

// `for (i < rowlen[ci])` inner loops — full unroll when lens are uniform;
// min-length loop + one guarded tail when they vary (mixed static row lengths).
const MAX_ROWLEN_PAD_UNROLL = 8

const parseFlatIntRowLit = (expr) => {
  if (!Array.isArray(expr) || expr[0] !== '[') return null
  let elems = expr.slice(1)
  if (elems.length === 1 && Array.isArray(elems[0]) && elems[0][0] === ',') elems = elems[0].slice(1)
  const lens = []
  for (const el of elems) {
    const v = constIntExpr(el)
    if (v == null || v < 0) return null
    lens.push(v)
  }
  return lens.length ? lens : null
}

const collectRowLenTables = (stmts) => {
  const tables = new Map()
  for (const stmt of stmts) {
    if (!Array.isArray(stmt) || (stmt[0] !== 'let' && stmt[0] !== 'const') || stmt.length !== 2) continue
    const decl = stmt[1]
    if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
    const lens = parseFlatIntRowLit(decl[2])
    if (lens) tables.set(decl[1], { lens, min: Math.min(...lens), max: Math.max(...lens) })
  }
  return tables
}

const parseRowLenBound = (expr) => {
  if (Array.isArray(expr) && expr[0] === '[]' && typeof expr[1] === 'string') {
    return { rowlen: expr[1], ci: expr[2] }
  }
  if (typeof expr === 'string') return { lenVar: expr }
  return null
}

const rowLenBoundFromHoist = (init, lenVar) => {
  const scan = (node) => {
    if (!Array.isArray(node)) return null
    if (node[0] === 'let' && node.length === 2) {
      const decl = node[1]
      if (Array.isArray(decl) && decl[0] === '=' && decl[1] === lenVar) {
        const rhs = decl[2]
        if (Array.isArray(rhs) && (rhs[0] === '|' || rhs[0] === '>>>' || rhs[0] === '&') && rhs.length === 3) {
          const inner = parseRowLenBound(rhs[1])
          if (inner?.rowlen) return inner
        }
        return parseRowLenBound(rhs)
      }
    }
    if (node[0] === ';') {
      for (let i = 1; i < node.length; i++) {
        const r = scan(node[i])
        if (r) return r
      }
    }
    return null
  }
  return scan(init)
}

const parseForIncStep = (step, idx) => {
  if (Array.isArray(step) && step[0] === '++' && step[1] === idx) return true
  // `i++` in a for-head step preps to ['-', ['++', i], 1].
  return Array.isArray(step) && step[0] === '-' && Array.isArray(step[1])
    && step[1][0] === '++' && step[1][1] === idx && constIntExpr(step[2]) === 1
}

const parseRowLenForTrip = (init, cond, step) => {
  let idx = null
  if (Array.isArray(init) && init[0] === 'let' && init.length === 2) {
    const decl = init[1]
    if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' && constIntExpr(decl[2]) === 0)
      idx = decl[1]
  } else if (Array.isArray(init) && init[0] === ';') {
    for (let i = 1; i < init.length; i++) {
      const s = init[i]
      if (Array.isArray(s) && s[0] === 'let' && s.length === 2) {
        const decl = s[1]
        if (Array.isArray(decl) && decl[0] === '=' && typeof decl[1] === 'string' && constIntExpr(decl[2]) === 0) {
          idx = decl[1]
          break
        }
      }
    }
  }
  if (!idx) return null
  if (!Array.isArray(cond) || cond[0] !== '<' || cond[1] !== idx) return null
  if (!parseForIncStep(step, idx)) return null

  let bound = parseRowLenBound(cond[2])
  if (bound?.lenVar) {
    const resolved = rowLenBoundFromHoist(init, bound.lenVar)
    if (!resolved) return null
    bound = resolved
  }
  if (!bound?.rowlen) return null
  return { idx, rowlen: bound.rowlen, ci: bound.ci }
}

const tryUnrollRowLenFor = (forNode, tables) => {
  if (!Array.isArray(forNode) || forNode[0] !== 'for' || forNode.length !== 5) return null
  const trip = parseRowLenForTrip(forNode[1], forNode[2], forNode[3])
  if (!trip) return null
  // `ci` must be a variable (outer loop index) — a constant index like `a[1]`
  // means the bound is always the same value, so per-row unrolling doesn't apply.
  if (typeof trip.ci !== 'string') return null
  const tab = tables.get(trip.rowlen)
  if (!tab || tab.max > MAX_ROWLEN_PAD_UNROLL || tab.max < 2) return null
  const body = forNode[4]
  const step = forNode[3]
  if (hasControlTransfer(body) || containsDeclOf(body, trip.idx) || isReassigned(body, trip.idx)) return null

  const bound = ['[]', trip.rowlen, clonePlain(trip.ci)]
  const idxInit = ['let', ['=', trip.idx, [null, 0]]]
  const out = []

  if (tab.min === tab.max) {
    for (let k = 0; k < tab.max; k++) {
      out.push(cloneWithSubst(body, new Map([[trip.idx, [null, k]]]), new Map()))
    }
  } else {
    // Variable row lengths (e.g. waltz 5/4/4/5): a short loop for the common
    // prefix (min iterations), then one guarded tail per possible extra row
    // length (min..max-1). The guards are monotonic in `k` — `bound` is loop-
    // invariant across them — so they run exactly `bound` iterations in total
    // for any `min <= bound <= max` (not just `max === min + 1`).
    out.push(['for', idxInit, ['<', trip.idx, [null, tab.min]], step, body])
    for (let k = tab.min; k < tab.max; k++) {
      const tail = cloneWithSubst(body, new Map([[trip.idx, [null, k]]]), new Map())
      out.push(['if', ['<', [null, k], clonePlain(bound)], tail])
    }
  }
  return out.length === 1 ? out[0] : [';', ...out]
}

const unrollRowLenPadLoopsSeq = (body, outerTables = null) => {
  const stmts = stmtList(body)
  if (!stmts) return { node: body, changed: false }

  const tables = new Map(outerTables)
  for (const [name, tab] of collectRowLenTables(stmts)) tables.set(name, tab)

  let changed = false
  const out = []
  for (const stmt of stmts) {
    if (Array.isArray(stmt) && stmt[0] === 'for' && stmt.length === 5) {
      const unrolled = tryUnrollRowLenFor(stmt, tables)
      if (unrolled) { changed = true; out.push(unrolled); continue }
    }
    if (Array.isArray(stmt) && stmt[0] === 'while') {
      const r = unrollRowLenPadLoopsInBody(stmt[2], tables)
      if (r.changed) { changed = true; out.push(['while', stmt[1], r.node]); continue }
    }
    if (Array.isArray(stmt) && stmt[0] === 'for') {
      const idx = forLoopBodyIndex(stmt)
      if (idx != null) {
        const r = unrollRowLenPadLoopsInBody(stmt[idx], tables)
        if (r.changed) { changed = true; out.push(withForLoopBody(stmt, r.node)); continue }
      }
    }
    if (Array.isArray(stmt) && stmt[0] === 'if') {
      const thenR = unrollRowLenPadLoopsInBody(stmt[2], tables)
      const elseR = stmt.length > 3 ? unrollRowLenPadLoopsInBody(stmt[3], tables) : null
      if (thenR.changed || elseR?.changed) {
        changed = true
        out.push(stmt.length > 3 ? ['if', stmt[1], thenR.node, elseR.node] : ['if', stmt[1], thenR.node])
        continue
      }
    }
    out.push(stmt)
  }
  return changed ? { node: wrapStmtList(out, body), changed: true } : { node: body, changed: false }
}

const unrollRowLenPadLoopsInBody = (body, outerTables = null) => {
  if (Array.isArray(body) && body[0] === '=>') {
    const inner = unrollRowLenPadLoopsInBody(body[2], outerTables)
    if (!inner.changed) return { node: body, changed: false }
    return { node: [body[0], body[1], inner.node], changed: true }
  }
  return unrollRowLenPadLoopsSeq(body, outerTables)
}

export const unrollRowLenPadLoops = () => {
  let changed = false
  for (const func of ctx.func.list) {
    if (!func.body || func.raw) continue
    const r = unrollRowLenPadLoopsInBody(func.body)
    if (r.changed) { func.body = r.node; changed = true }
  }
  return changed
}
