/**
 * What a call does: the effects of every function of the module, read off its body and
 * closed over the call graph once, for every pass to ask.
 *
 * A function's row: the module globals it may set, the memory it may write (through
 * which typed-array global, or any), whether it may write a header word (a length or a
 * forward word: a block grows or moves; jz writes a payload with the wide stores
 * alone, HEADER_STORE_FREE), whether it may throw, whether it reaches the host, and
 * whether it returns at all. A callee's row joins its callers' (the components of the
 * call graph condensed, then solved on the DAG as bitsets).
 *
 * A name outside the module is the host: a function the user imports may call an export
 * back, so it does what any function of the module does, as an indirect call does. The
 * runtime's own imports (bridge.js hostImport, `callsNothing`) call no export: each does
 * what SHIMS says. A runtime helper whose body does not show a fact is in HELPERS, with
 * why (test/effects.js holds every entry to the body where the module has one); a name
 * no table knows and the module does not define is the host too. That covers a function
 * a pass adds after the solve: its name has no row, so it is answered as the host, and a
 * row of a function the summary did solve stays true, every pass rewriting a function
 * into one that does no more than it did (a loop's compaction, which calls kernels the
 * function did not, declares them up front: `later`).
 *
 * @module optimize/effects
 */
import { isMemWrite } from 'watr/optimize'
import { DBG_INVARIANTS } from '../debug.js'
import { globalBaseAliases, memGlobal } from './globals.js'

const isArr = Array.isArray
const INDIRECT = new Set(['call_indirect', 'call_ref', 'return_call_indirect', 'return_call_ref'])
const THROWS = new Set(['throw', 'rethrow', 'throw_ref'])
const LEAVES = new Set(['return', 'return_call', 'return_call_indirect', 'return_call_ref'])

/** The stores of an element's payload: jz writes every array and typed header word with
 *  `i32.store` (under JZ_DEBUG_INVARIANTS every solve checks each wide store it reads,
 *  `headerStore`), and a payload store lands inside its own allocation (the bounds a store
 *  is emitted under), so these never change a header. */
export const HEADER_STORE_FREE = new Set(['f64.store', 'f32.store', 'i64.store', 'v128.store'])
/** Whether store `n` may write a header word: the bytes it writes, below the pointer its
 *  address steps back from, reach the length at -8 or the forward word at -4. (The allocator
 *  writes a header ahead of the pointer it returns with word stores, `__alloc_hdr`.) */
export const headerStore = (n) => {
  let i = 1, off = 0
  while (typeof n[i] === 'string') { if (n[i].startsWith('offset=')) off += Number(n[i].slice(7)); i++ }
  const a = n[i], width = n[0].startsWith('v128') ? 16 : n[0].startsWith('f32') ? 4 : 8
  const k = isArr(a) && a.length === 3 && isArr(a[2]) && a[2][0] === 'i32.const' ? Number(a[2][1]) : null
  const at = k == null ? null : a[0] === 'i32.sub' ? off - k : a[0] === 'i32.add' && k < 0 ? off + k : null
  return at != null && at < 0 && at + width > -8
}

/**
 * The runtime helpers whose body does not show what calling them does, by name (a name
 * ending in `*` is a prefix; the first entry that matches is the one). Kinds:
 *   pure     its result is a function of its operands: it writes nothing, reads no memory
 *            a program writes, and cannot trap
 *   header   it reads header words alone (a length, a forward word) and writes nothing
 *   fresh    it writes only a block it allocates, which no value of the program reaches
 *            before it returns, where it reaches no host (a conversion may run a user's
 *            method: the solve keeps such a row whole)
 *   log      it writes only the runtime's own records, which hold no program value
 *   throw    it never returns (its body shows it; this is for a pass that asks with no module)
 *   null     nothing beyond its body
 */
export const HELPERS = [
  ['$math.random*', null, 'the random source keeps its state in a global, which its body shows'],
  ['$math.*', 'pure', 'the math runtime reads its constant tables alone and its truncations are guarded; the vectorizer\'s mirrors join the module after the solve'],
  ['$__ptr_type', 'pure', 'the tag bits of a box'],
  ['$__ptr_aux', 'pure', 'the aux bits of a box'],
  ['$__mkptr', 'pure', 'packs a box out of its operands'],
  ['$__str_indexof', 'pure', 'reads its operands\' code units, and a string never changes'],
  ['$__str_lastindexof', 'pure', 'reads its operands\' code units, and a string never changes'],
  ['$__str_eq', 'pure', 'reads its operands\' code units, and a string never changes'],
  ['$__str_eq_cold', 'pure', 'the cold half of $__str_eq'],
  ['$__is_str_key', 'pure', 'tests a box\'s tag and a string\'s code units'],
  ['$__str_length', 'pure', 'a string\'s length, which never changes (the in-place extend writes only a string no live value holds)'],
  ['$__jss_*', 'pure', 'the engine\'s string builtins, over strings that never change'],
  ['$__ptr_offset', 'header', 'follows a block\'s forward words'],
  ['$__ptr_offset_fwd', 'header', 'follows a block\'s forward words'],
  ['$__len', 'header', 'a length, read off a header (a string\'s and a view\'s never change)'],
  ['$__alloc*', 'fresh', 'moves the heap\'s top and writes the header of the block it returns'],
  ['$__str_concat', 'fresh', 'writes the string it makes'],
  ['$__str_concat_fresh', 'fresh', 'writes the string it makes'],
  ['$__to_str', 'fresh', 'writes the string it makes'],
  ['$__to_num', 'fresh', 'a conversion, which may allocate a string it parses and no more'],
  ['$__durable_arr_snap', 'log', 'records an array in the durable log and marks the bitmap the reset owns'],
  ['$__esc_*', 'log', 'an escape\'s lowering writes the flag and the log made as the module starts'],
  ['$__root', 'log', 'writes the roots\' log made as the module starts'],
  ['$__throw_*', 'throw', 'throws the runtime\'s error'],
]
const EXACT = new Map(), PREFIXES = []
for (const e of HELPERS) e[0].endsWith('*') ? PREFIXES.push([e[0].slice(0, -1), e]) : EXACT.set(e[0], e)
/** The HELPERS entry of `name`, or null. */
export const helper = (name) => {
  if (typeof name !== 'string') return null
  const e = EXACT.get(name)
  if (e) return e
  for (const [p, entry] of PREFIXES) if (name.startsWith(p)) return entry
  return null
}
/** The kind HELPERS gives `name`, or null. */
export const helperKind = (name) => helper(name)?.[1] ?? null
/** Whether `name` is the math runtime's (HELPERS' `$math.*`): a call of it is arithmetic. */
export const mathKernel = (name) => helper(name)?.[0] === '$math.*'
/** What HELPERS says `name` reads ('pure': nothing a program writes; 'header'), or null. */
const kind = (name) => { const k = helperKind(name); return k === 'pure' || k === 'header' ? k : null }

/** The runtime's own imports (bridge.js hostImport) by their function's name, as interop.js
 *  and a WASI host provide them: none calls an export, sets a global or writes a header word.
 *  `mem`: it writes the bytes it is handed (a buffer, an out-parameter); `noret`: it never
 *  comes back. Every other one writes nothing (a clock, the seed, a line printed, a timer). */
export const SHIMS = new Map([
  ['$__env_random', { mem: true }], ['$__random_get', { mem: true }], ['$__clock_time_get', { mem: true }],
  ['$__fd_read', { mem: true }], ['$__fd_write', { mem: true }], ['$__path_open', { mem: true }],
  ['$__fd_filestat_get', { mem: true }], ['$__proc_exit', { noret: true }],
])

// A row's leading bits; the typed globals' then the globals' follow.
const MEM = 1, HDR = 2, THROW = 4, HOST = 8, MARK = 16, FLAGS = 5
const QUIET = new Set(['pure', 'header'])

/**
 * Solve the effects of `funcs` (func nodes; one with an `import` child is an import).
 * `imports`: the module's import nodes (their functions' result types); `callsNothing`: the
 * names of the runtime's own imports; `later`: callees a pass still to run puts in a
 * function (name → names); `mark`: a fact of a reader's own, of a function's body, closed
 * over the calls as the rest (`marked`); `raw`: what the bodies show alone, HELPERS aside.
 */
export function solveEffects(funcs, { imports = null, callsNothing = null, later = null, mark = null, raw = false } = {}) {
  const bodies = new Map(), results = new Map()
  const resultsOf = (node) => {
    const r = []
    for (const c of node) if (isArr(c) && c[0] === 'result') for (let i = 1; i < c.length; i++) r.push(c[i])
    return r
  }
  for (const fn of funcs) {
    if (!isArr(fn) || fn[0] !== 'func' || typeof fn[1] !== 'string') continue
    results.set(fn[1], resultsOf(fn))
    if (!fn.some(c => isArr(c) && c[0] === 'import')) bodies.set(fn[1], fn)
  }
  for (const imp of imports ?? []) if (isArr(imp)) for (const c of imp) if (isArr(c) && c[0] === 'func' && typeof c[1] === 'string') results.set(c[1], resultsOf(c))

  // What a name the module does not define does: its flags, or -1, every bit (the host).
  const foreign = (name) => {
    if (!raw && QUIET.has(helperKind(name))) return 0
    if (callsNothing?.has(name)) return THROW | (SHIMS.get(name)?.mem ? MEM | MARK : 0)
    return -1
  }
  const foreignNoret = (name) => !!(callsNothing?.has(name) && SHIMS.get(name)?.noret)

  // Each function's own facts, one walk of its body.
  const names = [...bodies.keys()], ids = new Map()
  for (let i = 0; i < names.length; i++) ids.set(names[i], i)
  const gIds = new Map(), tIds = new Map()
  const own = [], edges = [], leaves = new Uint8Array(names.length)
  let flags = 0, sets = null, calls = null, stores = null, leaving = false
  const scan = (n) => {
    const op = n[0]
    if (op === 'global.set' && typeof n[1] === 'string') (sets ??= new Set()).add(n[1])
    else if (op === 'call' || op === 'return_call') {
      if (typeof n[1] !== 'string') flags |= -1
      else if (ids.has(n[1])) (calls ??= new Set()).add(n[1])
      else flags |= foreign(n[1])
      if (op === 'return_call') leaving = true
    }
    else if (INDIRECT.has(op)) { flags |= -1; if (op.startsWith('return')) leaving = true }
    else if (THROWS.has(op)) flags |= THROW
    else if (op === 'return') leaving = true
    else if (typeof op === 'string' && isMemWrite(op)) {
      if (op.includes('.store')) (stores ??= []).push(n)
      else flags |= MEM
      if (!HEADER_STORE_FREE.has(op)) flags |= HDR
      else if (DBG_INVARIANTS && headerStore(n)) throw Error(`effects: a wide store may write a header word: ${JSON.stringify(n).slice(0, 160)}`)
    }
    for (let i = 1; i < n.length; i++) if (isArr(n[i])) scan(n[i])
  }
  for (let f = 0; f < names.length; f++) {
    const fn = bodies.get(names[f])
    flags = 0; sets = null; calls = null; stores = null; leaving = false
    if (mark?.(fn)) flags |= MARK
    for (let i = 2; i < fn.length; i++) if (isArr(fn[i])) scan(fn[i])
    const typed = new Set()
    if (stores && !(flags & MEM)) {
      const aliases = globalBaseAliases(fn)
      for (const s of stores) { const g = memGlobal(s, aliases).global; if (g) typed.add(g); else { flags |= MEM; break } }
    }
    for (const g of sets ?? []) if (!gIds.has(g)) gIds.set(g, gIds.size)
    if (!(flags & MEM)) for (const g of typed) if (!tIds.has(g)) tIds.set(g, tIds.size)
    const more = later?.get(names[f])
    if (more) for (const m of more) if (ids.has(m)) (calls ??= new Set()).add(m); else flags |= foreign(m)
    own.push({ flags, sets, typed: flags & MEM ? null : typed })
    edges.push(calls)
    leaves[f] = leaving ? 1 : 0
  }

  // The rows, as bitsets: the flags, the typed globals, the globals.
  const T0 = FLAGS, G0 = FLAGS + tIds.size, bits = G0 + gIds.size, words = Math.max(1, Math.ceil(bits / 32))
  const ALL = new Uint32Array(words)
  for (let b = 0; b < bits; b++) ALL[b >>> 5] |= 1 << (b & 31)
  const setBit = (row, b) => { row[b >>> 5] |= 1 << (b & 31) }
  const rowOf = ({ flags, sets, typed }) => {
    if (flags === -1 || flags & HOST) return ALL.slice()
    const row = new Uint32Array(words)
    row[0] |= flags
    for (const g of typed ?? []) setBit(row, T0 + tIds.get(g))
    for (const g of sets ?? []) setBit(row, G0 + gIds.get(g))
    return row
  }
  // What a helper's kind leaves of its row: nothing, or no memory written.
  const masks = names.map(name => {
    const kind = raw ? null : helperKind(name)
    if (QUIET.has(kind)) return new Uint32Array(words)
    if (kind !== 'fresh' && kind !== 'log') return null
    const m = ALL.slice()
    m[0] &= ~(MEM | HDR)
    for (let b = T0; b < G0; b++) m[b >>> 5] &= ~(1 << (b & 31))
    return m
  })

  // Condense the call graph's components, then solve on the DAG: a bit crosses each
  // component edge once.
  const n = names.length
  const index = new Int32Array(n).fill(-1), low = new Int32Array(n), onStack = new Uint8Array(n), compOf = new Int32Array(n).fill(-1)
  const stack = [], members = []
  let next = 0
  const strong = (v) => {
    index[v] = low[v] = next++
    stack.push(v); onStack[v] = 1
    for (const c of edges[v] ?? []) {
      const w = ids.get(c)
      if (index[w] === -1) { strong(w); if (low[w] < low[v]) low[v] = low[w] }
      else if (onStack[w] && index[w] < low[v]) low[v] = index[w]
    }
    if (low[v] !== index[v]) return
    const comp = []
    for (;;) { const w = stack.pop(); onStack[w] = 0; compOf[w] = members.length; comp.push(w); if (w === v) break }
    members.push(comp)
  }
  for (let v = 0; v < n; v++) if (index[v] === -1) strong(v)
  // (Tarjan's order: a component is complete after every component it reaches)
  const rows = members.map(comp => {
    const row = new Uint32Array(words)
    for (const v of comp) {
      const r = rowOf(own[v])
      for (let i = 0; i < words; i++) row[i] |= r[i]
    }
    return row
  })
  for (let c = 0; c < members.length; c++) {
    const row = rows[c]
    for (const v of members[c]) for (const callee of edges[v] ?? []) {
      const d = compOf[ids.get(callee)]
      if (d !== c) { const r = rows[d]; for (let i = 0; i < words; i++) row[i] |= r[i] }
    }
    // (a helper's kind holds where it is a component alone and reaches no host)
    const mask = members[c].length === 1 && !(row[0] & HOST) ? masks[members[c][0]] : null
    if (mask) for (let i = 0; i < words; i++) row[i] &= mask[i]
  }

  // The functions that never return: no return of their own, and a last statement that
  // never completes (a throw, a trap, a call of such a function).
  const noret = new Set()
  const never = (s) => {
    if (!isArr(s)) return false
    const op = s[0]
    if (op === 'unreachable' || THROWS.has(op)) return true
    if (op === 'call') return typeof s[1] === 'string' && (noret.has(s[1]) || !ids.has(s[1]) && foreignNoret(s[1]))
    if (op === 'block' || op === 'drop' || op === 'local.set' || op === 'local.tee' || op === 'global.set') return never(s[s.length - 1]) && (op !== 'block' || !branches(s))
    return false
  }
  for (let grew = true; grew;) {
    grew = false
    for (let f = 0; f < n; f++) {
      if (leaves[f] || noret.has(names[f])) continue
      const fn = bodies.get(names[f])
      if (never(fn[fn.length - 1])) { noret.add(names[f]); grew = true }
    }
  }

  const memo = new Map()
  const row = (name) => {
    const id = ids.get(name)
    if (id !== undefined) return rows[compOf[id]]
    if (!memo.has(name)) { const f = foreign(name), r = f === -1 ? ALL : new Uint32Array(words); if (f !== -1) r[0] = f; memo.set(name, r) }
    return memo.get(name)
  }
  const has = (r, b) => (r[b >>> 5] & (1 << (b & 31))) !== 0
  const typedNames = [...tIds.keys()]
  return {
    /** May a call of `name` set module global `g`. */
    sets: (name, g) => { const id = gIds.get(g); return id !== undefined && has(row(name), G0 + id) },
    /** May it set any global. */
    setsAny: (name) => { const r = row(name); for (let b = G0; b < bits; b++) if (has(r, b)) return true; return false },
    /** May it write memory a program value reaches. */
    writes: (name) => { const r = row(name); if (r[0] & MEM) return true; for (let b = T0; b < G0; b++) if (has(r, b)) return true; return false },
    /** The typed-array globals it may write through, with '*' for any memory. */
    memOf: (name) => { const r = row(name); return new Set(r[0] & MEM ? ['*'] : typedNames.filter((g, i) => has(r, T0 + i))) },
    /** May it write a header word: a block may grow or move. */
    header: (name) => (row(name)[0] & HDR) !== 0,
    /** May it throw. */
    throws: (name) => (row(name)[0] & THROW) !== 0,
    /** Does `mark` hold of it or of anything it may call. */
    marked: (name) => (row(name)[0] & MARK) !== 0,
    /** May it reach the host (a function the user imports, an indirect call). */
    host: (name) => (row(name)[0] & HOST) !== 0,
    /** Does it ever return. */
    returns: (name) => !(noret.has(name) || !ids.has(name) && (foreignNoret(name) || helperKind(name) === 'throw')),
    kind,
    /** Its result types, where the module defines or imports it. */
    results: (name) => results.get(name) ?? null,
  }
}

/** A summary solved by `solve` where a pass first asks what a call writes (what a helper
 *  reads is HELPERS', asked of no solve). */
export const lazyEffects = (solve) => {
  let fx = null
  const get = () => fx ??= solve()
  return { sets: (name, g) => get().sets(name, g), setsAny: (name) => get().setsAny(name), writes: (name) => get().writes(name),
    memOf: (name) => get().memOf(name), header: (name) => get().header(name), throws: (name) => get().throws(name), marked: (name) => get().marked(name),
    host: (name) => get().host(name), returns: (name) => get().returns(name), results: (name) => get().results(name), kind }
}

/** The summary of a module of no functions: a helper answers as HELPERS says, any other name
 *  as the host (a pass run on a function alone, by a test). */
export const NO_MODULE = solveEffects([])

const branches = (n) => isArr(n) && (n[0] === 'br' || n[0] === 'br_if' || n[0] === 'br_table' || n.some(branches))
