/**
 * The custom sections the interop layer reads back, built after treeshake so
 * they describe only what survived: `jz:schema` (the property lists of the
 * schemas some surviving node or named use still references; a dead schema
 * keeps its slot, shrunk to its id, so ids stay stable) and `jz:errcls` (the
 * error class name per surviving error schema).
 *
 * @module link/sections
 */
import { T, NONE, intern, text, walk, push, node, str, bytes } from '../ir/tape.js'

const utf8 = new TextEncoder()
const varint = (out, n) => { while (n >= 0x80) { out.push((n & 0x7F) | 0x80); n >>>= 7 } out.push(n) }
const encStr = (out, s) => { const b = utf8.encode(s); varint(out, b.length); for (const x of b) out.push(x) }
// A schema property: null, a `[tag, inner]` pair, or a name.
const encProp = (out, p) => {
  if (p === null) out.push(0)
  else if (Array.isArray(p)) { out.push(1); encProp(out, p[1]) }
  // JSON escaping preserves lone surrogates over the UTF-8 metadata boundary.
  // Length framing already delimits the string, so omit JSON's outer quotes.
  else { out.push(3); encStr(out, JSON.stringify(p).slice(1, -1)) }
}

export function schemaSections(root, { schemas, namedUses, errorSids }) {
  const FUNC = intern('func')
  const used = new Set()
  walk(root, (id) => { if (T.sid[id] !== NONE) used.add(T.sid[id]) })
  if (namedUses.length) {
    const names = new Set()
    for (let c = T.a[root]; c !== NONE; c = T.next[c]) if (T.op[c] === FUNC) { const name = text(T.a[c]); if (name !== null) names.add(name) }
    for (const { sid, funcName } of namedUses) if (names.has('$' + funcName)) used.add(sid)
  }
  const custom = (name, payload) => { const c = push(root, node(intern('@custom'))); push(c, str(`"${name}"`)); push(c, bytes(payload)) }
  if (used.size) {
    const out = []
    varint(out, schemas.length)
    schemas.forEach((props, id) => {
      const live = used.has(id) ? props : [String(id)]
      varint(out, live.length)
      for (const p of live) encProp(out, p)
    })
    custom('jz:schema', out)
  }
  const entries = errorSids.filter(([sid]) => used.has(sid))
  if (entries.length) {
    const out = []
    varint(out, entries.length)
    for (const [sid, name] of entries) { varint(out, sid); encStr(out, name) }
    custom('jz:errcls', out)
  }
}
