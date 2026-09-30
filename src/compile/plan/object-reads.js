/**
 * A key a loop reads of an object nothing else touches is read once, where the
 * object is made.
 *
 * `let p = { ...PRESETS[preset], ...opts }`, then `(p.freq ?? 440)` per sample:
 * a spread of sources of several shapes makes a dictionary, so each read hashes
 * the key again, every iteration. The object is made here, with no accessor of
 * its own, and the function does nothing with it but read its keys by name: it
 * hands it to no call, stores it nowhere, writes none of its keys, and no
 * closure sees it. Its keys then hold the values they held when it was made,
 * and a read of one can neither throw nor run code, so `const p·freq = p.freq`
 * right after the declaration reads what every later read would.
 *
 * @module compile/plan/object-reads
 */
import { ctx } from '../../ctx.js'
import { T, ACCESSOR_GET, ACCESSOR_SET, isBlockBody, walkAst } from '../../ast.js'
import { invalidateBodies } from '../analyze.js'
import { invalidateProgramFactsCache } from '../program-facts.js'

const LOOPS = new Set(['for', 'while', 'do'])

/** Whether an object literal has an accessor of its own (a read of it runs code). */
const hasAccessor = (lit) => lit.slice(1).some(e => Array.isArray(e) && e[0] === ':' && typeof e[1] === 'string' &&
  (e[1].endsWith(ACCESSOR_GET) || e[1].endsWith(ACCESSOR_SET)))

/** Every mention of `name` in `node`, with its parent and slot, and whether it sits in a loop. */
const mentions = (node, name, out, parent = null, slot = 0, inLoop = false, inClosure = false) => {
  if (node === name) { out.push({ parent, slot, inLoop, inClosure }); return }
  if (!Array.isArray(node) || node[0] === 'str' || node[0] == null) return
  const loop = inLoop || LOOPS.has(node[0]), closure = inClosure || node[0] === '=>'
  for (let i = node[0] === '.' || node[0] === '?.' ? 1 : node[0] === ':' ? 2 : 1; i < node.length; i++) {
    if ((node[0] === '.' || node[0] === '?.') && i === 2) break
    mentions(node[i], name, out, node, i, loop, closure)
  }
}

/** The statement lists of `body`: each `;` sequence and block, with its statements' positions. */
const eachList = (node, f) => {
  if (!Array.isArray(node) || node[0] === '=>') return
  if (node[0] === ';') f(node)
  for (let i = 1; i < node.length; i++) eachList(node[i], f)
}

export const hoistObjectReads = () => {
  if (ctx.transform.optimize?.hoistObjectReads === false) return false
  let changed = false
  for (const func of ctx.funcs.list) {
    if (!func.body || func.raw || !isBlockBody(func.body)) continue
    const params = new Set((func.sig?.params ?? []).map(p => p.name))
    // declarations of a fresh object literal, one per name in the function
    const decls = new Map(), counts = new Map()
    eachList(func.body, (list) => {
      for (let i = 1; i < list.length; i++) {
        const st = list[i]
        if (!Array.isArray(st) || (st[0] !== 'let' && st[0] !== 'const') || st.length !== 2) continue
        const d = st[1]
        if (!Array.isArray(d) || d[0] !== '=' || typeof d[1] !== 'string') continue
        if (Array.isArray(d[2]) && d[2][0] === '{}' && !isBlockBody(d[2]) && !hasAccessor(d[2])) decls.set(d[1], { list, st })
      }
    })
    if (!decls.size) continue
    walkAst(func.body, { enter: (n) => {
      if (n[0] !== 'let' && n[0] !== 'const') return
      for (let i = 1; i < n.length; i++) {
        const id = typeof n[i] === 'string' ? n[i] : Array.isArray(n[i]) && n[i][0] === '=' ? n[i][1] : null
        if (typeof id === 'string') counts.set(id, (counts.get(id) ?? 0) + 1)
      }
    } })
    let rewrote = false
    for (const [name, { list, st }] of decls) {
      if (counts.get(name) !== 1 || params.has(name)) continue
      // the declaration's own list is the binding's scope: a loop that holds the list
      // makes the object again each pass, so only a loop inside it reads it more than once
      const seen = []
      mentions(list, name, seen)
      // the declaration itself, then reads by name alone: `p.key`, `p?.key`, never a callee's receiver or a store's target
      const reads = seen.filter(m => m.parent !== st[1])
      if (seen.length - reads.length !== 1) continue
      if (!reads.every(m => !m.inClosure && (m.parent[0] === '.' || m.parent[0] === '?.') && m.slot === 1 && typeof m.parent[2] === 'string')) continue
      const readNodes = new Set(reads.map(m => m.parent))
      let ok = true
      walkAst(func.body, { enter: (n) => {
        if (!ok) return false
        // a member read called (`p.f()`, its receiver `this`), written, counted or deleted
        if ((n[0] === '()' || n[0] === '?.()') && readNodes.has(n[1])) ok = false
        else if ((n[0] === '=' || n[0] === 'delete' || n[0] === '++' || n[0] === '--' || (typeof n[0] === 'string' && n[0].length > 1 && n[0].endsWith('=') &&
          !['==', '===', '!=', '!==', '<=', '>=', '=>'].includes(n[0]))) && readNodes.has(n[1])) ok = false
      } })
      if (!ok) continue
      const keys = new Map()   // key → local
      for (const m of reads) if (m.inLoop) keys.set(m.parent[2], `${name}${T}o${m.parent[2]}`)
      if (!keys.size) continue
      const at = list.indexOf(st)
      list.splice(at + 1, 0, ...[...keys].map(([key, local]) => ['const', ['=', local, ['.', name, key]]]))
      const local = new Map(reads.filter(m => m.inLoop).map(m => [m.parent, keys.get(m.parent[2])]))
      const sub = (node) => {
        if (!Array.isArray(node)) return
        for (let i = 1; i < node.length; i++) if (local.has(node[i])) node[i] = local.get(node[i]); else sub(node[i])
      }
      sub(func.body)
      rewrote = true
    }
    if (rewrote) { invalidateProgramFactsCache(func.body); invalidateBodies([func.body]); changed = true }
  }
  return changed
}
