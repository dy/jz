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
import { T, NONE, OP_NUM, intern, text, walk, push, node, str, num, bytes } from '../ir/tape.js'
import { PTR, LAYOUT, decodePtrType, decodePtrAux } from '../../layout.js'

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

// The high word of a 64-bit constant written in hex (`0x…`, `nan:0x…`, sixteen digits), -1 for any other text.
const hiWord = (s) => {
  if (s === null) return -1
  const at = s.startsWith('nan:') ? 4 : 0
  if (s.length !== at + 18 || s[at] !== '0' || (s[at + 1] !== 'x' && s[at + 1] !== 'X')) return -1
  const hi = parseInt(s.slice(at + 2, at + 10), 16)
  return hi === hi ? hi : -1
}
// A literal i32 operand's number, -1 where the node is none.
const literal = (n, I32) => n === NONE || T.op[n] !== I32 || T.a[n] === NONE ? -1 : T.op[T.a[n]] === OP_NUM ? T.imm[T.a[n]] : +(text(T.a[n]) ?? -1)
// The schema an object's pointer is made with, read off the node that makes it (ir/pointers.js
// mkPtrIR and boxPtrIR, the two places one is made): `$__mkptr` of a literal OBJECT type and
// schema, the helper specialized for the pair (optimize/specialize-mkptr.js,
// `$__mkptr_<type>_<schema>…`), and a constant whose high word is an object pointer's: the
// folded pointer, and a re-boxing's prefix, the i64 an `i64.or` joins with the offset (the same
// i64 under a comparison is a test of a value's schema, which makes nothing). The emitter also
// marks such a node (`sid`), and a pass that rebuilds one loses the mark (a loop's copy,
// optimize/wide-accumulator.js): its operands stay. -1 where the node makes none.
const madeSid = (id, parent, CALL, I32, I64, F64, OR) => {
  const op = T.op[id], a = T.a[id]
  if (op === I64 || op === F64) {
    if (op === I64 && (parent === NONE || T.op[parent] !== OR)) return -1
    const hi = a === NONE ? -1 : hiWord(text(a))
    return hi >= 0 && hi >>> 19 === LAYOUT.NAN_PREFIX >>> 3 && decodePtrType(hi) === PTR.OBJECT ? decodePtrAux(hi) : -1
  }
  if (op !== CALL || a === NONE) return -1
  const callee = text(a)
  if (callee === null || !callee.startsWith('$__mkptr')) return -1
  if (callee === '$__mkptr') { const type = T.next[a]; return literal(type, I32) === PTR.OBJECT ? literal(T.next[type], I32) : -1 }
  const parts = callee.split('_')   // ['$', '', 'mkptr', type, schema, …]
  return parts.length > 4 && +parts[3] === PTR.OBJECT && +parts[4] === +parts[4] ? +parts[4] : -1
}

export function schemaSections(root, { schemas, fieldContracts, namedUses, errorSids, brandSids, regexSids, viewSids, hostObjects = true }) {
  const FUNC = intern('func'), CALL = intern('call'), I32 = intern('i32.const'), I64 = intern('i64.const'), F64 = intern('f64.const'), OR = intern('i64.or')
  const used = new Set()
  walk(root, (id, parent) => { const sid = T.sid[id] !== NONE ? T.sid[id] : madeSid(id, parent, CALL, I32, I64, F64, OR); if (sid >= 0) used.add(sid) })
  if (namedUses.length) {
    const names = new Set()
    for (let c = T.a[root]; c !== NONE; c = T.next[c]) if (T.op[c] === FUNC) { const name = text(T.a[c]); if (name !== null) names.add(name) }
    for (const { sid, funcName } of namedUses) if (names.has('$' + funcName)) used.add(sid)
  }
  // (no object of the program reaches the host: its decoder reads an Error's layout alone, compile/func-exports.js hostReadsObjects)
  if (!hostObjects) { const errors = new Set(errorSids.map(([sid]) => sid)); for (const sid of [...used]) if (!errors.has(sid)) used.delete(sid) }
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
    // (the host hands in no object to lay out by a field's contract)
    if (fieldContracts && hostObjects) {
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
  const regexes = (regexSids ?? []).filter(([sid]) => used.has(sid))
  if (regexes.length) {
    const out = []
    varint(out, regexes.length)
    for (const [sid, [pattern, flags]] of regexes) { varint(out, sid); encStr(out, JSON.stringify(pattern)); encStr(out, flags) }
    custom('jz:regexp', out)
  }
  // A layout with an object literal's accessor (src/ast.js layoutView): the
  // host decodes such an object through the data copy the module exports.
  const views = (viewSids ?? []).filter(sid => used.has(sid))
  if (views.length && hostObjects) {
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
export function releaseSection(root, { releasable, flagged: conditional, rewound, allocates }, exportInner, asked, numberResult) {
  const GLOBAL = intern('global'), FUNC = intern('func'), GLOBAL_SET = intern('global.set'), declared = new Set()
  for (let c = T.a[root]; c !== NONE; c = T.next[c]) if (T.op[c] === GLOBAL || T.op[c] === FUNC) declared.add(text(T.a[c]))
  // The mark leaves all ones only where a frame of the module saves its own or
  // the host sets it around a flagged export's call: with neither, every read
  // of it (the compaction's reset among them) reads all ones, and no setter
  // keeps the global mutable for watr to fold.
  let setsMark = false
  if (declared.has('$__base')) {
    for (const [, inner] of exportInner) if (releasable.has(inner) && conditional?.has(inner)) { setsMark = true; break }
    if (!setsMark) walk(root, id => { if (setsMark) return false; if (T.op[id] === GLOBAL_SET && text(T.a[id]) === '$__base') setsMark = true })
  }
  if (setsMark) {
    // (func (param $mark i32) (result i32) (local $was i32)
    //   was = base; [if was == -1: the log starts empty]; base = mark; was)
    const get = (kind, name) => { const g = node(intern(kind)); push(g, str(name)); return g }
    const set = (kind, name, value) => { const s = node(intern(kind)); push(s, str(name)); push(s, value); return s }
    const f = push(root, node(FUNC))
    push(f, str('$__base$set'))
    push(push(f, node(intern('export'))), str('"__jz_base"'))
    const p = push(f, node(intern('param'))); push(p, str('$mark')); push(p, str('i32'))
    push(push(f, node(intern('result'))), str('i32'))
    const l = push(f, node(intern('local'))); push(l, str('$was')); push(l, str('i32'))
    push(f, set('local.set', '$was', get('global.get', '$__base')))
    if (declared.has('$__root_reset') || declared.has('$__esc_low') || declared.has('$__stubn') || declared.has('$__ibase')) {
      // no frame read the flag: the log of what the escapes write into starts empty, the lowest flag clear,
      // the stub log empty (module/core/compact.js), no loop's floor raised (module/core/reach.js `__iter_release`)
      const none = node(intern('i32.eq')); push(none, get('local.get', '$was')); push(push(none, node(intern('i32.const'))), num(-1))
      const iff = push(f, node(intern('if'))); push(iff, none)
      const then = push(iff, node(intern('then')))
      if (declared.has('$__root_reset')) push(then, get('call', '$__root_reset'))
      if (declared.has('$__esc_low')) { const clear = node(intern('i32.const')); push(clear, num(-1)); push(then, set('global.set', '$__esc_low', clear)) }
      if (declared.has('$__stubn')) { const zero = node(intern('i32.const')); push(zero, num(0)); push(then, set('global.set', '$__stubn', zero)) }
      if (declared.has('$__stub_lost')) { const none = node(intern('i32.const')); push(none, num(-1)); push(then, set('global.set', '$__stub_lost', none)) }
      if (declared.has('$__ibase')) { const zero = node(intern('i32.const')); push(zero, num(0)); push(then, set('global.set', '$__ibase', zero)) }
    }
    push(f, set('global.set', '$__base', get('local.get', '$mark')))
    push(f, get('local.get', '$was'))
  }
  // `host`: those of them whose frame gives back nothing by itself (no rewind
  // at this level) though it allocates: the host's release is the only one.
  // `ask`: those that allocate and whose result may be a heap value: the
  // frame keeps what it made where the result names it, and the host, which
  // takes a copy of a string, an array or an object, releases it then.
  const release = [], flag = [], host = [], ask = [], number = []
  for (const [name, inner] of exportInner) if (releasable.has(inner)) {
    release.push(name)
    if (numberResult?.has(inner)) number.push(name)
    if (conditional?.has(inner)) flag.push(name)
    if (allocates(inner) && !rewound.has(inner)) host.push(name)
    if (asked?.has(inner) && allocates(inner)) ask.push(name)
  }
  if (!release.length) return
  const c = push(root, node(intern('@custom')))
  push(c, str('"jz:release"'))
  push(c, bytes([...utf8.encode(JSON.stringify({ release, ...(flag.length && { flag }), ...(host.length && { host }), ...(ask.length && { ask }), ...(number.length && { number }) }))]))
  if (flag.length && declared.has('$__esc')) {
    const e = push(root, node(intern('export')))
    push(e, str('"__jz_esc"'))
    push(push(e, node(GLOBAL)), str('$__esc'))
  }
}
