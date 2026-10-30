/**
 * A byte array made for a read, and read only where the read wrote, is made
 * without its zero fill. `const tmp = new Uint8Array(n)`, `const r =
 * fs.readSync(fd, tmp, 0, k)` (or `{ offset: 0, … }`, or no offset), then
 * `tmp[i]` only in a loop that counts `i` up by one from a literal of zero or
 * more while `i < r`: the read wrote
 * `tmp[0 .. r)` before any such element is read, so no read sees a zero JS
 * would have put there. A buffer a read loop makes each pass then costs the
 * bytes the read moved rather than the bytes it asked for: a host reading a
 * pipe 1 KiB at a time into `new Uint8Array(remaining)` filled the remaining
 * megabyte with zeros at every read.
 *
 * Every mention of the array must be one of: its declaration, `.length` or
 * `.byteLength`, the buffer of an `fs.readSync` at offset 0 (or none), or an
 * element read so bounded; any other (a write, a call it is passed to, a
 * closure, a return) keeps the fill. The bound is a `const` the read declares,
 * in a statement list ahead of the loop; the counter is written by its
 * declarations and by `i = i + 1`, `i += 1` or `++` alone, the step being the
 * loop body's last statement (a `for` loop's step) with the element read ahead
 * of it, so `0 ≤ i < r` holds at the read. Runs after inlining, which puts the
 * read beside the array (a helper given the array reads into it), and before
 * the loop passes rewrite the counter and its bound.
 *
 * The array's declarator carries the decision (`noFill` on its constructor
 * call), read by emitDecl and the typed array constructor (module/typedarray.js).
 *
 * @module compile/plan/read-buffers
 */
import { ctx } from '../../ctx.js'
import { MUTATE_OPS } from '../../ast.js'

const BYTE_CTORS = new Set(['new.Uint8Array', 'new.Int8Array', 'new.Uint8ClampedArray'])
const lit = (n) => Array.isArray(n) && n[0] == null && typeof n[1] === 'number' ? n[1] : null
const isStep = (s, i) => Array.isArray(s) && (
  s[0] === '=' && s[1] === i && Array.isArray(s[2]) && s[2][0] === '+' && (s[2][1] === i && lit(s[2][2]) === 1 || s[2][2] === i && lit(s[2][1]) === 1) ||
  s[0] === '+=' && s[1] === i && lit(s[2]) === 1 ||
  s[0] === '++' && s[1] === i ||
  s[0] === 'postfix' && Array.isArray(s[1]) && s[1][0] === '++' && s[1][1] === i)
const zero = (n) => lit(n) === 0 && !Object.is(lit(n), -0)
// an options literal's entries (module/fs.js optionItems), and a plain or quoted key's name
const entries = (o) => o.length === 2 && Array.isArray(o[1]) && o[1][0] === ',' ? o[1].slice(1) : o.slice(1)
const keyOf = (k) => typeof k === 'string' ? k : Array.isArray(k) && k[0] === 'str' && typeof k[1] === 'string' ? k[1] : null
// `fs.readSync(fd, buf)`, `(fd, buf, 0, …)` or `(fd, buf, { offset: 0, … })`: the read writes
// the buffer from its first byte (`args` the call's `,` list)
const atZero = (args) => args.length === 3 || zero(args[3]) || args.length === 4 && Array.isArray(args[3]) && args[3][0] === '{}' &&
  entries(args[3]).every(p => Array.isArray(p) && p[0] === ':' && keyOf(p[1]) != null && (keyOf(p[1]) !== 'offset' || zero(p[2])))
// a statement list: `;`'s items, or a block's
const items = (n) => !Array.isArray(n) ? null : n[0] === ';' ? n : n[0] === '{}' && Array.isArray(n[1]) && n[1][0] === ';' ? n[1] : null

/** Each mention of a name in `node`, with the chain of nodes above it: `fn(node, at, path)`,
 *  `node[at]` the name. Property keys and string literals are no mentions. */
const mentions = (node, fn, path = []) => {
  if (!Array.isArray(node) || node[0] === 'str' || node[0] == null) return
  path.push(node)
  for (let k = 1; k < node.length; k++) {
    if ((node[0] === '.' || node[0] === '?.') && k === 2) continue
    const c = node[k]
    if (typeof c === 'string') fn(node, k, path)
    else mentions(c, fn, path)
  }
  path.pop()
}

const bufferIn = (body) => {
  // the candidates: `const NAME = new Uint8Array(len)`, one argument
  const decls = new Map()
  mentions(body, (n, k) => {
    if (n[0] !== '=' || k !== 1) return
    const init = n[2]
    if (!Array.isArray(init) || init[0] !== '()' || !BYTE_CTORS.has(init[1]) || init[2] == null || Array.isArray(init[2]) && init[2][0] === ',') return
    decls.set(n[1], decls.has(n[1]) ? null : n)
  })
  for (const [name, d] of decls) if (!d) decls.delete(name)
  if (!decls.size) return 0
  const consts = new Set()
  mentions(body, (n, k, path) => {
    if (n[0] === '=' && k === 1 && path.at(-2)?.[0] === 'const') consts.add(n)
  })
  for (const d of decls.values()) if (!consts.has(d)) decls.delete(d[1])
  // a name's writes: declarators and mutations, each with the chain above it
  const writes = new Map(), inClosure = new Set()
  mentions(body, (n, k, path) => {
    const name = n[k]
    if (path.some(p => p[0] === '=>')) inClosure.add(name)
    if (k === 1 && MUTATE_OPS.has(n[0])) (writes.get(name) ?? writes.set(name, []).get(name)).push([n, [...path]])
  })
  // a counter `0 ≤ i` throughout: declared or set to a whole literal of zero or more, else stepped up by one
  const start = (w, path) => w[0] === '=' && (path.at(-2)?.[0] === 'let' || path.at(-2)?.[0] === 'for') &&
    Number.isInteger(lit(w[2])) && lit(w[2]) >= 0 && !Object.is(lit(w[2]), -0)
  const upward = (i) => !inClosure.has(i) && (writes.get(i) ?? []).every(([w, path]) => start(w, path) || isStep(w, i) || isStep(path.at(-2), i))
  let marked = 0
  for (const [name, decl] of decls) {
    if (inClosure.has(name)) continue
    // the reads' bounds: a `const` an `fs.readSync` into the array at offset 0 declares, with where it stands
    const bounds = new Map()
    let ok = true
    const reads = []
    mentions(body, (n, k, path) => {
      if (!ok || n[k] !== name) return
      if (n === decl) return
      if (n[0] === '.' && k === 1 && (n[2] === 'length' || n[2] === 'byteLength') && !(MUTATE_OPS.has(path.at(-2)?.[0]) && path.at(-2)[1] === n)) return
      if (n[0] === ',' && k === 2 && path.at(-2)?.[0] === '()' && path.at(-2)[1] === 'fs.readSync' && path.at(-2)[2] === n && atZero(n)) {
        const call = path.at(-2), d = path.at(-3), list = path.at(-5), stmt = path.at(-4)
        if (d?.[0] === '=' && d[2] === call && typeof d[1] === 'string' && consts.has(d) && items(list) && stmt?.[0] === 'const')
          bounds.set(d[1], { list: items(list), at: items(list).indexOf(stmt) })
        return
      }
      if (n[0] === '[]' && k === 1 && !(MUTATE_OPS.has(path.at(-2)?.[0]) && path.at(-2)[1] === n)) { reads.push([n, [...path]]); return }
      ok = false
    })
    if (!ok) continue
    const covered = ([n, path]) => {
      const i = n[2]
      if (typeof i !== 'string' || !upward(i)) return false
      // the loop nearest the read, no closure between
      let li = path.length - 1
      while (li >= 0 && path[li][0] !== 'while' && path[li][0] !== 'for') { if (path[li][0] === '=>') return false; li-- }
      if (li < 0) return false
      // `while (test) body`, `for (test; ; ) body` as the 3-element `for`, or `for (init; test; step) body`
      const loop = path[li], isFor = loop[0] === 'for' && loop.length === 5
      const cond = isFor ? loop[2] : loop[1], bodyNode = isFor ? loop[4] : loop[2]
      if (!Array.isArray(cond) || cond[0] !== '<' || cond[1] !== i || typeof cond[2] !== 'string') return false
      const b = bounds.get(cond[2])
      // the bound is declared ahead of the loop, in a list holding it
      if (!b) return false
      const bi = path.indexOf(b.list)
      if (bi < 0 || bi >= li || b.list.indexOf(path[bi + 1]) <= b.at) return false
      if (path[li + 1] !== bodyNode) return false   // the read is in the body, not the test or the step
      // inside the loop the counter is written only by a `for`'s init and step, or
      // by a step that is the body's last statement: from the test to the read it holds
      const list = items(bodyNode), last = list ? list[list.length - 1] : null
      for (const [w, wpath] of writes.get(i) ?? []) {
        if (!wpath.includes(loop)) continue
        if (isFor && (wpath.includes(loop[1]) || wpath.includes(loop[3]))) continue
        if (last && (w === last || wpath.includes(last)) && isStep(last, i)) continue
        return false
      }
      return true
    }
    if (!reads.every(covered)) continue
    decl[2].noFill = true
    marked++
  }
  return marked
}

/** Plan pass: mark each function's read buffers. Changes no program; returns the count. */
export const markReadBuffers = () => {
  let n = 0
  for (const func of ctx.funcs.list) if (!func.raw && func.body) n += bufferIn(func.body)
  return n
}
