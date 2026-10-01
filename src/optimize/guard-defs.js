// Demand-only reaching definitions for a saved scalar guard. A statement that
// may write the name conditionally blocks the lookup; crossing a loop that
// writes it would confuse the first entry with later iterations.
import { writesLocal } from '../ir/classify.js'

const ENTRY = {}, UNKNOWN = {}
const CONTROL = new Set(['if', 'block', 'loop', 'try', 'try_table', 'catch', 'catch_all', 'br', 'br_if', 'br_table', 'return', 'return_call', 'return_call_indirect', 'return_call_ref', 'throw', 'throw_ref', 'rethrow'])
const arr = Array.isArray
const samePath = (a, b) => a?.length === b.length && a.every((n, i) => n === b[i])

export function guardDefinitions(written = null) {
  const cache = new WeakMap()
  const write = (n, name, path) => {
    if (!arr(n) || !writesLocal(n, name)) return null
    const parent = path[path.length - 1]
    if (parent.indexOf(n) !== parent.lastIndexOf(n)) return UNKNOWN
    if (CONTROL.has(n[0])) return UNKNOWN
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && n[1] === name)
      return { node: n, value: n[2], path: [...path, n, n[2]] }
    for (let i = n.length - 1; i > 0; i--) {
      const found = write(n[i], name, [...path, n])
      if (found) return found
    }
    return UNKNOWN
  }
  const latest = (name, path) => {
    if (written && !written.has(name)) return ENTRY
    const site = path[path.length - 1]
    let byName = cache.get(site)
    const old = byName?.get(name)
    if (old && samePath(old.path, path)) return old.value
    let value = ENTRY
    search: for (let i = path.length - 2; i >= 0; i--) {
      const parent = path[i], child = path[i + 1], at = parent.indexOf(child)
      if (at < 0 || parent.lastIndexOf(child) !== at) { value = UNKNOWN; break }
      // Only the test precedes an arm. The opposite arm never does.
      if (parent[0] === 'if') {
        if ((child[0] === 'then' || child[0] === 'else') && writesLocal(parent, name)) { value = UNKNOWN; break }
        continue
      }
      for (let j = at - 1; j > 0; j--) {
        const n = parent[j]
        if (!arr(n) || !writesLocal(n, name)) continue
        const found = write(n, name, path.slice(0, i + 1))
        if (found) { value = found; break search }
      }
      if (parent[0] === 'loop' && writesLocal(parent, name)) { value = UNKNOWN; break }
    }
    if (!byName) cache.set(site, byName = new Map())
    byName.set(name, { path: path.slice(), value })
    return value
  }

  const same = (a, b) => a !== UNKNOWN && b !== UNKNOWN && (a === b || a.node && a.node === b.node && samePath(a.path, b.path))
  const current = (name, then, now, guard) => !writesLocal(guard, name) && same(latest(name, then), latest(name, now))
  const valid = (node, path, now, guard, budget) => {
    if (!arr(node) || --budget[0] < 0) return false
    const op = node[0]
    if (op === 'local.get') return current(node[1], path, now, guard)
    if (op === 'local.tee') {
      const d = latest(node[1], now)
      if (d.node !== node || !samePath(d.path, [...path, node[2]])) return false
    }
    if (op !== 'local.tee' && op !== 'select' && !/^(?:i32|i64|f32|f64)\.(?!load|store)/.test(op)) return false
    for (let i = 1; i < node.length; i++) if (arr(node[i]) && !valid(node[i], [...path, node[i]], now, guard, budget)) return false
    return true
  }
  return {
    get(name, path) { const d = latest(name, path); return d === ENTRY || d === UNKNOWN ? null : d },
    saved(name, now, guard) {
      const d = latest(name, now)
      if (d === ENTRY || d === UNKNOWN) return null
      if (d.guard !== guard || !samePath(d.now, now)) {
        d.guard = guard; d.now = now.slice()
        d.valid = valid(d.value, d.path, now, guard, [64])
      }
      return d.valid ? d : null
    },
    current,
    holds(node, now, path) { const d = latest(node[1], now); return d.node === node && samePath(d.path, [...path, node[2]]) },
  }
}
