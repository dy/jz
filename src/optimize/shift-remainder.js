// A remainder rebuilt from its quotient is a mask.
//
//   const q = (x / 65536) | 0          (local.set $q (i32.shr_u (local.get $x) (i32.const 16)))
//   const r = x - q * 65536            (i32.sub (local.get $x) (i32.shl (local.get $q) (i32.const 16)))
//
// The integer and fraction split of a fixed-point value: the quotient indexes,
// the remainder interpolates. Shifting `x` right by k and back left clears its
// low k bits, whichever shift made the quotient (an arithmetic shift keeps the
// bits above), so what the subtraction leaves is those bits: `x & (2^k - 1)`.
// One operation for three, and the remainder no longer waits for the quotient.
//
// The pass walks a function in evaluation order and keeps, per local, the
// quotient it holds: `q = x >> k` from the write that made it until `q` or `x`
// is written again. Control flow ends every fact: at the head of a loop or a
// handler, and after any construct a branch may leave early. The arms of an
// `if` each start from what held after its condition.

import { typed } from '../ir.js'

const isArr = Array.isArray
const constOf = n => isArr(n) && n[0] === 'i32.const' && Number.isInteger(Number(n[1])) ? Number(n[1]) | 0 : null
const localOf = n => isArr(n) && n.length === 2 && n[0] === 'local.get' && typeof n[1] === 'string' ? n[1] : null
// The local an operand leaves its value in: read, or written by a tee.
const holderOf = n => isArr(n) && (n[0] === 'local.get' && n.length === 2 || n[0] === 'local.tee' && n.length === 3) && typeof n[1] === 'string' ? n[1] : null

/** `Q << k` or `Q * 2^k` as [Q, k], or null. */
const scaled = n => {
  if (!isArr(n) || n.length !== 3) return null
  const c = constOf(n[2])
  if (c == null) return null
  if (n[0] === 'i32.shl') return c > 0 && c < 32 ? [n[1], c] : null
  if (n[0] !== 'i32.mul') return null
  const u = c >>> 0
  return u > 1 && (u & (u - 1)) === 0 ? [n[1], 31 - Math.clz32(u)] : null
}
/** `x >> k` of a local read as { x, k }, or null. */
const quotient = n => {
  if (!isArr(n) || n.length !== 3 || n[0] !== 'i32.shr_u' && n[0] !== 'i32.shr_s') return null
  const x = localOf(n[1]), k = constOf(n[2])
  return x != null && k != null && k > 0 && k < 32 ? { x, k } : null
}
const mask = k => ['i32.const', k === 31 ? 0x7fffffff : (1 << k) - 1]

// Constructs that join paths: a block straight into, the others from a branch too.
const CONTROL = new Set(['block', 'loop', 'try', 'try_table', 'catch', 'catch_all', 'do', 'delegate'])

export function foldShiftRemainder(fn) {
  if (!isArr(fn) || fn[0] !== 'func') return
  const quot = new Map()   // q → { x, k }: local q holds x >> k
  const forget = name => { quot.delete(name); for (const [q, f] of quot) if (f.x === name) quot.delete(q) }
  const visit = node => {
    if (!isArr(node)) return node
    const op = node[0]
    if (op === 'if') {
      let held = null
      for (let i = 1; i < node.length; i++) {
        const arm = isArr(node[i]) && (node[i][0] === 'then' || node[i][0] === 'else')
        if (arm) { held ??= new Map(quot); quot.clear(); for (const [q, f] of held) quot.set(q, f) }
        node[i] = visit(node[i])
      }
      quot.clear()
      return node
    }
    const control = CONTROL.has(op)
    if (control && op !== 'block') quot.clear()
    for (let i = 1; i < node.length; i++) node[i] = visit(node[i])
    if (control) { quot.clear(); return node }
    if ((op === 'local.set' || op === 'local.tee') && typeof node[1] === 'string') {
      forget(node[1])
      const v = node[2]
      if (isArr(v) && v.length === 3 && (v[0] === 'i32.shr_u' || v[0] === 'i32.shr_s')) {
        const x = holderOf(v[1]), k = constOf(v[2])
        if (x != null && x !== node[1] && k != null && k > 0 && k < 32) quot.set(node[1], { x, k })
      }
      return node
    }
    if (op === 'i32.sub' && node.length === 3) {
      const s = scaled(node[2])
      if (!s) return node
      // the quotient in a local, or computed in place from the value the left operand left
      const q = localOf(s[0]), f = q != null ? quot.get(q) : quotient(s[0])
      const x = q != null ? localOf(node[1]) : holderOf(node[1])
      if (x != null && f && f.x === x && f.k === s[1]) return typed(['i32.and', node[1], mask(f.k)], 'i32')
    }
    return node
  }
  for (let i = 1; i < fn.length; i++) fn[i] = visit(fn[i])
}
