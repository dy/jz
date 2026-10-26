/**
 * The arms of a large function, functions of their own (speed tier).
 *
 * V8 compiles a function, not a path through it: its baseline compiler when
 * the function is first called, its optimizing compiler on a background
 * thread once the function has run long enough, all of it each time. Until
 * the optimized code is in, the function runs as baseline code, three to four
 * times slower. The speed tier grows a function by fast paths (a helper's
 * fast arm at each site, a dynamic operation's dispatch over the types it may
 * meet, a loop's versions, inlined callees), and for a given input most of a
 * large function then runs rarely or never: of watr's `normalize`, 26 KB of
 * code, 85% never ran over the bench's inputs, of its `instr` 89%. V8 compiled
 * all of it, 50 ms of optimizing compile per such function on the CI runner,
 * while the bench ran in baseline code; the compile's working memory, 9 MB for
 * `normalize` and 21 MB for web-audio-api's render loop, ran four jobs at a
 * time into the process's peak.
 *
 * Here a conditional arm of a large function, an `if`'s branch or a
 * `br_table` case's body, becomes a function called where the arm was. An arm
 * that never runs is never compiled; one that runs is compiled as a unit of
 * its own, on its own thread, as soon as it is hot. A function past twice the
 * bound gives up its largest arms first, until it is within the bound: each
 * arm moved is a function the engine tiers up on its own, by its own runs, so
 * the fewer the better (an arm moved for every case left a parser 7% slower
 * where the largest alone left it 1%), and one just past the bound would give
 * up an arm or two, a small share of its compile, for a call on each run of
 * them (a parser's functions of 2300 to 3200 nodes ran 1 to 2% slower so). A
 * piece still past the bound gives up its own arms in turn, and an `else`
 * holding only the next `if` of a chain is no arm: its cases are, so a chain
 * keeps its tests in its function.
 *
 * A function still past the bound then gives up runs of its statements, each
 * within the bound, from the end of each statement list outside loops: a
 * straight body (a module assembler's sections, 12000 nodes of calls) has no
 * arm to give, and its one compile set the process's peak memory. A run is
 * whole statements that take no value from the stack and leave none, and it
 * holds no loop: the engine tiers a piece up by its own runs, so a piece
 * entered once whose loop spends its budget is compiled again for nothing (a
 * driver's timing rounds, unrolled into one function, became one compile per
 * round, each inside the round it timed).
 *
 * An arm moves with its locals by liveness: the locals live at its entry that
 * it reads or writes come in as parameters, the ones it writes that are live
 * after it go back as results (after the arm's own value), and its other
 * locals are its own (a local the arm writes on every path before reading
 * starts at zero in either place). An arm ending in a branch out (`br` to an
 * enclosing label, `return`) keeps the branch where it was: the function
 * computes the branch's values and the locals live at its target, and the
 * branch takes them from the call. An arm with any other branch out stays.
 * Under a handler (`try_table`) that reads a local the arm writes, a throw out
 * of the arm must find the local written: the function catches the handlers'
 * tag, returns its locals with the payload, and the call throws it again once
 * they are set (one tag, numeric payload, an arm without a value; otherwise the
 * arm stays).
 *
 * An arm moves only when it already makes a call other than to the math
 * runtime on every path through it: one more call is proportionate to work
 * that pays its own, where an arithmetic arm would pay a call it never paid (a
 * numeric kernel keeps every arm). A call in one of its own `if` arms or
 * dispatch cases does not count: there sits a fallback or an error path, and
 * the common path, arithmetic, would pay the call (a parser's character test
 * whose miss calls a slow scanner keeps its test inline). Inside a loop it
 * moves only when it is one case among several, a small share of the loop: the
 * loop's main path would pay the call on every pass.
 *
 * Runs last, after watr's inliner (which would splice a single-caller piece
 * back), and appends the new functions after every existing one, so no
 * function index changes.
 *
 * @module optimize/split-funcs
 */

const isArr = Array.isArray
const isName = (x) => typeof x === 'string' && x.length > 1 && x.charCodeAt(0) === 36
/** A function past this many instruction nodes gives up its largest arms until it is within
 *  SPLIT_TO: V8's optimizing compile of a function this size takes milliseconds. One just past
 *  SPLIT_TO would give up an arm or two, a small share of its compile for a call on each run of
 *  the arm. */
export const SPLIT_FN = 4000
/** The size a split function is brought down to (instruction nodes). */
export const SPLIT_TO = 2000
/** An arm this large (instruction nodes) moves: a call and its moves cost little against it. */
export const SPLIT_ARM = 150
/** Inside a loop, an arm moves when the loop is this many times its size: one case of a dispatch
 *  (watr's `normalize` loops over instructions, each kind an arm), not the work of each pass (a
 *  copy loop's checked store, run for every element). */
const LOOP_SHARE = 4
// JZ_DEBUG_SPLIT=all moves every arm the rules allow, whatever its size (a stress of the moves);
// =log names each arm moved
const DBG = typeof process === 'undefined' ? '' : process.env?.JZ_DEBUG_SPLIT || ''

const BR = new Set(['br', 'br_if', 'br_table'])
const RETURNS = new Set(['return', 'return_call', 'return_call_indirect', 'return_call_ref'])
const ENDS = new Set(['return', 'unreachable', 'throw', 'throw_ref', 'return_call', 'return_call_indirect', 'return_call_ref'])
const CALLS = new Set(['call', 'call_indirect', 'call_ref'])
const STRUCT = new Set(['block', 'loop', 'if', 'try_table'])
const HEADER = new Set(['export', 'type', 'param', 'result', 'local', 'import'])
const BLOCK_HEAD = new Set(['result', 'param', 'type'])
const NUMERIC = new Set(['i32', 'i64', 'f32', 'f64'])
const NONE = new Set()
/** No handler around: nothing a throw must carry. `keep` holds what the handlers around read,
 *  `tag` the one tag they catch (null: none around, false: more than one, or a catch that takes
 *  any exception or its reference, which a function cannot throw again as it was). */
const OPEN = { keep: NONE, tag: null }

const size = (n) => {
  if (!isArr(n)) return 0
  let s = 1
  for (let i = 1; i < n.length; i++) s += size(n[i])
  return s
}
const union = (a, b) => { for (const x of b) a.add(x); return a }
/** The math runtime depends only on its operands (pure-funcs.js pureKernel): a call to it is arithmetic. */
const pureCall = (name) => typeof name === 'string' && name.startsWith('$math.') && !name.startsWith('$math.random')

/**
 * Backward liveness over structured code (after optimize/loop-compact.js): the locals live before
 * a node, from those live after it. `env` maps each enclosing label to what is live where a branch
 * to it lands and the values it takes. `h` holds what the handlers of the enclosing `try_table`s
 * read, live at every point of their bodies (any call there may land in one; no write there kills
 * it), and the tag they catch. `seen` records, for each statement list that may move, what is live
 * after it, the labels around it and the handlers.
 */
const liveIn = (n, out, env, h, seen) => {
  if (!isArr(n)) return out
  const op = n[0]
  if (op === 'local.get') return out.has(n[1]) ? out : union(new Set(out), [n[1]])
  if (op === 'local.set' || op === 'local.tee') {
    const live = new Set(out)
    if (!h.keep.has(n[1])) live.delete(n[1])
    return n.length > 2 ? liveIn(n[2], live, env, h, seen) : live
  }
  if (BR.has(op)) {
    // what follows an unconditional branch never runs
    let live = op === 'br' ? h.keep : out
    for (let i = n.length - 1; i >= 1; i--) {
      if (isName(n[i])) { const at = env.get(n[i]); live = union(new Set(live), at ? at.live : NONE) }
      else live = liveIn(n[i], live, env, h, seen)
    }
    return live
  }
  if (ENDS.has(op)) {
    let live = h.keep
    for (let i = n.length - 1; i >= 1; i--) live = liveIn(n[i], live, env, h, seen)
    return live
  }
  if (op === 'block' || op === 'loop') {
    const label = isName(n[1]) ? n[1] : null
    if (op === 'block') {
      const inner = label ? new Map(env).set(label, { live: out, types: resultOf(n) }) : env
      if (seen) seen.set(n, { live: out, env: inner, h })
      return liveSeq(n, out, inner, h, seen)
    }
    // a branch back to the loop brings in its own live-in: the least fixed point
    const inner = new Map(env)
    let live = out
    for (;;) {
      if (label) inner.set(label, { live, types: null })
      const next = liveSeq(n, out, inner, h, seen)
      let grew = false
      for (const x of next) if (!live.has(x)) { grew = true; break }
      if (!grew) { live = next; break }
      live = union(new Set(live), next)
    }
    // (a loop's own list: what is live after it, and the head's live-in at its label)
    if (seen) seen.set(n, { live: out, env: inner, h })
    return live
  }
  if (op === 'try_table') {
    const keep = new Set(h.keep)
    let tag = h.tag
    for (let i = 1; i < n.length; i++) {
      const c = n[i]
      if (!isArr(c) || typeof c[0] !== 'string' || !c[0].startsWith('catch')) continue
      const at = env.get(c[c.length - 1])
      if (at) union(keep, at.live)
      tag = c[0] === 'catch' && isName(c[1]) && (tag === null || tag === c[1]) ? c[1] : false
    }
    const inner = { keep, tag }
    return liveSeq(n, union(new Set(out), keep), env, inner, seen)
  }
  if (op === 'if') {
    if (isName(n[1])) env = new Map(env).set(n[1], { live: out, types: resultOf(n) })
    let arms = null, hasElse = false
    for (let i = n.length - 1; i >= 1; i--) {
      const c = n[i]
      if (!isArr(c) || (c[0] !== 'then' && c[0] !== 'else')) continue
      if (seen) { const was = seen.get(c); seen.set(c, { live: was ? union(new Set(was.live), out) : out, env, h }) }
      arms = union(arms ?? new Set(), liveSeq(c, out, env, h, seen))
      if (c[0] === 'else') hasElse = true
    }
    let cond = arms ? (hasElse ? arms : union(arms, out)) : out
    for (let i = n.length - 1; i >= 1; i--) {
      const c = n[i]
      if (isArr(c) && !BLOCK_HEAD.has(c[0]) && c[0] !== 'then' && c[0] !== 'else') cond = liveIn(c, cond, env, h, seen)
    }
    return cond
  }
  return liveSeq(n, out, env, h, seen)
}
/** The children of `n` from `from` on, in order, each seeing what the next needs. */
const liveSeq = (n, out, env, h, seen, from = 1) => {
  let live = out
  for (let i = n.length - 1; i >= from; i--) if (isArr(n[i]) && !BLOCK_HEAD.has(n[i][0])) live = liveIn(n[i], live, env, h, seen)
  return live
}
/** The result types a block, loop or `if` declares (null for none). */
const resultOf = (n) => {
  for (let i = 1; i < n.length; i++) {
    const c = n[i]
    if (isArr(c) && c[0] === 'result') return c.slice(1)
    if (isArr(c) && !BLOCK_HEAD.has(c[0])) break
  }
  return null
}

/** What the statements of `list` touch: locals read and written, labels defined and branched to,
 *  whether they return or use what this pass does not read. */
const scan = (list) => {
  const acc = { reads: new Set(), writes: new Set(), defs: new Set(), refs: new Set(), returns: false, opaque: false }
  const visit = (n) => {
    if (!isArr(n)) return
    const op = n[0]
    if (op === 'local.get') acc.reads.add(n[1])
    else if (op === 'local.set' || op === 'local.tee') acc.writes.add(n[1])
    else if (RETURNS.has(op)) acc.returns = true
    else if (op === 'delegate' || op === 'rethrow' || op === 'try') acc.opaque = true
    if (STRUCT.has(op) && isName(n[1])) acc.defs.add(n[1])
    if (BR.has(op)) {
      for (let i = 1; i < n.length; i++) {
        if (isName(n[i])) acc.refs.add(n[i])
        else if (!isArr(n[i])) acc.opaque = true
      }
    }
    if (typeof op === 'string' && op.startsWith('catch')) { const l = n[n.length - 1]; if (isName(l)) acc.refs.add(l); else acc.opaque = true }
    for (let i = 1; i < n.length; i++) if (isArr(n[i])) visit(n[i])
  }
  for (const n of list) visit(n)
  return acc
}

/** Whether `list` makes a call, other than to the math runtime, on every path through it:
 *  one in an `if`'s arm, or in a dispatch's case body (what follows the block a `br_table`
 *  leaves), runs on some paths only. */
const callsAlways = (list) => {
  const visit = (n) => {
    if (!isArr(n)) return false
    const op = n[0]
    if (op === 'then' || op === 'else') return false
    if (CALLS.has(op) && !(op === 'call' && pureCall(n[1]))) return true
    let end = n.length
    if (op === 'block') {
      let i = 1
      while (i < n.length && (isName(n[i]) || (isArr(n[i]) && BLOCK_HEAD.has(n[i][0])))) i++
      // a dispatch's cases: the statements after the block its table leaves
      if (i < n.length - 1 && isArr(n[i]) && n[i][0] === 'block') end = i + 1
    }
    for (let i = 1; i < end; i++) if (visit(n[i])) return true
    return false
  }
  return list.some(visit)
}

const holdsLoop = (n) => isArr(n) && (n[0] === 'loop' || n.some(holdsLoop))
const STORE = /^(?:i32|i64|f32|f64|v128)\.store/
/** Whether statement `n` takes no value from the stack and leaves none, its operands folded in:
 *  only a run of such statements can become a call (a stack-style operand, or a value a later
 *  statement takes, would be cut off). `sigs` holds each function's parameter and result counts. */
const whole = (n, sigs) => {
  if (!isArr(n)) return false
  const op = n[0]
  let kids = 0
  for (let i = 1; i < n.length; i++) if (isArr(n[i]) && !BLOCK_HEAD.has(n[i][0])) kids++
  if (op === 'local.set' || op === 'global.set' || op === 'drop') return kids === 1
  if (STORE.test(op)) return kids === 2
  if (op === 'memory.copy' || op === 'memory.fill') return kids === 3
  if (op === 'nop') return true
  if (op === 'block' || op === 'loop') return !resultOf(n) && !n.some(c => isArr(c) && c[0] === 'param')
  // (folded: its condition is an operand)
  if (op === 'if') return !resultOf(n) && n.some((c, i) => i > 0 && isArr(c) && c[0] !== 'then' && c[0] !== 'else' && !BLOCK_HEAD.has(c[0]))
  if (op === 'call') { const g = sigs.get(n[1]); return !!g && !g.results && kids === g.params }
  return false
}

/** The parameter and result counts of each function the module declares or imports by its own
 *  signature (one named by a type use is left out). */
const signatures = (module) => {
  const sigs = new Map()
  const note = (f) => {
    if (!isArr(f) || f[0] !== 'func' || !isName(f[1])) return
    let params = 0, results = 0
    for (const d of f) {
      if (!isArr(d)) continue
      if (d[0] === 'type') return
      if (d[0] === 'param') params += isName(d[1]) ? 1 : d.length - 1
      else if (d[0] === 'result') results += d.length - 1
    }
    sigs.set(f[1], { params, results })
  }
  for (const n of module) if (isArr(n)) { if (n[0] === 'func') note(n); else if (n[0] === 'import') note(n[n.length - 1]) }
  return sigs
}

/** The numeric payload types of each tag the module declares or imports (a tag of any other
 *  payload, or one named by a type use, is left out). */
const tagPayloads = (module) => {
  const tags = new Map()
  const note = (t) => {
    if (!isArr(t) || t[0] !== 'tag' || !isName(t[1])) return
    const types = []
    for (let i = 2; i < t.length; i++) {
      const c = t[i]
      if (!isArr(c)) continue
      if (c[0] !== 'param') return
      for (let j = 1; j < c.length; j++) { if (!NUMERIC.has(c[j])) return; types.push(c[j]) }
    }
    tags.set(t[1], types)
  }
  for (const n of module) if (isArr(n)) { if (n[0] === 'tag') note(n); else if (n[0] === 'import') note(n[n.length - 1]) }
  return tags
}

/**
 * Split the large functions of `module` (watr's module array) in place.
 * @param {Array} module
 * @param {{ fnMin?: number, fnTo?: number, armMin?: number }} [opts]
 * @returns {number} the functions made
 */
export function splitFuncs(module, { fnMin = SPLIT_FN, fnTo = Math.min(SPLIT_TO, fnMin), armMin = SPLIT_ARM } = {}) {
  if (!isArr(module)) return 0
  if (DBG === 'all') { fnMin = fnTo = 0; armMin = Math.min(armMin, 4) }
  const names = new Set()
  for (const n of module) if (isArr(n) && n[0] === 'func' && isName(n[1])) names.add(n[1])
  const large = module.filter(fn => isArr(fn) && fn[0] === 'func' && isName(fn[1]) && size(fn) > fnMin)
  // a statement list two places hold (a pass may share a subtree) is left in place: moving it
  // would move it out of both
  const once = new WeakSet(), shared = new WeakSet()
  const share = (n) => { shared.add(n); for (let i = 1; i < n.length; i++) if (isArr(n[i])) share(n[i]) }
  const mark = (n) => {
    if (once.has(n)) { share(n); return }
    once.add(n)
    for (let i = 1; i < n.length; i++) if (isArr(n[i])) mark(n[i])
  }
  for (const n of module) if (isArr(n) && n[0] === 'func') mark(n)
  const ctx = { fnTo, armMin, names, made: [], runs: new WeakSet(), shared, sigs: signatures(module), tags: tagPayloads(module) }
  for (const fn of large) splitFunc(fn, ctx)
  // a piece still past the bound gives up its own arms (it took its arms' arms with it), and one
  // made of an arm its runs
  for (let i = 0; i < ctx.made.length; i++) if (size(ctx.made[i]) > fnTo) splitFunc(ctx.made[i], ctx)
  for (const piece of ctx.made) module.push(piece)
  return ctx.made.length
}

/** The compaction's kernels (module/core/compact.js): a loop's compaction site roots its own
 *  function's locals, so the statements around one stay in that function. */
const COMPACTS = new Set(['$__gc_begin', '$__gc_walk', '$__gc_move', '$__gc_thresh'])

/**
 * Each pass of a loop that runs a loop, a function of its own, in a function that runs once
 * (speed tier).
 *
 * V8 replaces a function's code between its calls only, never inside one (it has no on-stack
 * replacement for wasm): a function its caller enters once runs as baseline code for as long as
 * that call lasts, whatever its loops do. A program's work is often a loop nest in such a
 * function: a driver's rounds each running a sweep (a bench's timing loop over the kernel the
 * inliner spliced into it), a command's passes over its input. All of it ran as baseline code,
 * two to four times slower (stdlib-ddot's rounds). Here the pass of such an outer loop is a
 * call: the first runs as baseline code and spends the budget that queues the function's
 * optimizing compile, the later ones run the optimized code.
 *
 * A function runs once when it is an export of the program's own (`entries`: the runtime's,
 * `__compact` and its kin, the host calls again and again) no function calls, or when its one call
 * is outside every loop of a function that runs once. A loop of it holding a loop, outside
 * any loop of its own, of a few passes (`fewPasses`: a counter stepped by one from zero or
 * above to a bound of at most PASS_MAX, so each of the passes a long call makes is long), gives up
 * the longest run of its statements that holds the inner loop: whole statements (`whole`),
 * between the loop's tests, branching only inside the run, whatever its size (a call per pass is
 * nothing beside the loop it runs once the pass is optimized code, and baseline code is slower by
 * more); its locals go in and come back by liveness as an arm's do. A loop of many passes or of
 * passes a runtime value counts stays, as a frame's loop over its rows does: its passes may be
 * short, where a call each would cost. A run that compacts stays: the compaction roots its own
 * function's locals.
 * @param {Array} module
 * @param {{ user?: (name: string) => boolean }} [opts] whether a function is the program's own
 *   (every function, where not given)
 * @returns {number} the functions made
 */
const PASS_MAX = 256
/** The counter of `loop`'s passes and its bound: a test of a counter stepped by one, against a
 *  constant, as the loop's last statement (`br_if $loop (lt (local.tee $i (add (get $i) 1)) N)`,
 *  or the step the statement before it) or as its first, the step last before the branch back
 *  (`br_if $exit (ge (get $i) N) … (local.set $i (add (get $i) 1)) (br $loop)`). Null otherwise. */
const passCounter = (loop) => {
  const label = isName(loop[1]) ? loop[1] : null, last = loop.at(-1)
  if (!label || !isArr(last)) return null
  const stepOf = (e, name, t) => isArr(e) && e[0] === `${t}.add` && isArr(e[1]) && e[1][0] === 'local.get' && e[1][1] === name && isArr(e[2]) && e[2][0] === `${t}.const` && Number(e[2][1]) === 1
  const typeOf = (op, lt) => (lt ? op === 'i32.lt_s' || op === 'i32.lt_u' : op === 'i32.ge_s' || op === 'i32.ge_u') ? 'i32' : op === (lt ? 'f64.lt' : 'f64.ge') ? 'f64' : null
  const stepBefore = (name, t) => { const s = loop.at(-2); return isArr(s) && s[0] === 'local.set' && s[1] === name && stepOf(s[2], name, t) ? s : null }
  if (last[0] === 'br_if' && last[1] === label && isArr(last[2]) && last[2].length === 3) {
    const [op, test, bound] = last[2], t = typeOf(op, true)
    if (!t || !isArr(bound) || bound[0] !== `${t}.const` || !isArr(test)) return null
    if (test[0] === 'local.tee' && stepOf(test[2], test[1], t)) return { i: test[1], t, n: Number(bound[1]), step: test }
    const step = test[0] === 'local.get' ? stepBefore(test[1], t) : null
    return step ? { i: test[1], t, n: Number(bound[1]), step } : null
  }
  if (last[0] === 'br' && last[1] === label) {
    let k = 2
    while (k < loop.length && isArr(loop[k]) && BLOCK_HEAD.has(loop[k][0])) k++
    const head = loop[k]
    if (!isArr(head) || head[0] !== 'br_if' || head[1] === label || !isArr(head[2]) || head[2].length !== 3) return null
    const [op, get, bound] = head[2], t = typeOf(op, false)
    if (!t || !isArr(get) || get[0] !== 'local.get' || !isArr(bound) || bound[0] !== `${t}.const`) return null
    const step = stepBefore(get[1], t)
    return step ? { i: get[1], t, n: Number(bound[1]), step } : null
  }
  return null
}
/** Whether `loop`, outside every loop of `fn`, runs at most PASS_MAX passes: its counter
 *  (`passCounter`) is bounded by at most PASS_MAX, the loop writes it nowhere but its step, and
 *  what it holds on entry is zero or above: no parameter, the latest write before the loop a
 *  statement setting a constant (it runs on every way there: no loop is around), or none (a
 *  local starts at zero). */
const fewPasses = (loop, fn) => {
  const c = passCounter(loop)
  if (!c || !(c.n >= 1 && c.n <= PASS_MAX) || !isName(c.i) || fn.some(d => isArr(d) && d[0] === 'param' && d[1] === c.i)) return false
  const writes = (n, skip = null) => isArr(n) && n !== skip && (((n[0] === 'local.set' || n[0] === 'local.tee') && n[1] === c.i) || n.some(x => writes(x, skip)))
  if (loop.some((x, k) => k > 0 && writes(x, c.step))) return false
  // the way down to the loop; what comes before it on that way runs before it
  const path = []
  const find = (n) => { if (n === loop) return true; if (!isArr(n)) return false; for (let k = 1; k < n.length; k++) { path.push([n, k]); if (find(n[k])) return true; path.pop() } return false }
  if (!find(fn)) return false
  for (let p = path.length - 1; p >= 0; p--) {
    const [node, k] = path[p]
    for (let j = k - 1; j >= 1; j--) if (writes(node[j]))
      return node[j][0] === 'local.set' && node[j][1] === c.i && isArr(node[j][2]) && node[j][2][0] === `${c.t}.const` && Number(node[j][2][1]) >= 0
  }
  return true
}

export function loopPasses(module, { user = () => true } = {}) {
  if (!isArr(module)) return 0
  const funcs = new Map(), names = new Set(), entries = new Set()
  for (const n of module) {
    if (!isArr(n)) continue
    if (n[0] === 'func' && isName(n[1])) {
      funcs.set(n[1], n); names.add(n[1])
      if (n.some(d => isArr(d) && d[0] === 'export') && user(n[1])) entries.add(n[1])
    } else if (n[0] === 'export') for (const d of n) if (isArr(d) && d[0] === 'func' && isName(d[1]) && user(d[1])) entries.add(d[1])
  }
  // every direct call: its caller and whether a loop of the caller holds it
  const sites = new Map()
  for (const [name, fn] of funcs) {
    const visit = (n, inLoop) => {
      if (!isArr(n)) return
      if ((n[0] === 'call' || n[0] === 'return_call') && isName(n[1])) {
        const at = sites.get(n[1])
        if (at) at.push({ caller: name, inLoop }); else sites.set(n[1], [{ caller: name, inLoop }])
      }
      for (let i = 1; i < n.length; i++) visit(n[i], inLoop || n[0] === 'loop')
    }
    visit(fn, false)
  }
  const memo = new Map()
  const once = (name) => {
    if (memo.has(name)) return memo.get(name)
    memo.set(name, false)
    const at = sites.get(name) ?? []
    const r = at.length === 0 ? entries.has(name) : at.length === 1 && !at[0].inLoop && once(at[0].caller)
    memo.set(name, r)
    return r
  }
  const shared = new WeakSet(), seenNode = new WeakSet()
  const mark = (n) => {
    if (seenNode.has(n)) { shared.add(n); return }
    seenNode.add(n)
    for (let i = 1; i < n.length; i++) if (isArr(n[i])) mark(n[i])
  }
  for (const fn of funcs.values()) mark(fn)
  const ctx = { armMin: 0, names, made: [], shared, sigs: signatures(module), tags: tagPayloads(module) }
  const compacts = (n) => isArr(n) && ((n[0] === 'call' && COMPACTS.has(n[1])) || n.some(compacts))
  for (const [name, fn] of funcs) {
    if (!once(name) || !holdsLoop(fn)) continue
    // the loops outside any loop, each holding a loop
    const outer = []
    const find = (n) => {
      if (!isArr(n)) return
      if (n[0] === 'loop') { if (n.some((c, i) => i > 0 && holdsLoop(c))) outer.push(n); return }
      for (let i = 1; i < n.length; i++) find(n[i])
    }
    find(fn)
    if (!outer.length) continue
    const m = mover(fn, ctx)
    if (!m) continue
    const before = ctx.made.length
    for (const loop of outer) {
      const at = m.seen.get(loop)
      if (!at || shared.has(loop) || !fewPasses(loop, fn)) continue
      let start = 1
      while (start < loop.length && (isName(loop[start]) || (isArr(loop[start]) && BLOCK_HEAD.has(loop[start][0])))) start++
      // the longest window of whole statements, each branching only inside itself, that holds a loop
      let best = null
      for (let i = start; i < loop.length;) {
        const fits = (s) => { if (!whole(s, ctx.sigs) || compacts(s)) return false; const a = scan([s]); return !a.returns && !a.opaque && [...a.refs].every(r => a.defs.has(r)) }
        if (!fits(loop[i])) { i++; continue }
        let j = i, s = 0, inner = false
        while (j < loop.length && fits(loop[j])) { s += size(loop[j]); inner ||= holdsLoop(loop[j]); j++ }
        if (inner && (!best || s > best.s)) best = { from: i, end: j, s }
        i = j
      }
      if (best) m.tryMove(loop, best.from, at, size(loop), [], best.end, true)
    }
    if (ctx.made.length !== before) m.finish()
  }
  for (const piece of ctx.made) module.push(piece)
  return ctx.made.length
}

/** What moving a piece of `fn` into a function reads of it: its locals' types, results, liveness
 *  and the move itself (`tryMove`), and `finish`, which drops the locals only moved pieces used.
 *  Null where a local has no name of its own. */
function mover(fn, { armMin, names, made, shared, tags }) {
  const types = new Map()
  // the results, where the function declares them (a type use alone leaves them unread)
  let results = null, typed = false
  let body = fn.length
  for (let i = 2; i < fn.length; i++) {
    const d = fn[i]
    if (!isArr(d) || !HEADER.has(d[0])) { body = i; break }
    if (d[0] === 'param' || d[0] === 'local') {
      // a declaration without a name (`(local i32 i32)`) cannot be told apart by its reads
      if (!isName(d[1]) || d.length !== 3) return null
      types.set(d[1], d[2])
    }
    else if (d[0] === 'result') results = [...(results ?? []), ...d.slice(1)]
    else if (d[0] === 'type') typed = true
  }
  if (!typed && !results) results = []
  const seen = new Map()
  liveSeq(fn, NONE, new Map(), OPEN, seen, body)
  let k = 0
  const fresh = (tail) => {
    let name
    do { name = fn[1] + '$' + tail + k++ } while (names.has(name) || types.has(name))
    names.add(name)
    return name
  }
  // locals the calls of handler-crossing arms need, declared once the arms have moved
  const added = []

  /** Move `list[from..end)` (an arm, a case body, or a run of whole statements) into a function,
   *  if it qualifies. `free`: a loop's pass (`loopPasses`), which moves for the engine's tiers
   *  whatever its calls and its share of the loop. */
  const tryMove = (list, from, at, loop, armTypes, end = list.length, free = false) => {
    if (!at || shared.has(list) || end - from < 1) return
    let s = 0
    for (let i = from; i < end; i++) s += size(list[i])
    if (s < armMin) return
    // a branch out at the end stays where it is: the function computes its values (a run has
    // none, and what is live after it is what the rest of its list reads)
    let to = end
    const last = list[to - 1]
    let exit = null, exitTypes = null, after = at.live
    if (end < list.length) { after = liveSeq(list, at.live, at.env, at.h, null, end); armTypes = [] }
    else if (isArr(last) && (last[0] === 'return' || (last[0] === 'br' && isName(last[1])))) {
      if (last[0] === 'return') { if (!results) return; exitTypes = results; after = NONE }
      else {
        const target = at.env.get(last[1])
        if (!target) return
        exitTypes = target.types ?? []; after = target.live
      }
      exit = last
      to--
    }
    // the statements in order, then the exit's operands: what the function runs
    const run = list.slice(from, to)
    if (exit) for (let i = exit[0] === 'br' ? 2 : 1; i < exit.length; i++) run.push(exit[i])
    const acc = scan(run)
    if (acc.returns || acc.opaque) return
    for (const r of acc.refs) if (!acc.defs.has(r)) return
    // an arm moves when it makes calls of its own on every path, to which one more is
    // proportionate (arithmetic would pay a call it never paid), and inside a loop only when it
    // is one case among several (the loop's main path would pay a call each pass)
    if (!free && (!callsAlways(run) || (loop > 0 && s * LOOP_SHARE > loop))) return
    for (const l of acc.reads) if (!types.has(l)) return
    for (const l of acc.writes) if (!types.has(l)) return
    const valueTypes = exit ? exitTypes : (armTypes ?? [])
    // a handler around reads what the arm writes: a throw out of the function must carry it
    let crossing = false
    for (const l of acc.writes) if (at.h.keep.has(l)) { crossing = true; break }
    const payload = crossing ? tags.get(at.h.tag) : null
    if (crossing && (!payload || exit || valueTypes.length)) return
    const entry = liveSeq(['', ...run], after, at.env, at.h, null)
    const ins = [], outs = [], own = []
    for (const l of types.keys()) {
      if (!acc.reads.has(l) && !acc.writes.has(l)) continue
      if (entry.has(l)) ins.push(l)
      else own.push(l)
      if (acc.writes.has(l) && (after.has(l) || at.h.keep.has(l))) outs.push(l)
    }
    const name = fresh('s')
    const piece = ['func', name]
    for (const l of ins) piece.push(['param', l, types.get(l)])
    const res = [...valueTypes, ...outs.map(l => types.get(l))]
    if (crossing) res.push('i32', ...payload)
    if (res.length) piece.push(['result', ...res])
    for (const l of own) piece.push(['local', l, types.get(l)])
    const gets = outs.map(l => ['local.get', l])
    const call = ['call', name]
    for (const l of ins) call.push(['local.get', l])
    const tail = [call]
    if (!crossing) {
      piece.push(...run, ...gets)
      for (let i = outs.length - 1; i >= 0; i--) tail.push(['local.set', outs[i]])
      if (exit) tail.push(exit[0] === 'br' ? ['br', exit[1]] : ['return'])
    } else {
      // the tag caught in the function: its locals, a flag and the payload come back, and the
      // call throws the payload again once the locals are set
      const caught = fresh('c'), cs = payload.map(() => fresh('p'))
      const ps = payload.map(() => fresh('p')), flag = fresh('f')
      for (let i = 0; i < payload.length; i++) piece.push(['local', cs[i], payload[i]])
      piece.push(['block', caught, ['result', ...payload],
        ['try_table', ['catch', at.h.tag, caught], ...run],
        ['return', ...gets, ['i32.const', '0'], ...payload.map(t => [`${t}.const`, '0'])]])
      for (let i = payload.length - 1; i >= 0; i--) piece.push(['local.set', cs[i]])
      piece.push(...gets, ['i32.const', '1'], ...cs.map(c => ['local.get', c]))
      for (let i = payload.length - 1; i >= 0; i--) tail.push(['local.set', ps[i]])
      tail.push(['local.set', flag])
      for (let i = outs.length - 1; i >= 0; i--) tail.push(['local.set', outs[i]])
      tail.push(['if', ['local.get', flag], ['then', ['throw', at.h.tag, ...ps.map(p => ['local.get', p])]]])
      added.push(['local', flag, 'i32'], ...ps.map((p, i) => ['local', p, payload[i]]))
    }
    made.push(piece)
    if (DBG === 'log') console.error(`split ${name}: ${s} nodes, loop ${loop}, ${ins.length} in, ${outs.length} out${exit ? `, exit ${exit[0]}` : ''}${crossing ? ', crossing' : ''}`)
    list.splice(from, end - from, ...tail)
    return piece
  }

  // the locals only the moved pieces used leave the function (the engine zeroes each at entry)
  const finish = () => {
    const used = new Set()
    const note = (n) => {
      if (!isArr(n)) return
      if ((n[0] === 'local.get' || n[0] === 'local.set' || n[0] === 'local.tee') && isName(n[1])) used.add(n[1])
      for (let i = 1; i < n.length; i++) if (isArr(n[i])) note(n[i])
    }
    for (let i = body; i < fn.length; i++) note(fn[i])
    for (let i = body - 1; i >= 2; i--) if (isArr(fn[i]) && fn[i][0] === 'local' && !used.has(fn[i][1])) { fn.splice(i, 1); body-- }
    fn.splice(body, 0, ...added)
  }
  return { body, seen, tryMove, finish }
}

function splitFunc(fn, ctx) {
  const { fnTo, armMin, made, runs, sigs } = ctx
  const m = mover(fn, ctx)
  if (!m) return
  const { body, seen, tryMove } = m

  // the arms and case bodies, largest first; `loop` is the size of the innermost loop around (as
  // written), 0 outside any
  const arms = []
  const collect = (n, loop, armTypes) => {
    if (!isArr(n)) return
    const op = n[0]
    const inner = op === 'loop' ? size(n) : loop
    for (let i = 1; i < n.length; i++) if (isArr(n[i])) collect(n[i], inner, op === 'if' ? resultOf(n) : null)
    if (op === 'then' || (op === 'else' && !(n.length === 2 && isArr(n[1]) && n[1][0] === 'if'))) arms.push([n, 1, loop, armTypes, size(n)])
    else if (op === 'block') {
      // a case body: what follows the block the dispatch leaves
      let i = 1
      while (i < n.length && (isName(n[i]) || (isArr(n[i]) && BLOCK_HEAD.has(n[i][0])))) i++
      if (i < n.length - 1 && isArr(n[i]) && n[i][0] === 'block' && !resultOf(n) && !resultOf(n[i])) arms.push([n, i + 1, loop, null, size(n)])
    }
  }
  for (let i = body; i < fn.length; i++) collect(fn[i], 0, null)
  arms.sort((a, b) => b[4] - a[4])
  // an arm inside one moved left with it
  const gone = new WeakSet()
  const leave = (n) => { if (!isArr(n)) return; gone.add(n); for (let i = 1; i < n.length; i++) leave(n[i]) }
  const before = made.length
  let left = size(fn)
  for (const [list, from, loop, armTypes] of arms) {
    if (left <= fnTo) break
    if (gone.has(list)) continue
    const moved = list.slice(from), count = made.length
    tryMove(list, from, seen.get(list), loop, armTypes)
    if (made.length === count) continue
    for (const st of moved) { leave(st); left -= size(st) }
    for (let i = from; i < list.length; i++) left += size(list[i])
  }
  // still past the bound: the runs of whole statements its lists outside loops hold move, the
  // longest lists first and from the end of each, a run within the bound (a whole list is an
  // arm's or the function's; a piece made of a run keeps its own; inside a loop each pass would
  // pay a run's call). A statement holding a loop ends a run: the engine tiers a function up by
  // its own runs, and a piece entered once whose loop spends its budget is compiled again for
  // nothing, in the middle of the work (a driver's unrolled timing rounds, one piece each).
  if (left > fnTo && !runs.has(fn)) {
    const runMax = Math.max(fnTo, armMin)
    seen.set(fn, { live: NONE, env: new Map(), h: OPEN })
    const lists = [[fn, body, Infinity]]
    const gather = (n, inLoop) => {
      if (!isArr(n) || gone.has(n)) return 0
      let s = 1
      for (let i = 1; i < n.length; i++) s += gather(n[i], inLoop || n[0] === 'loop')
      if (s >= armMin && !inLoop && seen.has(n)) {
        if (n[0] === 'then' || n[0] === 'else') lists.push([n, 1, s])
        else if (n[0] === 'block') {
          let i = 1
          while (i < n.length && (isName(n[i]) || (isArr(n[i]) && BLOCK_HEAD.has(n[i][0])))) i++
          lists.push([n, i, s])
        }
      }
      return s
    }
    for (let i = body; i < fn.length; i++) gather(fn[i], false)
    lists.sort((a, b) => b[2] - a[2])
    for (const [list, start] of lists) {
      let end = list.length
      while (left > fnTo && end > start) {
        let from = end, s = 0
        while (from > start && whole(list[from - 1], sigs) && !holdsLoop(list[from - 1]) && s + size(list[from - 1]) <= runMax) s += size(list[--from])
        if (from === end || (from === start && end === list.length)) { end--; continue }
        const moved = list.slice(from, end), rest = list.length - end
        const piece = tryMove(list, from, seen.get(list), 0, null, end)
        if (!piece) { end--; continue }
        runs.add(piece)
        for (const st of moved) { leave(st); left -= size(st) }
        for (let i = from; i < list.length - rest; i++) left += size(list[i])
        end = from
      }
    }
  }
  if (made.length !== before) m.finish()
}
