import { isMemWrite } from 'watr/optimize'
import { walkAst } from '../ast.js'
import { matchIncN, constNum } from '../optimize/vectorize/addr-model.js'
import { ctx } from '../ctx.js'
import { REP_FIELDS } from '../reps.js'
import { isExported } from './func-exports.js'

/** Serialize a ValueRep entry into a plain object for inspect output.
 *  Omits undefined fields so consumers can JSON-stringify without noise.
 *  Iterates REP_FIELDS (the closed shape in reps.js) so it can't drift. */
const repView = (rep) => {
  if (!rep) return null
  const out = {}
  for (const k of REP_FIELDS) if (rep[k] != null) out[k] = rep[k]
  return Object.keys(out).length ? out : null
}

/** Capture a function's inferred shape into ctx.inspect.functions. Called after
 *  analyzeFuncForEmit when transform.inspect is set — reads from FunctionPlan +
 *  programFacts.paramReps, never from the live ctx.func.* (which churns per emit). */
export function captureFuncInspect(func, facts, programFacts) {
  if (!ctx.inspect || func.raw) return
  const { name, sig } = func
  const reps = facts?.localReps
  const paramNames = new Set(sig.params.map(p => p.name))
  const params = sig.params.map(p => ({
    name: p.name, type: p.type,
    ...(p.ptrKind != null ? { ptrKind: p.ptrKind } : {}),
    ...(p.ptrAux != null ? { ptrAux: p.ptrAux } : {}),
    ...(repView(reps?.get(p.name)) || {}),
  }))
  const locals = {}
  if (facts?.locals) {
    for (const [lname, ltype] of facts.locals) {
      if (paramNames.has(lname)) continue
      const v = repView(reps?.get(lname))
      locals[lname] = v ? { type: ltype, ...v } : { type: ltype }
    }
  }
  const callerReps = {}
  const cr = programFacts.paramReps?.get(name)
  if (cr) for (const [idx, r] of cr) {
    const v = repView(r)
    if (v) callerReps[idx] = v
  }
  ctx.inspect.functions[name] = {
    exported: isExported(func),
    params,
    results: sig.results.slice(),
    ...(sig.ptrKind != null ? { resultPtrKind: sig.ptrKind } : {}),
    ...(sig.ptrAux != null ? { resultPtrAux: sig.ptrAux } : {}),
    // valResult/valResultMayBeUndefined (Slice 2, .work/archive/todo.md
    // §deletion-sweep §3 "Return kinds") — narrowValResults' joined VAL
    // kind across every return site, and the mayBeUndefined OR-join riding
    // alongside it. Exposed for the same reason params/locals are: the pure-
    // analysis test harness precedent (test/types.js) this design's Slice 1
    // established, since neither fact changes emitted WAT yet.
    ...(func.valResult != null ? { valResult: func.valResult } : {}),
    ...(func.valResultMayBeUndefined ? { valResultMayBeUndefined: true } : {}),
    locals,
    ...(Object.keys(callerReps).length ? { callerReps } : {}),
  }
}

/** The arm of the guard an export opens with where init is an entry, not a
 *  start section (optimize/watr-tail.js legalizeInit):
 *  `(if (i32.eqz (global.get $__init_done)) (then …))`. It runs init where the
 *  host has not, once, before the export's own work, so the census leaves it
 *  out as it leaves out the start section: initialization may allocate
 *  persistent state (README, `memory.fixed`). */
const initArm = (n, parent) => n[0] === 'then' && Array.isArray(parent) && parent[0] === 'if' &&
  parent.some(c => Array.isArray(c) && c[0] === 'i32.eqz' && Array.isArray(c[1]) &&
    c[1][0] === 'global.get' && c[1][1] === '$__init_done')

// === Marks: the cursor stored back ===
//
// A rewound frame reads the heap's cursor as it is entered (its mark) and
// stores the mark back at each return, or hands it to the conditional
// release, `$__frame_give` (optimize/arena-rewind.js). Such a store moves the
// cursor only where something between the read and the store moved it, which
// the census of that code counts, so the store itself allocates nothing. A
// local holds a mark where every path to the point last wrote it the cursor or
// another mark: watr's local reuse gives one local a mark and an address in
// turn, so the question is asked of each point, forward over the structured
// body. A parameter holds one where every call passes one; a parameter of a
// function the host or the table can call holds any value.

const isHeapRead = (v) => Array.isArray(v) && v.length === 2 && v[0] === 'global.get' && v[1] === '$__heap'
const BOT = 0   // the state of a point no path reaches; any other is the Set of locals holding marks
const meet = (a, b) => a === BOT ? b : b === BOT ? a : new Set([...a].filter(x => b.has(x)))
const sameState = (a, b) => a === b || a !== BOT && b !== BOT && a.size === b.size && [...a].every(x => b.has(x))
const holds = (s, v) => isHeapRead(v) || Array.isArray(v) && (v[0] === 'local.get' && s !== BOT && s.has(v[1]) ||
  v[0] === 'local.tee' && holds(s, v[2]))
const ANNOT = new Set(['result', 'param', 'type', 'local', 'export', 'import'])
const EXITS = new Set(['return', 'unreachable', 'throw', 'rethrow', 'throw_ref', 'return_call', 'return_call_indirect', 'return_call_ref'])

/** One forward pass over `fn` from `entry`, the parameters that hold marks:
 *  each `global.set $__heap` whether it stores a mark back (`restoring`), and
 *  each direct call which of its arguments are marks (`args`). */
const markFlow = (fn, entry) => {
  const restoring = new Map(), args = new Map(), labels = []
  const target = (l) => {
    if (typeof l === 'number') return labels[labels.length - 1 - l]
    for (let i = labels.length - 1; i >= 0; i--) if (labels[i].name === l) return labels[i]
    return null
  }
  const branch = (l, s) => { const t = target(l); if (t) t.state = meet(t.state, s) }
  const seq = (list, s) => { for (const c of list) { if (s === BOT) return BOT; s = walk(c, s) } return s }
  const operands = (n, from) => n.slice(from).filter(c => Array.isArray(c) && !ANNOT.has(c[0]))
  const labelOf = (n) => typeof n[1] === 'string' && n[1][0] === '$' ? n[1] : null
  const walk = (n, s) => {
    if (!Array.isArray(n) || s === BOT) return s
    const op = n[0]
    if (op === 'local.set' || op === 'local.tee') {
      s = walk(n[2], s)
      if (s === BOT) return BOT
      const kept = new Set(s)
      if (holds(s, n[2])) kept.add(n[1]); else kept.delete(n[1])
      return kept
    }
    if (op === 'global.set') {
      s = walk(n[2], s)
      if (n[1] === '$__heap') restoring.set(n, holds(s, n[2]))
      return s
    }
    if (op === 'call' || op === 'return_call') {
      const marks = []
      for (const a of n.slice(2)) { s = walk(a, s); marks.push(holds(s, a)) }
      args.set(n, marks)
      return op === 'return_call' ? BOT : s
    }
    if (op === 'block' || op === 'loop' || op === 'try_table') {
      const label = { name: labelOf(n), state: BOT }
      const body = operands(n, 1).filter(c => !/^catch/.test(c[0]))
      // an exception lands at a catch's label from anywhere in the body: no mark is known there
      for (const c of n) if (Array.isArray(c) && /^catch/.test(c[0])) branch(c[c.length - 1], new Set())
      if (op !== 'loop') {
        labels.push(label)
        const out = seq(body, s)
        labels.pop()
        return meet(out, label.state)
      }
      for (let at = s; ;) {
        label.state = BOT
        labels.push(label)
        const out = seq(body, at)
        labels.pop()
        const next = meet(s, label.state)
        if (sameState(next, at)) return out
        at = next
      }
    }
    if (op === 'if') {
      const parts = operands(n, 1), cond = parts.filter(c => c[0] !== 'then' && c[0] !== 'else')
      const then = parts.find(c => c[0] === 'then'), els = parts.find(c => c[0] === 'else')
      s = seq(cond, s)
      if (s === BOT) return BOT
      const label = { name: labelOf(n), state: BOT }
      labels.push(label)
      const a = then ? seq(operands(then, 1), s) : s, b = els ? seq(operands(els, 1), s) : s
      labels.pop()
      return meet(meet(a, b), label.state)
    }
    if (op === 'br') { branch(n[1], s); return BOT }
    if (op === 'br_if') { s = seq(operands(n, 2), s); if (s !== BOT) branch(n[1], s); return s }
    if (op === 'br_table') {
      const ls = n.slice(1).filter(c => !Array.isArray(c))
      s = seq(operands(n, 1), s)
      for (const l of ls) branch(l, s)
      return BOT
    }
    s = seq(operands(n, 1), s)
    return EXITS.has(op) ? BOT : s
  }
  walk(['block', ...fn.slice(2).filter(c => Array.isArray(c) && !ANNOT.has(c[0]))], entry)
  return { restoring, args }
}

/** Every function's heap stores that put a mark back, the parameters' marks
 *  settled across the calls that pass them. */
const heapRestores = (funcs, outside) => {
  const params = new Map(), entry = new Map()
  for (const [name, fn] of funcs) {
    const ps = fn.filter(c => Array.isArray(c) && c[0] === 'param').map(c => c[1])
    params.set(name, ps)
    entry.set(name, new Set(outside.has(name) ? [] : ps.filter(p => typeof p === 'string')))
  }
  for (let flows; ;) {
    flows = new Map()
    for (const [name, fn] of funcs) flows.set(name, markFlow(fn, entry.get(name)))
    let changed = false
    for (const [, flow] of flows) for (const [call, marks] of flow.args) {
      const own = entry.get(call[1]), ps = params.get(call[1])
      if (!own?.size) continue
      for (let i = 0; i < ps.length; i++) if (own.has(ps[i]) && !marks[i]) { own.delete(ps[i]); changed = true }
    }
    if (!changed) {
      const restoring = new Set()
      for (const [, flow] of flows) for (const [n, back] of flow.restoring) if (back) restoring.add(n)
      return restoring
    }
  }
}

/** An elem segment's functions by table slot, from its constant offset: null
 *  for a segment placed at a computed offset. */
const elemSlots = (n, into) => {
  if (n[1]?.[0] !== 'i32.const' || typeof n[1][1] !== 'number') return false
  let at = n[1][1]
  for (let i = 2; i < n.length; i++) {
    const c = n[i]
    if (c === 'func' || c === 'funcref') continue
    into[at++] = typeof c === 'string' ? c : Array.isArray(c) && c[0] === 'ref.func' ? c[1] : null
  }
  return true
}

/** Shared call/effect census of emitted code, including runtime helpers.
 *  A record holds a function's direct callees (`calls`) apart from its
 *  indirect calls (`indirect`: each call's targets, null where nothing bounds
 *  them, and its source position). Before link, a call the emitter knew the
 *  closures of carries their table slots (wat/assemble/closure-table.js
 *  closureCallSlots) and lands on those alone; any other indirect call lands
 *  on an entry of the table, every entry where the table is closed. */
export function runtimeGraph(module, sharedMemory = false) {
  const funcs = new Map(), exports = [], records = new Map()
  // The closure table is closed when nothing outside the module can reach or
  // change it: declared here, neither imported nor exported, never written. A
  // call_indirect then lands on one of its elem entries, so the entries stand
  // in for the target (every jz closure has the one closure type, so these are
  // the entries of the call's signature). Any other table shape, a raw
  // funcref, or call_ref stays unknown. With no table at all the call traps;
  // that is not certified either.
  let table = false, tableOpen = false, slotted = true
  const entries = new Set(), slots = []
  for (const n of module) {
    if (!Array.isArray(n)) continue
    if (n[0] === 'func') {
      funcs.set(n[1], n)
      for (const c of n) if (Array.isArray(c) && c[0] === 'export') exports.push([JSON.parse(c[1]), n[1]])
    } else if (n[0] === 'export' && n[2]?.[0] === 'func') exports.push([JSON.parse(n[1]), n[2][1]])
    else if (n[0] === 'export' && n[2]?.[0] === 'table') tableOpen = true
    else if (n[0] === 'table') {
      table = true
      if (n.some(c => Array.isArray(c) && (c[0] === 'export' || c[0] === 'import'))) tableOpen = true
    } else if (n[0] === 'import') {
      if (n.some(c => Array.isArray(c) && c[0] === 'table')) tableOpen = true
      const f = n.find(c => Array.isArray(c) && c[0] === 'func')
      if (f) funcs.set(f[1], ['func', f[1], ['import', n[1], n[2]], ...f.slice(2)])
    }
  }
  for (const n of module) if (Array.isArray(n) && n[0] === 'elem') {
    for (const c of n) if (typeof c === 'string' && funcs.has(c)) entries.add(c)
    walkAst(n, { enter: c => { if (c[0] === 'ref.func') entries.add(c[1]) } })
    if (!elemSlots(n, slots)) slotted = false
  }
  const outside = new Set(entries)
  for (const [, f] of exports) outside.add(f)
  const restoring = heapRestores(funcs, outside)
  const sites = new Map()
  for (const [name, fn] of funcs) {
    const rec = { calls: new Set(), allocation: false, unknown: false, host: null, indirect: [] }, calls = []
    walkAst(fn, { enter: (n, parent) => {
      if (initArm(n, parent)) return false
      const op = n[0]
      if (op === 'call' || op === 'return_call') rec.calls.add(n[1])
      if (op === 'import') { rec.unknown = true; rec.host = `${JSON.parse(n[1])}.${JSON.parse(n[2])}` }
      if (/^(return_)?call_ref$/.test(op)) rec.unknown = true
      if (/^(return_)?call_indirect$/.test(op)) calls.push(n)
      if (/^table\.(set|grow|fill|copy|init)$/.test(op) || op === 'ref.func') tableOpen = true
      if (op === 'memory.grow' || op === 'table.grow' || op === 'global.set' && /^\$__heap(?:_|$)/.test(n[1]) && !restoring.has(n) ||
          sharedMemory && isMemWrite(op)) rec.allocation = true
    } })
    records.set(name, rec)
    sites.set(name, calls)
  }
  const closed = table && !tableOpen
  for (const [name, calls] of sites) {
    const rec = records.get(name)
    for (const n of calls) {
      const known = closed && slotted && Array.isArray(n.slots) ? [...new Set(n.slots.map(s => slots[s]).filter(f => f != null))] : null
      const targets = known ?? (closed && entries.size ? [...entries] : null)
      if (!targets) rec.unknown = true
      rec.indirect.push({ targets, site: n.site ?? null, slots: known ? n.slots : null })
    }
  }
  return { funcs, exports, records, closed, entries, slots: slotted ? slots : null }
}

/** Every function a record can call: its direct callees and its indirect calls' targets. */
export const calleesOf = (rec) => {
  const out = [...rec.calls]
  for (const site of rec.indirect) if (site.targets) out.push(...site.targets)
  return out
}

/** true means proved; null means unknown. Counts instructions, not latency.
 * Excludes initialization and host marshalling; never changes codegen. */
export function captureRuntimeInspect(module, sharedMemory = false) {
  const { funcs, exports, records, closed, entries } = runtimeGraph(module, sharedMemory)
  const costs = new Map()
  const cost = (name, visiting = new Set()) => {
    if (costs.has(name)) return costs.get(name)
    if (!funcs.has(name) || visiting.has(name)) return null
    visiting.add(name)
    const count = n => {
      if (!Array.isArray(n)) return 0
      const op = n[0]
      if (['param', 'result', 'local', 'export', 'type'].includes(op)) return 0
      if (op === 'import' || /^(return_)?call_ref$/.test(op) ||
          /^(try|catch|throw|rethrow|delegate)/.test(op) ||
          /^(memory|table)\.(copy|fill|init|grow)$/.test(op) || /atomic\.wait/.test(op)) return null
      const indirect = /^(return_)?call_indirect$/.test(op)
      if (indirect && (!closed || !entries.size)) return null
      let total = 1
      for (let i = 1; i < n.length; i++) {
        if (Array.isArray(n[i]) && initArm(n[i], n)) continue
        const c = count(n[i])
        if (c == null) return null
        total += c
      }
      if (op === 'call' || op === 'return_call') {
        const c = cost(n[1], visiting)
        if (c == null) return null
        total += c
      }
      if (indirect) {
        // Any entry may be the target: the widest one bounds the call.
        let widest = 0
        for (const e of entries) {
          const c = cost(e, visiting)
          if (c == null) return null
          widest = Math.max(widest, c)
        }
        total += widest
      }
      if (op === 'loop') {
        if (!finiteCounterLoop(n)) return null
        // At most one full i32 domain traversal, plus the final exit check.
        // Deliberately loose: no entry-range claim is reconstructed here.
        total *= 4294967297
      }
      return Number.isSafeInteger(total) ? total : null
    }
    const result = count(funcs.get(name))
    visiting.delete(name)
    costs.set(name, result)
    return result
  }
  const result = {}
  for (const [exportName, target] of exports) {
    let noAllocation = true, noHostCalls = true
    const seen = new Set(), pending = [target]
    while (pending.length) {
      const name = pending.pop()
      if (seen.has(name)) continue
      seen.add(name)
      const rec = records.get(name)
      if (!rec || rec.unknown) { noHostCalls = null; noAllocation = null }
      if (rec?.allocation) noAllocation = null
      if (rec) for (const c of calleesOf(rec)) pending.push(c)
    }
    const maxInstructions = cost(target)
    result[exportName] = { noAllocation, noHostCalls, boundedWork: maxInstructions == null ? null : true, maxInstructions }
  }
  return result
}

// A single unconditional positive counter step and a sole back edge controlled
// by a constant upper bound. The exit interval must be wider than the step, so
// wrapping cannot skip it forever. Other loops remain unknown.
function finiteCounterLoop(loop) {
  const tail = loop[loop.length - 1]
  // The vectorizer matcher accepts decimal text; a proof must not misread
  // hexadecimal/underscored immediates as a smaller increment or bound.
  const stepOf = n => typeof n?.[2]?.[2]?.[1] === 'number' ? matchIncN(n) : null
  let cmp, step
  if (tail?.[0] === 'br_if' && tail[1] === loop[1]) {
    cmp = tail[2]
    if (cmp?.[1]?.[0] === 'local.tee') step = stepOf(['local.set', cmp[1][1], cmp[1][2]])
    else step = stepOf(loop[loop.length - 2])
  } else if (tail?.[0] === 'br' && tail[1] === loop[1]) {
    step = stepOf(loop[loop.length - 2])
    const head = loop[2]
    if (head?.[0] !== 'br_if' || head[1] === loop[1]) return false
    cmp = head[2]
    if (cmp?.[0] === 'i32.eqz') cmp = cmp[1]
    else if (cmp?.[0] === 'i32.ge_s' || cmp?.[0] === 'i32.ge_u') cmp = [cmp[0].replace('ge', 'lt'), cmp[1], cmp[2]]
    else return false
  }
  if (!step || step.c <= 0 || !Number.isInteger(step.c) || step.c > 2147483647 ||
      !['i32.lt_s', 'i32.lt_u'].includes(cmp?.[0]) ||
      !['local.get', 'local.tee'].includes(cmp?.[1]?.[0]) || cmp[1][1] !== step.name) return false
  const raw = typeof cmp[2]?.[1] === 'number' ? constNum(cmp[2]) : null
  if (!Number.isInteger(raw) || raw < -2147483648 || raw > 4294967295) return false
  const unsigned = cmp[0] === 'i32.lt_u', bound = unsigned ? raw >>> 0 : raw | 0
  if (bound > (unsigned ? 4294967295 : 2147483647) - step.c + 1) return false
  let writes = 0, backs = 0, unsafe = false
  walkAst(loop, { enter: n => {
    if ((n[0] === 'local.set' || n[0] === 'local.tee') && n[1] === step.name) writes++
    if ((n[0] === 'br' || n[0] === 'br_if') && n[1] === loop[1]) backs++
    if (n !== loop && n[0] === 'loop' || n[0] === 'br_table' ||
        /^(br|local\.(get|set|tee))/.test(n[0]) && typeof n[1] !== 'string') unsafe = true
  } })
  return !unsafe && writes === 1 && backs === 1
}
