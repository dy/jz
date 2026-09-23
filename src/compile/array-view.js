/**
 * Array slice views: a binding defined once by an expression with a
 * `.slice(…)` arm and read only as a spread source keeps the sliced array and
 * a range instead of a copy.
 *
 *     items = b[0] === ';' ? b.slice(1) : [b]
 *     return … [';', a, ...items]        // copies b[1..] straight in
 *
 * The definition holds, in the binding's own local, the receiver of an array
 * slice together with a start and a count (two i32 locals); any other
 * receiver, and any other arm, takes its ordinary value with count -1. A
 * spread that copies through `emitSpreadCopy` reads the range; any other read
 * of the binding materializes it.
 *
 * Applies when:
 *   - the binding is written once, by a statement `x = D` or `let x = D` of a
 *     statement list, and D has a slice arm (through `?:`) whose arguments
 *     are number literals or names;
 *   - every other occurrence of the binding is a spread `...x` in an array
 *     literal or a call's arguments, in a later statement of that list, and
 *     none is inside a nested function;
 *   - nothing between the definition and each spread can mutate an array:
 *     the statements between are inert, and so is whatever the spread's
 *     statement evaluates before it (literals, names, `===`, `!==`, `!`,
 *     `typeof`, `?:`, `&&`, `||`, `??`, sequences, declarations and writes
 *     of locals, and member reads with a static key no accessor in the
 *     program is named by).
 * The emitter keeps the ordinary binding where the local is not a plain f64.
 *
 * @module compile/array-view
 */
import { ctx, PTR, inc } from '../ctx.js'
import { walkAst, commaList } from '../ast.js'
import { typed, temp, tempI32, asF64, allocPtr, isGlobal, toNumF64 } from '../ir.js'

const isArr = Array.isArray

/** `R.slice(args)` with at most two literal-or-name arguments: [R, args] or null. */
const sliceArm = (e) => {
  if (!isArr(e) || e[0] !== '()' || !isArr(e[1]) || e[1][0] !== '.' || e[1][2] !== 'slice') return null
  const args = e.length > 2 && e[2] != null ? commaList(e[2]) : []
  if (args.length > 2 || !args.every(a => typeof a === 'string' || (isArr(a) && a[0] == null && typeof a[1] === 'number'))) return null
  return [e[1][1], args]
}
const hasSliceArm = (e) => !!sliceArm(e) || (isArr(e) && e[0] === '?:' && (hasSliceArm(e[2]) || hasSliceArm(e[3])))

// Evaluation-order walk: FOUND reaches the target with only inert code before
// it; EFFECT runs something else first; INERT and DIRTY leave the target out,
// with no effect or with one.
const FOUND = 1, EFFECT = 2, INERT = 3, DIRTY = 4
const LITERALS = new Set(['str', 'regex'])
const SEQUENTIAL = new Set(['&&', '||', '??', ',', '===', '!==', '!', 'typeof', 'void', '['])

/** Where `target` sits in `n` relative to the effects evaluated before it. */
function order(n, target, accessors) {
  if (n === target) return FOUND
  if (!isArr(n)) return INERT
  const op = n[0]
  if (op == null || LITERALS.has(op)) return INERT
  if (n === DIRTY_MARK) return DIRTY
  // parts in evaluation order, then `after` (DIRTY: the node itself runs code)
  const seq = (parts, after = INERT) => {
    let dirty = false
    for (const p of parts) {
      const r = order(p, target, accessors)
      if (r === FOUND) return dirty ? EFFECT : FOUND
      if (r === EFFECT) return EFFECT
      if (r === DIRTY) dirty = true
    }
    return dirty || after === DIRTY ? DIRTY : INERT
  }
  // a member read runs code only through an accessor its key may name
  const runs = (key) => !!accessors?.size && (key == null || accessors.has(key))
  if (op === '?:') {
    const t = order(n[1], target, accessors)
    if (t === FOUND || t === EFFECT) return t
    const a = order(n[2], target, accessors), b = order(n[3], target, accessors)
    if (a === FOUND || b === FOUND) return t === DIRTY ? EFFECT : FOUND
    if (a === EFFECT || b === EFFECT) return EFFECT
    return t === DIRTY || a === DIRTY || b === DIRTY ? DIRTY : INERT
  }
  if (SEQUENTIAL.has(op) || op === 'return' || op === 'throw' || op === 'let' || op === 'const') return seq(n.slice(1))
  // iterating another spread source may run its iterator
  if (op === '...') return seq([n[1]], DIRTY)
  // a local's write runs only its value
  if (op === '=' && typeof n[1] === 'string') return seq([n[2]])
  if (op === '.' || op === '?.') return seq([n[1]], runs(n[2]) ? DIRTY : INERT)
  if (op === '[]' || op === '?.[]') {
    const k = n[2], key = isArr(k) && k[0] == null ? String(k[1]) : isArr(k) && k[0] === 'str' ? k[1] : null
    return seq([n[1], k], runs(key) ? DIRTY : INERT)
  }
  if (op === '()') {
    // the receiver or callee, the method lookup, the arguments; the call runs last
    const callee = n[1], member = isArr(callee) && (callee[0] === '.' || callee[0] === '?.')
    const parts = [member ? callee[1] : callee, ...(n.length > 2 && n[2] != null ? commaList(n[2]) : [])]
    if (member && runs(callee[2])) parts.splice(1, 0, DIRTY_MARK)
    return seq(parts, DIRTY)
  }
  return contains(n, target) ? EFFECT : DIRTY
}
// A part that runs code without containing anything (a method lookup through an accessor).
const DIRTY_MARK = ['__dirty']

const contains = (n, target) => n === target || (isArr(n) && n.some(c => contains(c, target)))

/** The definition `x = D` / `let x = D` a statement makes: [name, D] or null. */
const definition = (s) => {
  if (!isArr(s)) return null
  if (s[0] === '=' && typeof s[1] === 'string') return [s[1], s[2]]
  if ((s[0] === 'let' || s[0] === 'const') && s.length === 2 && isArr(s[1]) && s[1][0] === '=' && typeof s[1][1] === 'string') return [s[1][1], s[1][2]]
  return null
}

/**
 * The view bindings of `body`: Map name → view record ({ start, count } i32
 * locals, set when the definition emits), or null when there are none.
 */
export function arraySliceViews(body) {
  if (!isArr(body)) return null
  const accessors = ctx.transform.accessorNames
  // every occurrence of every name: its parent, and whether it sits in a nested function
  const seen = new Map()
  const note = (name, node, parent, nested) => {
    const r = write(name)
    if (nested) r.other = true
    else if (isArr(node) && node[0] === '...' && isArr(parent) && (parent[0] === '[' || parent[0] === '()' || parent[0] === ',')) r.spreads.push(node)
    else r.other = true
  }
  const write = (name) => { let r = seen.get(name); if (!r) seen.set(name, r = { writes: 0, spreads: [], other: false }); return r }
  let depth = 0
  walkAst(body, {
    enter: (n, parent) => {
      if (n[0] === '=>') depth++
      // a destructuring target writes every name in its pattern
      if (n[0] === '=' && isArr(n[1]) && (n[1][0] === '[' || n[1][0] === '{}'))
        walkAst(n[1], { enter: (x) => { for (const c of x) if (typeof c === 'string') write(c).other = true } })
      for (let i = 1; i < n.length; i++) {
        const c = n[i]
        if (typeof c !== 'string') continue
        // a definition's target, a member key and a literal are no reads
        if (n[0] === '=' && i === 1) { write(c).writes++; if (depth) write(c).other = true; continue }
        if ((n[0] === '.' || n[0] === '?.') && i === 2) continue
        if (n[0] === 'str' || n[0] === 'regex' || n[0] == null) continue
        if (n[0] === '...' && i === 1) { note(c, n, parent, depth > 0); continue }
        note(c, n, parent, depth > 0)
      }
    },
    exit: (n) => { if (n[0] === '=>') depth-- },
  })
  let views = null
  walkAst(body, { enter: (n) => {
    if (n[0] === '=>') return false
    if (n[0] !== ';') return
    for (let i = 1; i < n.length; i++) {
      const d = definition(n[i])
      if (!d || !hasSliceArm(d[1])) continue
      const [name] = d, r = seen.get(name)
      if (!r || r.writes !== 1 || r.other || !r.spreads.length || isGlobal(name)) continue
      // each spread in a later statement, reached through inert code only
      const ok = r.spreads.every(sp => {
        const j = n.findIndex((s, k) => k > i && contains(s, sp))
        if (j < 0) return false
        for (let k = i + 1; k < j; k++) if (order(n[k], null, accessors) !== INERT) return false
        return order(n[j], sp, accessors) === FOUND
      })
      if (ok) (views ??= new Map()).set(name, {})
    }
  } })
  return views
}

/** The view record of a binding read as a range, or null. */
export const arrayView = (name) => typeof name === 'string' ? ctx.func.arrayViews?.get(name)?.count ? ctx.func.arrayViews.get(name) : null : null

/**
 * The definition of view binding `name` by `D`: statements that set the
 * binding's local to the receiver (count ≥ 0) or to D's ordinary value
 * (count -1). Returns null, and drops the view, where the binding's local
 * is not a plain f64.
 */
export function emitArrayViewDef(name, D, { emit, toBool }) {
  const view = ctx.func.arrayViews?.get(name)
  const storage = ctx.func.locals.get(name) || ctx.func.current?.params?.find(p => p.name === name)?.type || 'f64'
  if (!view || ctx.func.boxed?.has(name) || storage !== 'f64' || ctx.func.localReps?.get(name)?.ptrKind != null) {
    ctx.func.arrayViews?.delete(name)
    return null
  }
  view.start ??= tempI32('avs')
  view.count ??= tempI32('avn')
  const set = (local, v) => ['local.set', `$${local}`, v]
  const plain = (e) => [set(name, asF64(emit(e))), set(view.count, ['i32.const', -1]), set(view.start, ['i32.const', 0])]
  const arm = (e) => {
    if (isArr(e) && e[0] === '?:') return [['if', toBool(e[1]), ['then', ...arm(e[2])], ['else', ...arm(e[3])]]]
    const s = sliceArm(e)
    if (!s) return plain(e)
    const [recv, args] = s
    inc('__ptr_type', '__len')
    const base = temp('avb'), len = tempI32('avl'), end = tempI32('ave')
    const bits = ['i64.reinterpret_f64', ['local.get', `$${base}`]]
    // ToIntegerOrInfinity (after the length, as slice reads them), then relative
    // to the length: a negative index counts from the end
    const clamp = (a, dflt) => {
      if (a == null) return dflt
      const v = temp('ava')
      return ['block', ['result', 'i32'],
        set(v, ['f64.trunc', asF64(toNumF64(a, emit(a)))]),
        ['if', ['result', 'i32'], ['f64.ne', ['local.get', `$${v}`], ['local.get', `$${v}`]],
          ['then', ['i32.const', 0]],
          ['else', ['if', ['result', 'i32'], ['f64.lt', ['local.get', `$${v}`], ['f64.const', 0]],
            ['then', ['i32.trunc_sat_f64_s', ['f64.max', ['f64.add', ['f64.convert_i32_s', ['local.get', `$${len}`]], ['local.get', `$${v}`]], ['f64.const', 0]]]],
            ['else', ['i32.trunc_sat_f64_s', ['f64.min', ['local.get', `$${v}`], ['f64.convert_i32_s', ['local.get', `$${len}`]]]]]]]]]
    }
    return [
      set(base, asF64(emit(recv))),
      ['if', ['i32.eq', ['call', '$__ptr_type', bits], ['i32.const', PTR.ARRAY]],
        ['then',
          set(len, ['call', '$__len', bits]),
          set(view.start, clamp(args[0], ['i32.const', 0])),
          set(end, clamp(args[1], ['local.get', `$${len}`])),
          set(view.count, ['select', ['i32.sub', ['local.get', `$${end}`], ['local.get', `$${view.start}`]], ['i32.const', 0],
            ['i32.gt_s', ['local.get', `$${end}`], ['local.get', `$${view.start}`]]]),
          set(name, ['local.get', `$${base}`])],
        ['else', ...plain(['()', ['.', base, 'slice'], ...e.slice(2)])]],
    ]
  }
  return arm(D)
}

/** Any other read of view binding `name`: the range as a fresh array, or the ordinary value. */
export function materializeArrayView(name) {
  const view = ctx.func.arrayViews.get(name)
  inc('__ptr_offset')
  const out = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${view.count}`], tag: 'avm' })
  return typed(['if', ['result', 'f64'], ['i32.ge_s', ['local.get', `$${view.count}`], ['i32.const', 0]],
    ['then', ['block', ['result', 'f64'], out.init,
      ['memory.copy', ['local.get', `$${out.local}`], viewBase(name, view), ['i32.shl', ['local.get', `$${view.count}`], ['i32.const', 3]]],
      out.ptr]],
    ['else', ['local.get', `$${name}`]]], 'f64')
}

/** The address of a view's first element (an ordinary value's start is 0). */
export const viewBase = (local, view) => ['i32.add',
  ['call', '$__ptr_offset', ['i64.reinterpret_f64', ['local.get', `$${local}`]]],
  ['i32.shl', ['local.get', `$${view.start}`], ['i32.const', 3]]]
