/**
 * Destructuring-pattern predicates (isDestructPattern/patternItems/
 * simpleArrayPatternItems/arrayLiteralItems) plus the substPattern <-> substObjItem
 * mutual recursion (expand a pattern / handle one object-pattern item, which recurses
 * into nested sub-patterns) — ordinary intra-file recursion, contained in this module.
 *
 * @module prepare/destructure
 */

import { substIdents } from './scope.js'


export const isDestructPattern = (node) => Array.isArray(node) && (node[0] === '[]' || node[0] === '{}')

// `,` is the ordinary pattern separator; `;` appears when a `{…}` pattern parsed
// in STATEMENT position (for-of head cover grammar: `for ({ x = 1 } of …)`) —
// same items, block-shaped node.
export const patternItems = (node) => (node?.[0] === ',' || node?.[0] === ';') ? node.slice(1) : [node]

export const simpleArrayPatternItems = (pattern) => {
  if (!Array.isArray(pattern) || pattern[0] !== '[]' || pattern.length !== 2) return null
  const items = patternItems(pattern[1])
  return items.every(item => typeof item === 'string') ? items : null
}

export const arrayLiteralItems = (expr) => {
  if (!Array.isArray(expr) || expr[0] !== '[]' || expr.length !== 2) return null
  if (expr[1] == null) return []
  const items = patternItems(expr[1])
  return items.every(item => item != null && !(Array.isArray(item) && item[0] === '...')) ? items : null
}

/** Rename BINDING positions of a destructure pattern per `map`, preserving
 *  property keys: `{x}` shorthand becomes `{x: x@1}` (the key stays the source
 *  prop name), `{k: v}` keys stay, defaults rename by ordinary ident rules
 *  (a default may reference a sibling pattern binding — `{a, b = a}`).
 *  Object items need their OWN walk: the parser comma-groups multi-prop
 *  patterns (`['{}', [',', 'a', 'b']]`), and a bare string INSIDE an object
 *  pattern is shorthand (its spelling IS the property key) while inside an
 *  array pattern it is a plain target — renaming a shorthand string directly
 *  turned `{a}` into `{a@1}` and read a nonexistent property. */
export function substPattern(p, map) {
  if (typeof p === 'string') return map.get(p) ?? p
  if (!Array.isArray(p)) return p
  if (p[0] === '{}') return ['{}', ...p.slice(1).map(it => substObjItem(it, map))]
  if (p[0] === ':') return [':', p[1], substPattern(p[2], map)]
  if (p[0] === '...') return ['...', substPattern(p[1], map)]
  if (p[0] === '=') return ['=', substPattern(p[1], map), substIdents(p[2], map)]
  if (p[0] === '[]' || p[0] === ',') return [p[0], ...p.slice(1).map(it => substPattern(it, map))]
  return p
}

function substObjItem(it, map) {
  if (typeof it === 'string') return map.has(it) ? [':', it, map.get(it)] : it
  if (!Array.isArray(it)) return it
  if (it[0] === ',') return [',', ...it.slice(1).map(x => substObjItem(x, map))]
  if (it[0] === ':') return [':', it[1], substPattern(it[2], map)]
  // shorthand-with-default `{ a = 1 }` — expand to keyed form so the key
  // keeps the source spelling while the target renames
  if (it[0] === '=' && typeof it[1] === 'string')
    return map.has(it[1]) ? [':', it[1], ['=', map.get(it[1]), substIdents(it[2], map)]]
      : ['=', it[1], substIdents(it[2], map)]
  if (it[0] === '...') return ['...', substPattern(it[1], map)]
  return substPattern(it, map)
}