/**
 * Definite assignment: the bare declarations of a function body (`let x`)
 * whose every read follows an assignment on every path that reaches it. Such
 * a binding never shows the `undefined` it is declared with, so the summary
 * declares it empty instead of absent and its kind is the join of what is
 * assigned (`let t; if (c) t = a[0]; else t = b[0]; out[0] = t` stores a
 * number, not a number that may be missing).
 *
 * The walk carries the set of names assigned so far and joins it where paths
 * meet: both arms of a branch must assign, a loop body may not run, a handler
 * starts from what held before the `try`, a labeled block ends with what held
 * at each `break` to it. A closure runs at a time the walk
 * does not know, so a name it mentions must be assigned where the closure is
 * made. The answer may leave out a binding that is always assigned; it never
 * includes one a read can find unassigned. It walks prepared bodies: patterns,
 * `switch`, `do` and for-of/in heads are already lowered.
 *
 * @module summary/definite
 */
import { MUTATE_OPS, extractParams } from '../ast.js'

const LOGICAL_ASSIGN = new Set(['||=', '&&=', '??='])

/** The names `body` declares bare and assigns before every read, nested closures' own aside.
 *  For the module's statements: `reach(name, read)` visits the names a function's
 *  frame mentions transitively, since a function named where a
 *  binding is not yet assigned may run from there on, and what it reads is
 *  read there; `later` are the names read once the statements have ended (a
 *  function the host calls), which every path to the end must have assigned. */
export function definitelyAssigned(body, reach = null, later = null) {
  const bare = new Set()
  const declared = (n) => {
    if (!Array.isArray(n) || n[0] === '=>') return
    if (n[0] === 'let') { for (let i = 1; i < n.length; i++) if (typeof n[i] === 'string') bare.add(n[i]) }
    for (let i = 1; i < n.length; i++) declared(n[i])
  }
  declared(body)
  if (!bare.size) return bare

  // A state is the set of names assigned on every path to here; `null` past a
  // statement that leaves (no path continues, so every name counts assigned).
  const join = (a, b) => { if (a === null) return b; if (b === null) return a; const out = new Set(); for (const x of a) if (b.has(x)) out.add(x); return out }
  const fork = (a) => a === null ? null : new Set(a)
  const assign = (name, a) => { if (a !== null && bare.has(name)) a.add(name); return a }
  const read = (name, a) => {
    if (a === null) return
    if (bare.has(name) && !a.has(name)) bare.delete(name)
    if (reach && bare.size) reach(name, x => { if (bare.has(x) && !a.has(x)) bare.delete(x) })
  }
  const mentions = (n, a) => {
    if (typeof n === 'string') read(n, a)
    else if (Array.isArray(n)) for (let i = 1; i < n.length; i++) mentions(n[i], a)
  }
  const seq = (n, a, from = 1) => { for (let i = from; i < n.length; i++) a = walk(n[i], a); return a }
  // label of a block → the states its breaks left with; a loop's label has none
  // (what follows a loop starts from what held before it)
  const exits = new Map()
  // what a condition leaves where it comes out true and where false: the right
  // operand of `&&` runs where the left came out true, of `||` where false, so
  // a true `&&` ran every operand (`if (a && (r = a[0]) != null && r !== b)`
  // reads `r` assigned in its arm and in the operand after it)
  const split = (n, a) => {
    const op = Array.isArray(n) ? n[0] : null
    if (op === '!') { const [yes, no] = split(n[1], a); return [no, yes] }
    if (op === '&&') { const [yes, no] = split(n[1], a), [yes2, no2] = split(n[2], yes); return [yes2, join(no, no2)] }
    if (op === '||') { const [yes, no] = split(n[1], a), [yes2, no2] = split(n[2], no); return [join(yes, yes2), no2] }
    a = walk(n, a)
    return [a, fork(a)]
  }

  const walk = (n, a) => {
    if (typeof n === 'string') { read(n, a); return a }
    if (!Array.isArray(n)) return a
    const op = n[0]
    if (op == null || op === 'str') return a
    if (op === '=>') { mentions(n[1], a); mentions(n[2], a); return a }
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < n.length; i++) { const d = n[i]; if (Array.isArray(d) && d[0] === '=') a = assign(d[1], walk(d[2], a)) }
      return a
    }
    if (MUTATE_OPS.has(op)) {
      const t = n[1]
      if (typeof t !== 'string') return seq(n, a)   // a member or an element: its receiver and key are read
      if (op === '=') return assign(t, walk(n[2], a))
      read(t, a)
      if (LOGICAL_ASSIGN.has(op)) { walk(n[2], fork(a)); return a }
      return assign(t, n.length > 2 ? walk(n[2], a) : a)
    }
    if (op === 'if' || op === '?:' || op === '?') {
      const [yes, no] = split(n[1], a)
      return join(walk(n[2], yes), n[3] == null ? no : walk(n[3], no))
    }
    if (op === '&&' || op === '||') { const [yes, no] = split(n, a); return join(yes, no) }
    if (op === '??' || op === '?.' || op === '?.()' || op === '?.[]') {
      a = walk(n[1], a)
      seq(n, fork(a), 2)
      return a
    }
    if (op === 'for' && n.length === 5) {
      a = walk(n[2], walk(n[1], a))
      walk(n[3], walk(n[4], fork(a)) ?? fork(a))
      return a
    }
    if (op === 'while') { a = walk(n[1], a); walk(n[2], fork(a)); return a }
    if (op === 'return' || op === 'throw') { seq(n, a); return null }
    if (op === 'break' || op === 'continue') { if (op === 'break' && a !== null) exits.get(n[1])?.push(fork(a)); return null }
    if (op === 'catch') { walk(n[1], fork(a)); walk(n[3], fork(a)); return a }
    if (op === 'finally') { walk(n[1], fork(a)); return walk(n[2], a) }
    if (op === 'label') {
      if (Array.isArray(n[2]) && (n[2][0] === 'for' || n[2][0] === 'while')) return walk(n[2], a)
      const left = [], shadowed = exits.get(n[1])
      exits.set(n[1], left)
      let end = walk(n[2], a)
      if (shadowed) exits.set(n[1], shadowed); else exits.delete(n[1])
      for (const x of left) end = join(end, x)
      return end
    }
    return seq(n, a)
  }
  const end = walk(body, new Set())
  if (later && end !== null) for (const x of later) if (bare.has(x) && !end.has(x)) bare.delete(x)
  return bare
}

// The builtin methods and functions that call a function they are handed.
const CALLS_BACK = new Set(['every', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flatMap', 'forEach', 'map',
  'reduce', 'reduceRight', 'some', 'sort', 'toSorted', 'replace', 'replaceAll', 'then', 'catch', 'finally', 'from', 'fromAsync',
  'parse', 'stringify', 'groupBy', 'defineProperty', 'defineProperties', 'apply', 'construct'])
const CALLS_BACK_FN = new Set(['Array.from', 'Array.fromAsync', 'JSON.parse', 'JSON.stringify', 'Object.groupBy', 'Map.groupBy',
  'Object.defineProperty', 'Object.defineProperties', 'Reflect.apply', 'Reflect.construct', 'new.Promise', 'new.Proxy'])
// a value no call can run: a literal, or arithmetic, a comparison, a `typeof`
const PRIMITIVE_OPS = new Set(['+', '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>', '~', 'u-', 'u+', '!', 'typeof',
  '<', '<=', '>', '>=', '==', '!=', '===', '!=='])
const primitive = (n) => Array.isArray(n) && (n[0] == null || n[0] === 'str' || n[0] === 'bool' || PRIMITIVE_OPS.has(n[0]))

/** Of the module's bare declarations its statements leave unassigned, those
 *  every read of which still follows an assignment: the code that reads one
 *  runs only after a function that assigns it (a parser's `let idx, cur`,
 *  which `parse` assigns before it calls anything that reads them).
 *
 *  The module's statements run first, with every declaration unassigned, and
 *  so do `entries` (what the host or emitted code may call at any time: the
 *  exports, accessors, class members, dispatchers). A function runs where it
 *  is called by name, a closure literal where it is called in place, either
 *  where it is handed to a builtin that calls back; a call returns with what
 *  its callee assigns on every path. Any other closure runs only through a
 *  call of a value, which the walk does not follow: where a declaration may
 *  still be unassigned, a call through a binding (`isBinding`) or an unnamed
 *  value proves none; one through a member under which the program may keep
 *  a function (`userMethods`) is the caller's to check by the receiver's kind
 *  (`onMember`), else proves none either. A builtin or the host runs only
 *  what it is handed: the caller proves the host holds no function of the
 *  program and the language calls none on its own (a conversion, an
 *  iteration). `funcs` maps a function's name to `{ body, defaults }`. */
export function assignedByCalls({ tops, funcs, candidates, entries, isBinding, userMethods, onMember = null }) {
  const failed = new Set()
  const live = () => { const s = new Set(); for (const x of candidates) if (!failed.has(x)) s.add(x); return s }
  let cur = null   // the function or closure walked, null for the module's statements
  const pre = new Map()   // function or closure → the candidates that may be unassigned as it is entered
  const work = []
  const enter = (fn, unassigned) => {
    let u = pre.get(fn), grew = false
    if (!u) pre.set(fn, u = new Set())
    for (const x of unassigned) if (!failed.has(x) && !u.has(x)) { u.add(x); grew = true }
    if (grew) work.push(fn)
  }
  const join = (a, b) => { if (a === null) return b; if (b === null) return a; const out = new Set(); for (const x of a) if (b.has(x)) out.add(x); return out }
  const fork = (a) => a === null ? null : new Set(a)
  const unassignedAt = (a) => { const s = new Set(); if (a !== null) for (const x of candidates) if (!a.has(x) && !failed.has(x)) s.add(x); return s }
  const fail = (a) => { for (const x of unassignedAt(a)) failed.add(x) }

  // What a function assigns on every path to its return: its walk without
  // hooks from an entry with nothing assigned. A recursive call assigns nothing.
  const assigns = new Map()
  const assignsOf = (name) => {
    if (assigns.has(name)) return assigns.get(name) ?? new Set()
    assigns.set(name, null)
    const out = flow(funcs.get(name).body, new Set(), false) ?? new Set()
    assigns.set(name, out)
    return out
  }
  const argsOf = (n) => {
    if (n[0] === '?.()') return n.slice(2)
    const a = n[2]
    return a == null ? [] : Array.isArray(a) && a[0] === ',' ? a.slice(1) : [a]
  }
  // A function a call may run: a closure literal or a function's name runs
  // where it is handed; any other value may be a function the walk cannot name.
  const runs = (fn, u) => {
    if (Array.isArray(fn) && fn[0] === '=>') enter(fn, u)
    else if (typeof fn === 'string' && funcs.has(fn)) enter(fn, u)
    else if (!(Array.isArray(fn) && (fn[0] == null || fn[0] === 'str'))) return false
    return true
  }
  const call = (n, a, h) => {
    const callee = n[1]
    // a function of the program, its walk deciding what it does with a function it is handed
    if (typeof callee === 'string' && funcs.has(callee)) {
      if (h) enter(callee, unassignedAt(a))
      if (a === null) return a
      const out = fork(a)
      for (const x of assignsOf(callee)) out.add(x)
      return out
    }
    const u = h ? unassignedAt(a) : null
    if (!u?.size) return a
    if (Array.isArray(callee) && callee[0] === '=>') { enter(callee, u); return a }
    const member = Array.isArray(callee) && (callee[0] === '.' || callee[0] === '?.') && typeof callee[2] === 'string' ? callee[2] : null
    if (member != null) {
      // a member the program may keep a function under: the receiver's kind decides, once the solve knows it
      if (userMethods.has(member) && !onMember?.(callee[1], cur, u)) { fail(a); return a }
      // `f.call(…)`, `f.apply(…)` run `f`
      if ((member === 'call' || member === 'apply') && !runs(callee[1], u)) { fail(a); return a }
    }
    else if (typeof callee !== 'string' || isBinding(callee)) { fail(a); return a }
    // a builtin that calls back what it is handed (`xs.forEach(f)`, `Array.from(xs, f)`); the host,
    // which may keep what it is handed, holds no function of the program (the caller's proof)
    if (member != null ? CALLS_BACK.has(member) : CALLS_BACK_FN.has(callee))
      for (const arg of argsOf(n)) if (!runs(arg, u) && !primitive(arg)) { fail(a); return a }
    return a
  }

  // `h`: the walk of a function entered where candidates may be unassigned
  // (its reads and calls count); else the walk of what a function assigns.
  const exits = new Map()
  let returned = null
  const flow = (body, entry, h) => {
    const saved = returned
    returned = null
    const end = join(walk(body, entry, h), returned)
    returned = saved
    return end
  }
  const split = (n, a, h) => {
    const op = Array.isArray(n) ? n[0] : null
    if (op === '!') { const [yes, no] = split(n[1], a, h); return [no, yes] }
    if (op === '&&') { const [yes, no] = split(n[1], a, h), [yes2, no2] = split(n[2], yes, h); return [yes2, join(no, no2)] }
    if (op === '||') { const [yes, no] = split(n[1], a, h), [yes2, no2] = split(n[2], no, h); return [join(yes, yes2), no2] }
    a = walk(n, a, h)
    return [a, fork(a)]
  }
  const seq = (n, a, h, from = 1) => { for (let i = from; i < n.length; i++) a = walk(n[i], a, h); return a }
  const assign = (t, a) => { if (a !== null && candidates.has(t)) a.add(t); return a }
  const walk = (n, a, h) => {
    if (typeof n === 'string') { if (h && a !== null && candidates.has(n) && !a.has(n)) failed.add(n); return a }
    if (!Array.isArray(n)) return a
    const op = n[0]
    // a closure made here runs where a call reaches it
    if (op == null || op === 'str' || op === '=>') return a
    if (op === '.' || op === '?.') return walk(n[1], a, h)
    if (op === ':') return walk(n[2], a, h)
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < n.length; i++) { const d = n[i]; if (Array.isArray(d) && d[0] === '=') a = assign(d[1], walk(d[2], a, h)) }
      return a
    }
    if (MUTATE_OPS.has(op)) {
      const t = n[1]
      if (typeof t !== 'string') return seq(n, a, h)
      if (op === '=') return assign(t, walk(n[2], a, h))
      a = walk(t, a, h)
      if (LOGICAL_ASSIGN.has(op)) { walk(n[2], fork(a), h); return a }
      return assign(t, n.length > 2 ? walk(n[2], a, h) : a)
    }
    if (op === '()' || op === '?.()') return call(n, seq(n, a, h), h)
    // a constructor prepare left unnamed (`new (f())()`) may be any function
    if (op === 'new') { a = seq(n, a, h); if (h) fail(a); return a }
    if (op === 'if' || op === '?:' || op === '?') {
      const [yes, no] = split(n[1], a, h)
      return join(walk(n[2], yes, h), n[3] == null ? no : walk(n[3], no, h))
    }
    if (op === '&&' || op === '||') { const [yes, no] = split(n, a, h); return join(yes, no) }
    if (op === '??') { a = walk(n[1], a, h); walk(n[2], fork(a), h); return a }
    if (op === 'for' && n.length === 5) {
      a = walk(n[2], walk(n[1], a, h), h)
      walk(n[3], walk(n[4], fork(a), h) ?? fork(a), h)
      return a
    }
    if (op === 'while') { a = walk(n[1], a, h); walk(n[2], fork(a), h); return a }
    if (op === 'return') { returned = join(returned, seq(n, a, h)); return null }
    if (op === 'throw') { seq(n, a, h); return null }
    if (op === 'break' || op === 'continue') { if (op === 'break' && a !== null) exits.get(n[1])?.push(fork(a)); return null }
    if (op === 'catch') { walk(n[1], fork(a), h); walk(n[3], fork(a), h); return a }
    if (op === 'finally') { walk(n[1], fork(a), h); return walk(n[2], a, h) }
    if (op === 'label') {
      if (Array.isArray(n[2]) && (n[2][0] === 'for' || n[2][0] === 'while')) return walk(n[2], a, h)
      const left = [], shadowed = exits.get(n[1])
      exits.set(n[1], left)
      let end = walk(n[2], a, h)
      if (shadowed) exits.set(n[1], shadowed); else exits.delete(n[1])
      for (const x of left) end = join(end, x)
      return end
    }
    return seq(n, a, h)
  }

  // the module's statements run first, once, with every candidate unassigned
  flow([';', ...tops], new Set(), true)
  for (const fn of entries) if (Array.isArray(fn) || funcs.has(fn)) enter(fn, candidates)
  while (work.length) {
    const fn = work.pop(), u = pre.get(fn)
    cur = fn
    let a = new Set()
    for (const x of candidates) if (!u.has(x)) a.add(x)
    // parameter defaults run as the function is entered
    if (typeof fn === 'string') {
      const f = funcs.get(fn)
      for (const d of Object.values(f.defaults ?? {})) a = walk(d, a, true)
      flow(f.body, a, true)
    } else {
      for (const p of extractParams(fn[1])) if (Array.isArray(p) && p[0] === '=') a = walk(p[2], a, true)
      flow(fn[2], a, true)
    }
  }
  return live()
}
