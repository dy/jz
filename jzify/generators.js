/**
 * Generators — regenerator-style state machines, no stack suspension.
 *
 * `function* g(a) { … yield E … }` lowers to a factory arrow returning
 * `{ next, return }` closures over shared mutable state: the body becomes a
 * dispatch loop over a state local, each yield splits a state boundary, and
 * `next(v)` is an ordinary closure call through the uniform ABI (mutable
 * captures already ship). Sync only — no event loop, no microtasks.
 *
 * v1 surface (everything else rejects with a precise message):
 *   - yield as a statement, or as the RHS of `let x = yield E` / `x = yield E`
 *   - yield inside if/else, while, do-while and C-style for (any nesting)
 *   - plain `return E` anywhere; unlabeled break/continue of yield-bearing loops
 *   - compound statements WITHOUT yield stay atomic (later passes handle them)
 *   - yield* E — delegates to ANY iterator-protocol value (sent values thread,
 *     the completion value lands in `x = yield* E`)
 * Out (v1): yield inside arbitrary expressions, try across yield,
 * for-of/for-in bodies containing yield (except known-generator for-of, which
 * desugars), labeled break/continue across states.
 *
 * @module jzify/generators
 */

const isYield = (n) => Array.isArray(n) && (n[0] === 'yield' || n[0] === 'yield*')
const hasYield = (n) => Array.isArray(n) && (isYield(n) || n.some(hasYield))

// A break/continue that would bind OUTSIDE this statement (its target loop was
// decomposed into states, so the raw op would bind my dispatch while(1) instead).
// Inner loops re-bind their own jumps; arrows are their own function.
const hasFreeJump = (n, depth = 0) => {
  if (!Array.isArray(n)) return false
  const op = n[0]
  if ((op === 'break' || op === 'continue') && n[1] == null) return depth === 0
  if (op === '=>') return false
  const inner = op === 'while' || op === 'do' || op === 'for' || op === 'for-in' ||
    op === 'for-of' || op === 'switch' ? depth + 1 : depth
  return n.some((c, i) => i > 0 && hasFreeJump(c, inner))
}

const S = { NEXT: '__s', SENT: '__sent' }

// ES2025 iterator helpers on iterator VALUES — injected (pay-per-use) when a
// program that mints iterators also uses helper methods in non-fusable
// positions (chain stored as a value, helper on an unknown receiver) or tests
// `instanceof Iterator`. Generator objects then mint through __it_mk, whose
// helpers each wrap the source in a fresh decorated iterator — lazy,
// spec-shaped (value+counter callbacks, early return() on short-circuit).
// Fusable chains still fuse (zero-cost path unchanged); this is the fallback
// that makes helper results first-class values.
export const ITER_HELPERS_RUNTIME = `
let __it_fn = (f, name) => { if (f == null || typeof f !== 'function') throw 'TypeError: ' + name + ' callback must be callable' }
let __it_cl = (it) => { if (typeof it.return === 'function') it.return(undefined) }
let __it_lim = (n, name) => {
  let lim = +n
  if (lim !== lim) throw 'RangeError: ' + name + ' limit must not be NaN'
  lim = Math.trunc(lim)
  if (lim < 0) throw 'RangeError: ' + name + ' limit must be non-negative'
  return lim
}
let __it_mk = (nx, rt, th) => {
  let it = { next: nx, return: rt, throw: th, '@@iterator': undefined,
    map: undefined, filter: undefined, take: undefined, drop: undefined, flatMap: undefined,
    toArray: undefined, reduce: undefined, forEach: undefined, some: undefined, every: undefined, find: undefined }
  it[Symbol.iterator] = () => it
  it.map = (f) => { __it_fn(f, 'map'); let c = 0; return __it_mk((v) => {
    let r = it.next(v)
    if (r.done) return r
    let m = f(r.value, c)
    c++
    return { value: m, done: false }
  }, it.return, it.throw) }
  it.filter = (f) => { __it_fn(f, 'filter'); let c = 0; return __it_mk((v) => {
    let r = it.next(v)
    while (!r.done) { let hit = f(r.value, c); c++; if (hit) return { value: r.value, done: false }; r = it.next() }
    return r
  }, it.return, it.throw) }
  it.take = (n) => {
    let lim = __it_lim(n, 'take')
    let c = 0
    return __it_mk(() => {
      if (c >= lim) { __it_cl(it); return { value: undefined, done: true } }
      c++
      return it.next()
    }, it.return, it.throw)
  }
  it.drop = (n) => {
    let lim = __it_lim(n, 'drop')
    let c = 0
    return __it_mk(() => {
      while (c < lim) { c++; let r0 = it.next(); if (r0.done) return r0 }
      return it.next()
    }, it.return, it.throw)
  }
  it.flatMap = (f) => {
    __it_fn(f, 'flatMap')
    let inner = null, c = 0
    return __it_mk(() => {
      while (true) {
        if (inner != null) {
          let ri = inner.next()
          if (!ri.done) return ri
          inner = null
        }
        let r = it.next()
        if (r.done) return r
        let m = f(r.value, c)
        c++
        inner = __it_from(m)
      }
    }, (rv) => {
      // closing the helper closes the ACTIVE inner iterator first (spec:
      // IteratorClose forwards through the flattening), then the source.
      if (inner != null) { let i2 = inner; inner = null; __it_cl(i2) }
      if (typeof it.return === 'function') return it.return(rv)
      return { value: rv, done: true }
    }, it.throw)
  }
  it.toArray = () => { let a = [], r = it.next(); while (!r.done) { a.push(r.value); r = it.next() } return a }
  it.reduce = (f, init) => {
    __it_fn(f, 'reduce')
    let acc = init, c = 0
    if (init === undefined) {
      let r0 = it.next()
      if (r0.done) throw 'TypeError: Reduce of empty iterator with no initial value'
      acc = r0.value
      c = 1
    }
    let r = it.next()
    while (!r.done) { acc = f(acc, r.value, c); c++; r = it.next() }
    return acc
  }
  it.forEach = (f) => { __it_fn(f, 'forEach'); let c = 0, r = it.next(); while (!r.done) { f(r.value, c); c++; r = it.next() } }
  it.some = (f) => { __it_fn(f, 'some'); let c = 0, r = it.next(); while (!r.done) { if (f(r.value, c)) { __it_cl(it); return true } c++; r = it.next() } return false }
  it.every = (f) => { __it_fn(f, 'every'); let c = 0, r = it.next(); while (!r.done) { if (!f(r.value, c)) { __it_cl(it); return false } c++; r = it.next() } return true }
  it.find = (f) => { __it_fn(f, 'find'); let c = 0, r = it.next(); while (!r.done) { if (f(r.value, c)) { __it_cl(it); return r.value } c++; r = it.next() } return undefined }
  return it
}
let __it_from = (v) => {
  if (v == null) throw 'TypeError: value is not iterable'
  let w = v
  if (typeof w === 'object' && w[Symbol.iterator] != null) {
    if (typeof w[Symbol.iterator] !== 'function') throw 'TypeError: [Symbol.iterator] is not callable'
    w = w[Symbol.iterator]()
  }
  if (typeof w === 'object' && w.next != null) return w
  let ix = 0
  return __it_mk(() => {
    if (ix >= v.length) return { value: undefined, done: true }
    let e = v[ix]
    ix++
    return { value: e, done: false }
  }, undefined, undefined)
}
`

// Array.from over iterator values — rewires \`Array.from(x)\` in iterator-
// minting programs: protocol values materialize, arrays COPY (from() always
// returns a fresh array), array-likes build by length. Injected on use only.
export const ITER_ARR_RUNTIME = `
let __it_arr = (v) => {
  if (v == null) throw 'TypeError: value is not iterable'
  let w = v
  if (typeof w === 'object' && w[Symbol.iterator] != null) w = w[Symbol.iterator]()
  if (typeof w === 'object' && w.next != null) {
    let a = [], r = w.next()
    while (!r.done) { a.push(r.value); r = w.next() }
    return a
  }
  let a = [], n = v.length
  for (let i = 0; i < n; i++) a.push(v[i])
  return a
}
`

export function createGeneratorLowering({ transform, err, generatorNames, genTemp, iterProto }) {
  // Collect every let/const binding name in the body — generator locals live in
  // the factory scope so they survive across next() resumes. Shadowing across
  // sibling blocks would collide after hoisting — reject (rename support later).
  const collectLocals = (node, out, path) => {
    if (!Array.isArray(node)) return
    if ((node[0] === 'let' || node[0] === 'const')) {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        const name = Array.isArray(d) && d[0] === '=' ? d[1] : d
        if (typeof name !== 'string')
          err('generators v1: destructuring declarations inside a generator body are not supported yet — bind names first')
        if (out.has(name)) err(`generators v1: '${name}' is declared twice in the generator body — hoisted locals must be unique`)
        out.add(name)
      }
    }
    // arrows create their own scope — their decls don't hoist
    if (node[0] === '=>') return
    for (let i = 1; i < node.length; i++) collectLocals(node[i], out, path)
  }

  function lowerGenerator(params, rawBody) {
    const body = Array.isArray(rawBody) && rawBody[0] === ';' ? rawBody.slice(1) : [rawBody]

    const locals = new Set()
    for (const st of body) collectLocals(st, locals)

    // ---- state machine ----
    // states[i] = list of statements; terminators are written explicitly as
    // `__s = k` + return/continue shapes. State 0 is the entry; -1 is done.
    const states = []
    const newState = () => (states.push([]), states.length - 1)
    const stmtsOf = (id) => states[id]
    const setState = (id) => [';;set', id]           // internal marker, resolved below
    const gotoIR = (id) => [[';;set', id], [';;continue']]

    // `yield E` at a resume boundary: park the resume id, emit the {value,done:false}
    // return. The resume state optionally starts by binding `target = __sent`.
    const emitYield = (cur, yexpr, target) => {
      const resume = newState()
      const value = yexpr[1] === undefined ? [null, undefined] : transform(yexpr[1])
      stmtsOf(cur).push(
        [';;set', resume],
        ['return', ['{}', [',', [':', 'value', value], [':', 'done', [null, false]]]]])
      if (target) stmtsOf(resume).push(['=', target, S.SENT])
      return resume
    }

    // yield* E — the delegate loop is nothing but already-supported constructs:
    // sent values thread through (`sent = yield r.value; r = it.next(sent)`),
    // and the delegate's COMPLETION value (final r.value) lands in `target`.
    // E may be any iterable: an ['@@iterator']() provider unwraps first; a
    // plain indexed iterable (array/string) yields element-wise (fork mirrors
    // desugarForOfProtocol; both arms decompose like any generator-body loop).
    const desugarYieldStar = (expr, target) => {
      // yw copies the source before the @@iterator() unwrap — never reassign
      // a precisely-kinded local from a dynamic call (reassigned-local kind bug).
      const src = genTemp('yv'), it = genTemp('yi'), r = genTemp('yr'), sent = genTemp('ys'), ix = genTemp('yx')
      locals.add(src); locals.add(it); locals.add(r); locals.add(sent); locals.add(ix)
      const NULL = [null, null]
      return ['{}', [';',
        ['=', src, expr],
        ['=', it, src],
        ['if', ['&&', ['!=', src, NULL], ['!=', ['.', src, '@@iterator'], NULL]],
          ['=', it, ['()', ['.', src, '@@iterator'], null]]],
        ['if', ['&&', ['!=', it, NULL], ['!=', ['.', it, 'next'], NULL]],
          ['{}', [';',
            ['=', r, ['()', ['.', it, 'next'], null]],
            ['while', ['!', ['.', r, 'done']], ['{}', [';',
              ['=', sent, ['yield', ['.', r, 'value']]],
              ['=', r, ['()', ['.', it, 'next'], sent]],
            ]]],
            ...(target ? [['=', target, ['.', r, 'value']]] : []),
          ]],
          ['{}', [';',
            ['=', ix, [null, 0]],
            ['while', ['<', ix, ['.', it, 'length']], ['{}', [';',
              ['yield', ['[]', it, ix]],
              ['=', ix, ['+', ix, [null, 1]]],
            ]]],
            ...(target ? [['=', target, [null, undefined]]] : []),
          ]]],
      ]]
    }

    // Flatten a statement list into states. Returns the state id control falls
    // into after the list (or null if control never falls through).
    // loopCtx = { cont, brk } target state ids for the innermost decomposed loop.
    const flattenList = (stmts, cur, loopCtx) => {
      for (const st of stmts) {
        if (cur == null) return null   // unreachable code after a terminator — drop
        cur = flattenStmt(st, cur, loopCtx)
      }
      return cur
    }

    const flattenStmt = (st, cur, loopCtx) => {
      if (!Array.isArray(st)) { if (st != null) stmtsOf(cur).push(transform(st)); return cur }
      const op = st[0]

      // --- yield forms ---
      if (op === 'yield*') return flattenStmt(desugarYieldStar(st[1], null), cur, loopCtx)
      if (op === 'yield') return emitYield(cur, st, null)
      if ((op === 'let' || op === 'const') && st.length === 2 && Array.isArray(st[1]) &&
          st[1][0] === '=' && isYield(st[1][2])) {
        if (st[1][2][0] === 'yield*') return flattenStmt(desugarYieldStar(st[1][2][1], st[1][1]), cur, loopCtx)
        return emitYield(cur, st[1][2], st[1][1])
      }
      if (op === '=' && typeof st[1] === 'string' && isYield(st[2])) {
        if (st[2][0] === 'yield*') return flattenStmt(desugarYieldStar(st[2][1], st[1]), cur, loopCtx)
        return emitYield(cur, st[2], st[1])
      }

      // --- return ---
      if (op === 'return') {
        const v = st[1] === undefined ? [null, undefined] : transform(st[1])
        stmtsOf(cur).push(
          [';;set', -1],
          ['return', ['{}', [',', [':', 'value', v], [':', 'done', [null, true]]]]])
        return null
      }

      // --- break/continue of a DECOMPOSED loop ---
      if (op === 'break' && st[1] == null && loopCtx) { stmtsOf(cur).push(...gotoIR(loopCtx.brk)); return null }
      if (op === 'continue' && st[1] == null && loopCtx) { stmtsOf(cur).push(...gotoIR(loopCtx.cont)); return null }

      // --- compound statements stay atomic only when they carry no yield AND no
      // break/continue that binds a DECOMPOSED loop (the raw op would bind the
      // dispatch while(1) instead — an infinite next()) ---
      if (!hasYield(st) && !(loopCtx && hasFreeJump(st))) {
        // let/const initializers become assignments (names are hoisted)
        if (op === 'let' || op === 'const') {
          for (let i = 1; i < st.length; i++) {
            const d = st[i]
            if (Array.isArray(d) && d[0] === '=') stmtsOf(cur).push(['=', d[1], transform(d[2])])
          }
          return cur
        }
        stmtsOf(cur).push(transform(st))
        return cur
      }

      // --- yield-bearing control ---
      if (op === 'if') {
        const [, cond, thenB, elseB] = st
        const join = newState()
        const thenS = newState()
        const elseS = elseB != null ? newState() : join
        stmtsOf(cur).push(['if', transform(cond), [';', ...gotoIR(thenS)], [';', ...gotoIR(elseS)]], [';;continue'])
        const tEnd = flattenList(blockStmts(thenB), thenS, loopCtx)
        if (tEnd != null) stmtsOf(tEnd).push(...gotoIR(join))
        if (elseB != null) {
          const eEnd = flattenList(blockStmts(elseB), elseS, loopCtx)
          if (eEnd != null) stmtsOf(eEnd).push(...gotoIR(join))
        }
        return join
      }
      if (op === 'while') {
        const [, cond, bodyB] = st
        const test = newState(), bodyS = newState(), exit = newState()
        stmtsOf(cur).push(...gotoIR(test))
        stmtsOf(test).push(['if', transform(cond), [';', ...gotoIR(bodyS)], [';', ...gotoIR(exit)]], [';;continue'])
        const bEnd = flattenList(blockStmts(bodyB), bodyS, { cont: test, brk: exit })
        if (bEnd != null) stmtsOf(bEnd).push(...gotoIR(test))
        return exit
      }
      if (op === 'do') {
        const [, bodyB, cond] = st
        const bodyS = newState(), test = newState(), exit = newState()
        stmtsOf(cur).push(...gotoIR(bodyS))
        const bEnd = flattenList(blockStmts(bodyB), bodyS, { cont: test, brk: exit })
        if (bEnd != null) stmtsOf(bEnd).push(...gotoIR(test))
        stmtsOf(test).push(['if', transform(cond), [';', ...gotoIR(bodyS)], [';', ...gotoIR(exit)]], [';;continue'])
        return exit
      }
      if (op === 'for') {
        const [, head, bodyB] = st
        // for-of over a KNOWN generator call inside a generator body: desugar to
        // the while-next form first — the result is yield-decomposable.
        if (Array.isArray(head) && head[0] === 'of' && Array.isArray(head[2]) &&
            head[2][0] === '()' && typeof head[2][1] === 'string' && generatorNames?.has(head[2][1])) {
          const localTemp = (t) => { const n = genTemp(t); locals.add(n); return n }
          return flattenStmt(desugarForOfGenerator(head[1], head[2], bodyB, localTemp), cur, loopCtx)
        }
        if (Array.isArray(head) && (head[0] === 'of' || head[0] === 'in'))
          err('generators v1: yield inside for-of/for-in is not supported yet — use an indexed for')
        // C-style [';', init, cond, step] (subscript head shape)
        const [, init, cond, step] = Array.isArray(head) && head[0] === ';' ? head : [';', head, undefined, undefined]
        if (init != null) flattenStmt(init, cur, null) === cur || err('generators v1: yield in a for-init is not supported')
        const test = newState(), bodyS = newState(), stepS = newState(), exit = newState()
        stmtsOf(cur).push(...gotoIR(test))
        stmtsOf(test).push(['if', cond == null ? [null, true] : transform(cond), [';', ...gotoIR(bodyS)], [';', ...gotoIR(exit)]], [';;continue'])
        const bEnd = flattenList(blockStmts(bodyB), bodyS, { cont: stepS, brk: exit })
        if (bEnd != null) stmtsOf(bEnd).push(...gotoIR(stepS))
        if (step != null) stmtsOf(stepS).push(transform(step))
        stmtsOf(stepS).push(...gotoIR(test))
        return exit
      }
      if (op === '{}' || op === ';') return flattenList(blockStmts(st), cur, loopCtx)
      if (op === 'try' || op === 'catch' || op === 'finally')
        err('generators v1: try/catch across a yield is not supported yet')
      err(`generators v1: yield inside \`${op}\` is not supported yet — hoist the yield to statement position`)
    }

    const blockStmts = (b) =>
      b == null ? []
      : Array.isArray(b) && b[0] === '{}' ? blockStmts(b[1])
      : Array.isArray(b) && b[0] === ';' ? b.slice(1)
      : [b]

    const entry = newState()
    const end = flattenList(body, entry, null)
    if (end != null) stmtsOf(end).push(
      [';;set', -1],
      ['return', ['{}', [',', [':', 'value', [null, undefined]], [':', 'done', [null, true]]]]])

    // ---- assemble the dispatch loop ----
    // Internal markers resolve here: [';;set', k] → __s = k; [';;continue'] → continue.
    const resolve = (n) => {
      if (!Array.isArray(n)) return n
      if (n[0] === ';;set') return ['=', S.NEXT, [null, n[1]]]
      if (n[0] === ';;continue') return ['continue']
      return n.map(resolve)
    }
    // if-chain over states (highest → the shape jz compiles tightly)
    let dispatch = ['return', ['{}', [',', [':', 'value', [null, undefined]], [':', 'done', [null, true]]]]]
    for (let i = states.length - 1; i >= 0; i--)
      dispatch = ['if', ['===', S.NEXT, [null, i]], ['{}', [';', ...states[i].map(resolve), ['continue']]], ['{}', [';', dispatch]]]

    const nextBody = ['{}', [';',
      ['=', S.SENT, '__in'],
      ['while', [null, true], ['{}', [';', dispatch]]],
    ]]

    const decls = [
      ['let', ['=', S.NEXT, [null, 0]], ['=', S.SENT, [null, undefined]],
        ...[...locals].map(n => ['=', n, [null, undefined]])],
      ['const', ['=', '__next', ['=>', '__in', nextBody]]],
    ]

    const nextFn = ['=>', '__v', ['()', '__next', '__v']]
    const returnFn = ['=>', '__v', ['{}', [';',
      ['=', S.NEXT, [null, -1]],
      ['return', ['{}', [',', [':', 'value', '__v'], [':', 'done', [null, true]]]]]]]]
    // throw(v): no try may span a yield (v1 rejects it), so every injected
    // exception is unhandled by spec — close the machine, rethrow to the
    // caller of throw() (catchable jz throw).
    const throwFn = ['=>', '__v', ['{}', [';',
      ['=', S.NEXT, [null, -1]],
      ['throw', '__v']]]]

    // Helper-bearing programs mint through __it_mk (decorated iterator —
    // map/filter/… as value-position methods); others keep the bare record.
    if (iterProto?.helpers) {
      iterProto.helpersUsed = true
      return ['=>', params, ['{}', [';', ...decls,
        ['return', ['()', '__it_mk', [',', nextFn, returnFn, throwFn]]]]]]
    }
    const genObj = ['{}', [',',
      [':', 'next', nextFn],
      [':', 'return', returnFn],
      [':', 'throw', throwFn],
    ]]

    return ['=>', params, ['{}', [';', ...decls, ['return', genObj]]]]
  }

  // ---- ES2025 iterator-helper chain fusion ----
  // `g(args).map(f).filter(p).take(n)` rooted at a KNOWN generator call fuses
  // into ONE while-next loop — no intermediate iterator objects. Consuming
  // positions: a for-of head, or a terminal helper (toArray/reduce/forEach/
  // some/every/find) in expression position. A chain stored as a VALUE is out
  // of the v1 model (the object has no helper methods — the known-receiver
  // fail-fast reports it precisely).
  const STAGE_HELPERS = new Set(['map', 'filter', 'take', 'drop'])
  const TERMINAL_HELPERS = new Set(['toArray', 'reduce', 'forEach', 'some', 'every', 'find'])

  // Unwind `root.h1(a).h2(b)…` → { root: ['()', gen, args], stages: [{h, args}] }
  // when the root is a known generator call; null otherwise.
  function unwindChain(node) {
    const stages = []
    let cur = node
    while (Array.isArray(cur) && cur[0] === '()' && Array.isArray(cur[1]) && cur[1][0] === '.') {
      const helper = cur[1][2]
      if (!STAGE_HELPERS.has(helper) && !TERMINAL_HELPERS.has(helper)) return null
      stages.unshift({ h: helper, args: cur[2] == null ? [] : (Array.isArray(cur[2]) && cur[2][0] === ',' ? cur[2].slice(1) : [cur[2]]) })
      cur = cur[1][1]
    }
    if (!(Array.isArray(cur) && cur[0] === '()' && typeof cur[1] === 'string' && generatorNames?.has(cur[1]))) return null
    return { root: cur, stages }
  }

  // Compose the per-item body: stage transforms wrap `emit(x)` — the innermost
  // callback receives the final item statements.
  // Returns statements for the while body given (xName, emitStmts).
  function stageBody(stages, x, temp, emitStmts) {
    // build from the last stage outward
    let build = emitStmts
    for (let i = stages.length - 1; i >= 0; i--) {
      const { h, args } = stages[i]
      const inner = build
      if (h === 'map') {
        // spec: fn(value, counter)
        const fn = args[0], c = temp('mc')
        build = () => [['=', x, ['()', fn, [',', x, c]]], ['=', c, ['+', c, [null, 1]]], ...inner()]
        build.decls = [[c, [null, 0]]].concat(inner.decls || [])
      } else if (h === 'filter') {
        const fn = args[0], c = temp('fc'), hv = temp('fh')
        build = () => [
          ['=', hv, ['()', fn, [',', x, c]]],
          ['=', c, ['+', c, [null, 1]]],
          ['if', hv, ['{}', [';', ...inner()]]]]
        build.decls = [[c, [null, 0]], [hv, [null, undefined]]].concat(inner.decls || [])
      } else if (h === 'take') {
        const n = args[0], c = temp('tk')
        build = () => [
          ['if', ['>=', c, n], ['{}', [';', ['break']]]],
          ['=', c, ['+', c, [null, 1]]],
          ...inner()]
        build.decls = [[c, [null, 0]]].concat(inner.decls || [])
      } else if (h === 'drop') {
        const n = args[0], c = temp('dp')
        build = () => [
          ['if', ['<', c, n], ['{}', [';', ['=', c, ['+', c, [null, 1]]], ['continue']]]],
          ...inner()]
        build.decls = [[c, [null, 0]]].concat(inner.decls || [])
      }
      if (!build.decls && inner.decls) build.decls = inner.decls
    }
    return build
  }

  // Fused loop skeleton: declares it/r (+stage counters), loops next().
  function fusedLoop(root, stages, temp, x, emitStmts, prologue = [], epilogue = []) {
    const it = temp('gi'), r = temp('gr')
    const build = stageBody(stages, x, temp, emitStmts)
    // Pull at the TOP of the body: stage/user `continue` must advance to the
    // NEXT item — a tail-position pull would be skipped and re-process the
    // same value forever (the drop()-stage / user-continue hazard).
    return ['{}', [';',
      ['const', ['=', it, root]],
      ['let', ['=', x, [null, undefined]], ['=', r, [null, undefined]],
        ...(build.decls || []).map(([n, init]) => ['=', n, init])],
      ...prologue,
      ['while', [null, true], ['{}', [';',
        ['=', r, ['()', ['.', it, 'next'], null]],
        ['if', ['.', r, 'done'], ['{}', [';', ['break']]]],
        ['=', x, ['.', r, 'value']],
        ...build(),
      ]]],
      ...epilogue,
    ]]
  }

  // Terminal helper in EXPRESSION position → IIFE returning the reduction.
  function fuseTerminal(chain, temp) {
    const { root, stages } = chain
    const last = stages[stages.length - 1]
    if (!TERMINAL_HELPERS.has(last.h)) return null
    const mid = stages.slice(0, -1)
    const x = temp('gx'), acc = temp('ga'), cn = temp('gc')
    const T = last.h, A = last.args
    const ret = (v) => ['return', v]
    const bump = ['=', cn, ['+', cn, [null, 1]]]
    // spec: every terminal callback receives (…, value, counter)
    let prologue = [], emit, epilogue
    if (T === 'toArray') {
      prologue = [['let', ['=', acc, ['[]', null]]]]
      emit = () => [['()', ['.', acc, 'push'], x]]
      epilogue = [ret(acc)]
    } else if (T === 'reduce') {
      // no initial value → the first element seeds the accumulator (counter
      // starts at 1 for the first reducer call); empty + no init throws.
      const first = temp('gf')
      const noInit = A[1] === undefined
      prologue = [['let', ['=', cn, [null, 0]], ['=', first, [null, noInit]],
        ['=', acc, noInit ? [null, undefined] : A[1]]]]
      emit = () => [
        ['if', first,
          ['{}', [';', ['=', acc, x], ['=', first, [null, false]]]],
          ['{}', [';', ['=', acc, ['()', A[0], [',', acc, x, cn]]]]]],
        bump]
      epilogue = [
        ...(noInit ? [['if', first, ['throw', [null, 'Reduce of empty iterator with no initial value']]]] : []),
        ret(acc)]
    } else if (T === 'forEach') {
      prologue = [['let', ['=', cn, [null, 0]]]]
      emit = () => [['()', A[0], [',', x, cn]], bump]
      epilogue = [ret([null, undefined])]
    } else if (T === 'some') {
      prologue = [['let', ['=', cn, [null, 0]]]]
      emit = () => [['if', ['()', A[0], [',', x, cn]], ['{}', [';', ret([null, true])]]], bump]
      epilogue = [ret([null, false])]
    } else if (T === 'every') {
      prologue = [['let', ['=', cn, [null, 0]]]]
      emit = () => [['if', ['!', ['()', A[0], [',', x, cn]]], ['{}', [';', ret([null, false])]]], bump]
      epilogue = [ret([null, true])]
    } else if (T === 'find') {
      prologue = [['let', ['=', cn, [null, 0]]]]
      emit = () => [['if', ['()', A[0], [',', x, cn]], ['{}', [';', ret(x)]]], bump]
      epilogue = [ret([null, undefined])]
    } else return null
    const body = fusedLoop(root, mid, temp, x, emit, prologue, epilogue)
    const iife = ['()', ['=>', ['()', null], body], null]
    // a loop-bearing arrow with multiple boolean returns loses bool kind
    // (stringifies as '1') — !! restores it for the predicate terminals
    return T === 'some' || T === 'every' ? ['!', ['!', iife]] : iife
  }

  // for-of over a KNOWN generator call → while-next desugar (fusion-friendly:
  // the optimizer sees plain closure calls + a fixed-shape result object).
  function desugarForOfGenerator(decl, iterExpr, body, temp) {
    const it = temp('gi'), r = temp('gr')
    const name = Array.isArray(decl) ? decl[1] : decl
    // Pull at the TOP: a user `continue` in the body must advance the iterator
    // (a tail pull would be skipped — infinite loop on the same item).
    return ['{}', [';',
      ['const', ['=', it, iterExpr]],
      ['let', ['=', r, [null, undefined]]],
      ['while', [null, true], ['{}', [';',
        ['=', r, ['()', ['.', it, 'next'], null]],
        ['if', ['.', r, 'done'], ['{}', [';', ['break']]]],
        ['let', ['=', name, ['.', r, 'value']]],
        ...(Array.isArray(body) && body[0] === ';' ? body.slice(1) : [body]),
      ]]],
    ]]
  }

  // for-of over an UNKNOWN source in a program that mints iterators: unwrap a
  // ['@@iterator']() provider, then a callable `next` drives the machine
  // LAZILY (pull-at-top — a `break` stops pulling, spec-faithful); anything
  // else falls to the indexed array path. 'of-idx' marks that arm so the fork
  // doesn't re-enter. The probes run once per loop, not per iteration, and
  // programs without iterator producers never take this shape (iterProto
  // gate) — they compile byte-identically.
  function desugarForOfProtocol(decl, iterExpr, body, temp) {
    // `w` starts as a COPY of the source and takes the @@iterator() result —
    // never reassign the precisely-kinded source local from a dynamic call
    // (the recorded reassigned-local kind bug poisons subsequent prop reads).
    const v = temp('gv'), w = temp('gw'), r = temp('gr')
    const NULL = [null, null]
    const isDecl = Array.isArray(decl) && (decl[0] === 'let' || decl[0] === 'const')
    const bind = isDecl ? [decl[0], ['=', decl[1], ['.', r, 'value']]] : ['=', decl, ['.', r, 'value']]
    const bodyStmts = Array.isArray(body) && body[0] === ';' ? body.slice(1) : [body]
    return ['{}', [';',
      ['let', ['=', v, iterExpr]],
      ['let', ['=', w, v]],
      ['if', ['&&', ['!=', v, NULL], ['!=', ['.', v, '@@iterator'], NULL]],
        ['=', w, ['()', ['.', v, '@@iterator'], null]]],
      ['if', ['&&', ['!=', w, NULL], ['!=', ['.', w, 'next'], NULL]],
        ['{}', [';',
          ['let', ['=', r, [null, undefined]]],
          ['while', [null, true], ['{}', [';',
            ['=', r, ['()', ['.', w, 'next'], null]],
            ['if', ['.', r, 'done'], ['{}', [';', ['break']]]],
            bind,
            ...bodyStmts,
          ]]],
        ]],
        ['for', ['of-idx', decl, w], body]],
    ]]
  }

  return { lowerGenerator, desugarForOfGenerator, desugarForOfProtocol, unwindChain, fuseTerminal, fusedLoop, isTerminal: (h) => TERMINAL_HELPERS.has(h) }
}
