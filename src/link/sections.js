/**
 * The custom sections the interop layer reads back, built after treeshake so
 * they describe only what survived: `jz:schema` (the property lists of the
 * schemas some surviving node or named use still references; a dead schema
 * keeps its slot, shrunk to its id, so ids stay stable), `jz:errcls` (the
 * error class name per surviving error schema), `jz:brand` (the class brand
 * per surviving user-class schema) and `jz:views` (the surviving schemas with
 * an object literal's accessor).
 *
 * @module link/sections
 */
import { T, NONE, intern, text, walk, push, node, str, num, bytes } from '../ir/tape.js'

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

export function schemaSections(root, { schemas, fieldContracts, namedUses, errorSids, brandSids, viewSids }) {
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
    if (fieldContracts) {
      const fields = []
      varint(fields, schemas.length)
      for (let sid = 0; sid < schemas.length; sid++) {
        const row = used.has(sid) ? fieldContracts[sid] : []
        varint(fields, row.length)
        for (const [mask, detail, integer, value] of row) {
          // The low three bits mark optional refinements; ordinary tagged
          // fields need only their family mask.
          varint(fields, mask * 8 + (detail >= 0 ? 1 : 0) + (integer ? 2 : 0) + (value != null ? 4 : 0))
          if (detail >= 0) varint(fields, detail)
          if (integer) varint(fields, integer)
          if (value != null) encStr(fields, String(value))
        }
      }
      custom('jz:fields', fields)
    }
  }
  const entries = errorSids.filter(([sid]) => used.has(sid))
  if (entries.length) {
    const out = []
    varint(out, entries.length)
    for (const [sid, name] of entries) { varint(out, sid); encStr(out, name) }
    custom('jz:errcls', out)
  }
  // A user class's schema is its field list salted with the class's brand
  // (module/schema.js): the brand travels with it, so interop keeps two
  // classes of one field list apart.
  const brands = (brandSids ?? []).filter(([sid]) => used.has(sid))
  if (brands.length) {
    const out = []
    varint(out, brands.length)
    for (const [sid, brand] of brands) { varint(out, sid); encStr(out, brand) }
    custom('jz:brand', out)
  }
  // A layout with an object literal's accessor (src/ast.js layoutView): the
  // host decodes such an object through the data copy the module exports.
  const views = (viewSids ?? []).filter(sid => used.has(sid))
  if (views.length) {
    const out = []
    varint(out, views.length)
    for (const sid of views) varint(out, sid)
    custom('jz:views', out)
  }
}

/** `jz:release`: the exports whose calls keep nothing they allocate or are
 *  handed (optimize/arena-rewind.js), so the host may rewind the heap to where
 *  it stood before it copied their arguments in (interop.js); `flag` names
 *  those whose frames may run an escape, released only when the call left
 *  the escape flag at or above that mark: the module then exports the flag
 *  as `__esc`; `host` those that allocate and release nothing by themselves.
 *  A call of any other whose arguments are all numbers leaves the host
 *  nothing to release, and crosses as it is. A module that asks stored values whether a running call made
 *  them exports `__base`, which sets the outermost frame's mark: the host
 *  clears it where a call begins (a call an exception left did not restore
 *  it) and sets it to its own mark around a flagged one. A function, not the
 *  global: its write keeps the global mutable where no frame of the module
 *  writes it (watr takes a global nothing writes for a constant). The host
 *  `__base` answers the mark it replaced, which the host puts back where it
 *  is the older (a frame of the module that called the host, which called
 *  back) and as the call returns. Where it replaced none, the host is the
 *  outermost reader, and the log of what the call's escapes write into
 *  starts empty (module/core/reach.js; the walk from it, `__survive`, is
 *  exported by optimize/arena-rewind.js).
 *  `exportInner` maps each export name to the function its wrapper calls. */
export function releaseSection(root, { releasable, flagged: conditional, rewound, allocates }, exportInner, asked) {
  const GLOBAL = intern('global'), FUNC = intern('func'), declared = new Set()
  for (let c = T.a[root]; c !== NONE; c = T.next[c]) if (T.op[c] === GLOBAL || T.op[c] === FUNC) declared.add(text(T.a[c]))
  if (declared.has('$__base')) {
    // (func (param $mark i32) (result i32) (local $was i32)
    //   was = base; [if was == -1: the log starts empty]; base = mark; was)
    const get = (kind, name) => { const g = node(intern(kind)); push(g, str(name)); return g }
    const set = (kind, name, value) => { const s = node(intern(kind)); push(s, str(name)); push(s, value); return s }
    const f = push(root, node(FUNC))
    push(f, str('$__base$set'))
    push(push(f, node(intern('export'))), str('"__base"'))
    const p = push(f, node(intern('param'))); push(p, str('$mark')); push(p, str('i32'))
    push(push(f, node(intern('result'))), str('i32'))
    const l = push(f, node(intern('local'))); push(l, str('$was')); push(l, str('i32'))
    push(f, set('local.set', '$was', get('global.get', '$__base')))
    if (declared.has('$__root_reset') || declared.has('$__esc_low')) {
      // no frame read the flag: the log of what the escapes write into starts empty, the lowest flag clear
      const none = node(intern('i32.eq')); push(none, get('local.get', '$was')); push(push(none, node(intern('i32.const'))), num(-1))
      const iff = push(f, node(intern('if'))); push(iff, none)
      const then = push(iff, node(intern('then')))
      if (declared.has('$__root_reset')) push(then, get('call', '$__root_reset'))
      if (declared.has('$__esc_low')) { const clear = node(intern('i32.const')); push(clear, num(-1)); push(then, set('global.set', '$__esc_low', clear)) }
    }
    push(f, set('global.set', '$__base', get('local.get', '$mark')))
    push(f, get('local.get', '$was'))
  }
  // `host`: those of them whose frame gives back nothing by itself (no rewind
  // at this level) though it allocates: the host's release is the only one.
  // `ask`: those that allocate and whose result may be a heap value: the
  // frame keeps what it made where the result names it, and the host, which
  // takes a copy of a string, an array or an object, releases it then.
  const release = [], flag = [], host = [], ask = []
  for (const [name, inner] of exportInner) if (releasable.has(inner)) {
    release.push(name)
    if (conditional?.has(inner)) flag.push(name)
    if (allocates(inner) && !rewound.has(inner)) host.push(name)
    if (asked?.has(inner) && allocates(inner)) ask.push(name)
  }
  if (!release.length) return
  const c = push(root, node(intern('@custom')))
  push(c, str('"jz:release"'))
  push(c, bytes([...utf8.encode(JSON.stringify({ release, ...(flag.length && { flag }), ...(host.length && { host }), ...(ask.length && { ask }) }))]))
  if (flag.length && declared.has('$__esc')) {
    const e = push(root, node(intern('export')))
    push(e, str('"__esc"'))
    push(push(e, node(GLOBAL)), str('$__esc'))
  }
}
