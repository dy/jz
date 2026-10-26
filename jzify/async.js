/**
 * async/await lowering – the generator machinery driving the plain-jz promise
 * runtime `jz:async` (src/std/async.js). No engine event loop, no stdlib/WAT
 * additions: an async function body lowers to the SAME state machine as
 * function* (an await suspends as a yield does), and the runtime's driver
 * (__async_run) steps it, parking on awaited promises; the runtime is
 * imported implicitly by every module that awaits, one copy per program.
 *
 * v1 surface (precise rejects elsewhere): try/catch/finally across an await
 * (or an async generator's yield) routes the rejection to the catch and every
 * completion through the finally (the machine's try regions, generators.js),
 * which may await itself; an async generator's driver (__ag_run, jz:asyncgen)
 * throws a rejection into the machine where it stands;
 * `new Promise(executor)`, `Promise.resolve/reject/all/race/allSettled/any/
 * try/withResolvers`, `.then/.catch/.finally` chains all work (canonicalized
 * to the injected helpers). AggregateError surfaces as a fixed-shape
 * `{ name, message, errors }` value (errors are untagged in jz).
 * Divergences (documented): unhandled rejections don't report; job ordering
 * is per-drain-cycle (boundary/timer granularity), not per-continuation.
 *
 * Pay-per-use: nothing is imported unless the program contains async
 * source; sync programs compile byte-identically.
 *
 * @module jzify/async
 */

import { FN_BOUNDARY_OPS, probe, closingLoop, labeled, bindTo } from './generators.js'
import { usesArguments } from './arguments.js'
import { some, ASSIGN_OPS, extractParams, withLoc, collectParamName } from '../src/ast.js'

const DECLS = new Set(['let', 'const', 'var', 'using'])
/** The names a node assigns, counted per name (a destructuring target's, a
 *  bare for-in or for-of head's, an update's), and the property keys it
 *  writes by a static key, deletes, or defines a getter for; through nested
 *  functions where `deep`. A declaration's initializer assigns nothing. */
export const assignCensus = (node, deep, names = new Map(), props = new Set()) => {
  const target = (t) => {
    if (typeof t === 'string') { names.set(t, (names.get(t) ?? 0) + 1); return }
    if (!Array.isArray(t)) return
    const op = t[0]
    if (op === '.') { if (typeof t[2] === 'string') props.add(t[2]); return }
    if (op === '[]' && t.length === 3) { if (Array.isArray(t[2]) && t[2][0] == null && typeof t[2][1] === 'string') props.add(t[2][1]); return }
    if (op === '[]' || op === '{}' || op === ',') { for (let i = 1; i < t.length; i++) target(t[i]); return }
    if (op === '=' || op === '...' || op === '()' && t.length === 2) target(t[1])
    else if (op === ':') target(t[2])
  }
  const walk = (n) => {
    if (!Array.isArray(n) || n[0] == null) return
    const op = n[0]
    if (!deep && FN_BOUNDARY_OPS.has(op)) return
    if (DECLS.has(op)) { for (let i = 1; i < n.length; i++) if (Array.isArray(n[i]) && n[i][0] === '=') walk(n[i][2]); return }
    if (op === 'get' && typeof n[1] === 'string') props.add(n[1])
    if (ASSIGN_OPS.has(op) || op === '++' || op === '--' || op === 'delete') target(n[1])
    else if (op === 'for' && Array.isArray(n[1]) && (n[1][0] === 'of' || n[1][0] === 'in') && !(Array.isArray(n[1][1]) && DECLS.has(n[1][1][0]))) target(n[1][1])
    for (let i = 1; i < n.length; i++) walk(n[i])
  }
  walk(node)
  return { names, props }
}

export function createAsyncLowering({ genTemp, err, censusOf }) {

  // The awaits of THIS function body only (nested function forms keep
  // their own await/this rules; a stray await inside a nested sync fn falls
  // through to prepare's clean reject). The boundary set is the layer-wide
  // canonical one (generators.js FN_BOUNDARY_OPS) — one definition for every
  // control-effects walker.
  const FN_OPS = FN_BOUNDARY_OPS

  // `for await (decl of src)` → protocol loop in terms of PLAIN await: unwrap
  // @@asyncIterator (else @@iterator), drive next() through await; a sync
  // source's values are awaited in turn, as CreateAsyncFromSyncIterator's are
  // (an async iterator's are not, their settling is the next() promise's).
  // Non-protocol sources fall to an indexed loop with per-element await. The
  // result is machine-lowerable by the same v1 yield surface as any while
  // loop. A body leaving early awaits the iterator's return() (AsyncIteratorClose).
  // Each iteration binds the value first, the body a block inside; the
  // loop's labels go to its loops.
  const NULL = [null, null]
  function desugarForAwait(head, body, labels) {
    const [, decl, srcExpr] = head
    const src = genTemp('fa'), it = genTemp('fi'), r = genTemp('fr'), ix = genTemp('fx'), sync = genTemp('fs')
    const inner = ['{}', [';', ...(Array.isArray(body) && body[0] === ';' ? body.slice(1) : [body])]]
    const open = genTemp('fo'), value = genTemp('fv'), result = genTemp('fq'), close = ['.', it, 'return']
    const notObject = ['||', ['==', result, NULL], ['&&', ['!==', ['typeof', result], [null, 'object']], ['!==', ['typeof', result], [null, 'function']]]]
    // Pull at the top: a `continue` in the body must advance the iterator.
    const protocol = ['{}', [';',
      ['let', ['=', open, [null, false]], ['=', value, [null, undefined]], ['=', result, [null, undefined]]],
      closingLoop(labeled(labels, ['while', [null, true], ['{}', [';',
        ['=', open, [null, false]],
        ['=', r, ['await', ['()', ['.', it, 'next'], null]]],
        ['if', ['.', r, 'done'], ['{}', [';', ['break']]]],
        ['=', value, ['.', r, 'value']],
        ['=', open, [null, true]],
        // a sync source's rejected value closes it
        ['if', sync, ['=', value, ['await', value]]],
        bindTo(decl, value),
        inner,
      ]]]), open, [
        ['if', ['!=', close, NULL], ['{}', [';',
          ['=', result, ['await', ['()', close.slice(), null]]],
          ['if', notObject, ['throw', ['new', ['()', 'TypeError', [null, 'iterator return result is not an object']]]]]]]],
      ], [
        ['try', ['{}', [';', ['if', ['!=', close.slice(), NULL], ['{}', [';', ['await', ['()', close.slice(), null]]]]]]],
          ['catch', genTemp('fe'), ['{}', null]]],
      ], genTemp('ff'), body)]]
    return ['{}', [';',
      ['let', ['=', src, srcExpr]],
      ['let', ['=', it, src], ['=', sync, [null, false]]],
      ['if', ['&&', ['!=', src, NULL], ['!=', ['.', src, '@@asyncIterator'], NULL]],
        ['=', it, ['()', ['.', src, '@@asyncIterator'], null]],
        ['if', ['&&', ['!=', src, NULL], ['!=', ['.', src, '@@iterator'], NULL]],
          ['{}', [';', ['=', it, ['()', probe(src, '@@iterator'), null]], ['=', sync, [null, true]]]]]],
      ['if', ['&&', ['!=', it, NULL], ['!=', ['.', it, 'next'], NULL]],
        ['{}', [';',
          ['let', ['=', r, [null, undefined]]],
          protocol,
        ]],
        ['{}', [';',
          ['let', ['=', ix, [null, 0]]],
          labeled(labels, ['while', ['<', ix, ['.', it, 'length']], ['{}', [';',
            bindTo(decl, ['await', ['[]', it, ix]]),
            ['=', ix, ['+', ix, [null, 1]]],
            inner,
          ]]]),
        ]]],
    ]]
  }

  // `for await` → plain awaits. An await stays an await: the machine suspends
  // at it as at a yield and types the value it resumes with (generators.js).
  function mapAwait(node, labels) {
    if (!Array.isArray(node)) return node
    if (FN_OPS.has(node[0])) return node
    if (node[0] === ':' && typeof node[1] === 'string') {
      const names = [...(labels || []), node[1]], inner = node[2]
      if (Array.isArray(inner) && (inner[0] === ':' || inner[0] === 'for await')) return mapAwait(inner, names)
      return withLoc(labeled(names, mapAwait(inner)), node)
    }
    if (node[0] === 'for await' && Array.isArray(node[1]) && node[1][0] === 'of')
      return mapAwait(desugarForAwait(node[1], node[2], labels))
    return withLoc(node.map((n, i) => i === 0 ? n : mapAwait(n)), node)
  }
  function fnBoundary(n) { return FN_OPS.has(n[0]) }
  function isAwait(n) { return n[0] === 'await' || n[0] === 'for await' || n[0] === 'yield' || n[0] === 'yield*' }
  function refsAwait(node) { return some(node, isAwait, { boundary: fnBoundary }) }

  // ---- a suspension in expression position → statement position ----
  // The machine suspends at statements only (generators.js: a yield or an
  // await as a statement, or the right side of `let x = yield E` /
  // `x = yield E` / `x.f = yield E`). Every other one is hoisted: the value
  // it resumes with lands in a temp declared before the statement, and
  // whatever the statement evaluates before it lands in temps first, so the
  // source's order holds where another activation could tell: a name another
  // may assign meanwhile (`volatile`), a spread's iteration, a callee, a
  // method's receiver and computed key, and the method itself where its key
  // is written or a getter's (`watched`: then called on the receiver it was
  // read off), a constructor (hoistNew), an assignment's target (hoistAssign).
  // A short-circuit or conditional whose later arm suspends becomes an if
  // statement assigning a temp, an optional chain whose later links suspend
  // too (hoistOptional). A loop's test, step and initializer and a
  // case's test stay where they are: the machine runs them as statements
  // where the loop and the switch run them (hoistExpr, generators.js).
  const UNDEF = [null, undefined]
  const isAwaitOf = (e) => Array.isArray(e) && (e[0] === 'await' || e[0] === 'yield' || e[0] === 'yield*')
  const isSimple = (e) => !Array.isArray(e) || e[0] == null
  const stmtsOf = (b) => b == null ? [] : Array.isArray(b) && b[0] === ';' ? b.slice(1) : Array.isArray(b) && b[0] === '{}' ? stmtsOf(b[1]) : [b]
  const seq = (list) => list.length === 1 ? list[0] : [';', ...list]
  const block = (list) => ['{}', seq(list)]
  const hoistList = (b) => stmtsOf(b).flatMap(hoistStmt)
  // A body keeps its spelling: a block stays a block, a lone statement stays bare.
  const blockOf = (b) => { if (b == null) return b; const list = hoistList(b); return list.length === 1 && !(Array.isArray(b) && b[0] === '{}') ? list[0] : block(list) }
  const keepsPlace = (op, i) => i === 1 && (op === '?.()' || ASSIGN_OPS.has(op) || op === '++' || op === '--')
  // A value a temp need not hold: a literal, a name, `this`.
  const isStable = (e) => isSimple(e) || e[0] === 'this' || e[0] === 'str'
  // The body being lowered: the names it declares, and how often it assigns
  // each outside its nested functions (enterBody).
  let own = null
  const declaredIn = (n, out) => {
    if (!Array.isArray(n) || n[0] == null || FN_OPS.has(n[0])) return
    if (DECLS.has(n[0])) for (let i = 1; i < n.length; i++) collectParamName(Array.isArray(n[i]) && n[i][0] === '=' ? n[i][1] : n[i], out)
    else if (n[0] === 'catch' && n[1] != null) collectParamName(n[1], out)
    for (let i = 1; i < n.length; i++) declaredIn(n[i], out)
  }
  const enterBody = (params, body) => {
    const prior = own, declared = new Set()
    for (const p of params == null ? [] : extractParams(params)) collectParamName(p, declared)
    declaredIn(body, declared)
    own = { declared, assigns: assignCensus(body, false).names }
    return prior
  }
  const leaveBody = (prior) => { own = prior }
  // A name another activation may assign while the body is suspended: one the
  // body declares, assigned in a function nested in it; any other, assigned
  // anywhere in the module (by another call of this very function too).
  const volatile = (n) => {
    if (typeof n !== 'string' || own == null || !censusOf) return false
    const all = censusOf().names.get(n) ?? 0
    return own.declared.has(n) ? all > (own.assigns.get(n) ?? 0) : all > 0
  }
  // A value that reads the same after the suspension.
  const isSettled = (e) => isStable(e) && !volatile(e)
  // A property whose read the suspension may change or that runs code: a key
  // the program writes by name or defines a getter for, any computed one.
  const watched = (key) => typeof key !== 'string' || !censusOf || censusOf().props.has(key)
  // The key a member reads, when it names one.
  const keyOf = (m) => m[0] === '.' ? m[2] : Array.isArray(m[2]) && m[2][0] == null && typeof m[2][1] === 'string' ? m[2][1] : null
  const copy = (x) => Array.isArray(x) ? x.slice() : x
  // a call on the receiver `r` of the method `fn` read off it; never lowered again
  const madeCalls = new WeakSet()
  const callOn = (fn, r, args) => {
    const callee = ['.', fn, 'call']
    madeCalls.add(callee)
    return ['()', callee, args == null ? copy(r) : Array.isArray(args) && args[0] === ',' ? [',', copy(r), ...args.slice(1)] : [',', copy(r), args]]
  }
  const isGroup = (e) => Array.isArray(e) && e[0] === '()' && e.length === 2
  const isMember = (e) => Array.isArray(e) && (e[0] === '.' || e[0] === '[]' && e.length === 3)
  const OPTIONAL = new Set(['?.', '?.[]', '?.()'])
  const LINKS = new Set(['.', '[]', '()', ...OPTIONAL])
  // An optional chain's links, outermost first, down to its root (a group ends it).
  const chainOf = (e) => { const out = []; for (let x = e; Array.isArray(x) && LINKS.has(x[0]) && !isGroup(x); x = x[1]) out.push(x); return out }
  // What an expression or a statement lowers to stands where it stood.
  function hoistExpr(e, within) {
    const h = hoistExprNode(e, within)
    for (const s of h.pre) withLoc(s, e)
    withLoc(h.expr, e)
    return h
  }
  // `within`: the literal or the call a `,` list stands in
  function hoistExprNode(e, within) {
    if (!Array.isArray(e) || FN_OPS.has(e[0]) || !refsAwait(e)) return { pre: [], expr: e }
    const op = e[0]
    if (isAwaitOf(e)) {
      const inner = hoistExpr(e[1]), t = genTemp('aw')
      return { pre: [...inner.pre, ['let', ['=', t, [op, inner.expr]]]], expr: t }
    }
    if ((op === '&&' || op === '||' || op === '??') && refsAwait(e[2])) {
      const l = hoistExpr(e[1]), r = hoistExpr(e[2]), t = genTemp('aw')
      const test = op === '&&' ? t : op === '||' ? ['!', t] : ['==', t, NULL]
      return { pre: [...l.pre, ['let', ['=', t, l.expr]], ['if', test, block([...r.pre, ['=', t, r.expr]])]], expr: t }
    }
    if (op === '?' && (refsAwait(e[2]) || refsAwait(e[3]))) {
      const c = hoistExpr(e[1]), a = hoistExpr(e[2]), b = hoistExpr(e[3]), t = genTemp('aw')
      return { pre: [...c.pre, ['let', ['=', t, UNDEF]], ['if', c.expr, block([...a.pre, ['=', t, a.expr]]), block([...b.pre, ['=', t, b.expr]])]], expr: t }
    }
    if (ASSIGN_OPS.has(op)) return hoistAssign(op, e[1], e[2])
    // an optional link whose later links suspend
    const chain = chainOf(e), at = chain.findLastIndex(x => OPTIONAL.has(x[0]))
    if (at >= 0 && chain.slice(0, at + 1).some(x => x.slice(2).some(refsAwait))) return hoistOptional(chain, at)
    if (op === 'new' && Array.isArray(e[1]) && e[1][0] === '()' && e[1].length === 3 && refsAwait(e[1][2])) return hoistNew(e[1])
    // Children evaluate left to right: those before the last awaiting child
    // land in temps, the rest stay in place.
    const out = e.slice(), pre = []
    let last = 1, recv = null
    for (let i = 1; i < e.length; i++) if (refsAwait(e[i])) last = i
    const temp = (x) => { const t = genTemp('aw'); pre.push(['let', ['=', t, x]]); return t }
    const settleVal = (x) => isSettled(x) ? x : temp(x)
    // a computed key reads before what follows it
    const settleKey = (k) => Array.isArray(k) && k[0] === '[]' && k.length === 2 ? ['[]', settleVal(k[1])] : k
    // a callee read before its arguments, a method on its receiver (`(o.m)()`
    // too): one whose read may differ read off it then, and called on it
    const settleCallee = (x) => {
      const m = isGroup(x) && isMember(x[1]) ? x[1] : x
      if (!isMember(m) || madeCalls.has(m)) return isMember(m) ? m : settleVal(m)
      const key = keyOf(m), r = settleVal(m[1]), k = m[0] === '.' ? m[2] : settleVal(m[2])
      if (m[1] === 'super' || typeof key === 'string' && key[0] === '#' || !watched(key)) return [m[0], r, k]
      recv = r
      return temp([m[0], copy(r), k])
    }
    const inObject = op === '{}' || op === ',' && within === '{}'
    const settle = (i, x) => {
      if (op === '()' && i === 1) return settleCallee(x)
      if (op === ':' && i === 1) return settleKey(x)
      if (keepsPlace(op, i)) return x
      // a shorthand property keeps its key
      if (typeof x === 'string') { const v = settleVal(x); return inObject && v !== x ? [':', x, v] : v }
      if (isSimple(x)) return x
      if (x[0] === ':') return [':', settleKey(x[1]), settleVal(x[2])]
      // a spread iterates before what follows it
      if (x[0] === '...') return ['...', temp(inObject ? ['{}', ['...', x[1]]] : ['[]', ['...', x[1]]])]
      return settleVal(x)
    }
    for (let i = 1; i < e.length; i++) {
      const child = e[i]
      if (i > last) continue
      const h = refsAwait(child) ? hoistExpr(child, op) : { pre: [], expr: child }
      pre.push(...h.pre)
      out[i] = i < last ? settle(i, h.expr) : h.expr
    }
    if (recv != null) return { pre, expr: callOn(out[1], recv, out[2]) }
    return { pre, expr: out }
  }
  // `new C(args)` reads its constructor before its arguments: a name another
  // may assign meanwhile, a member whose read may differ.
  function hoistNew(call) {
    const pre = [], temp = (x) => { const t = genTemp('aw'); pre.push(['let', ['=', t, x]]); return t }
    const c = hoistExpr(call[1])
    pre.push(...c.pre)
    const m = isGroup(c.expr) && isMember(c.expr[1]) ? c.expr[1] : c.expr
    let ctor
    if (isMember(m)) {
      const r = isSettled(m[1]) ? m[1] : temp(m[1]), k = m[0] === '.' ? m[2] : isSettled(m[2]) ? m[2] : temp(m[2])
      ctor = watched(keyOf(m)) ? temp([m[0], r, k]) : [m[0], r, k]
    } else ctor = isSettled(c.expr) ? c.expr : temp(c.expr)
    const a = hoistExpr(call[2], '()')
    return { pre: [...pre, ...a.pre], expr: ['new', ['()', ctor, a.expr]] }
  }
  // An optional link short-circuits its chain: with its base nullish, the
  // chain is undefined and nothing after the link runs, a suspension there
  // neither. Its base settles first, a method's optional call on its receiver
  // (`a.b?.(x)` calls b on a: read once and called on it where its read may
  // differ, read again where it is called otherwise), and the chain's rest
  // runs on it, as a plain link, while the base is present.
  function hoistOptional(chain, at) {
    const link = chain[at], pre = [], temp = (x) => { const t = genTemp('aw'); pre.push(['let', ['=', t, x]]); return t }
    const part = (x) => { const h = hoistExpr(x); pre.push(...h.pre); return isSettled(h.expr) ? h.expr : temp(h.expr) }
    let base = link[1], test, rest
    if (link[0] === '?.()' && isMember(base)) {
      const r = part(base[1]), k = base[0] === '.' ? base[2] : part(base[2])
      if (watched(keyOf(base))) { const fn = temp([base[0], copy(r), copy(k)]); test = fn; rest = callOn(fn, r, link[2]) }
      else { test = [base[0], copy(r), copy(k)]; rest = ['()', [base[0], copy(r), copy(k)], link[2]] }
    } else {
      base = part(base); test = base
      rest = link[0] === '?.' ? ['.', copy(base), link[2]] : link[0] === '?.[]' ? ['[]', copy(base), link[2]] : ['()', copy(base), link[2]]
    }
    for (let i = at - 1; i >= 0; i--) rest = [chain[i][0], rest, ...chain[i].slice(2)]
    const r = genTemp('aw'), h = hoistExpr(rest)
    pre.push(['let', ['=', r, UNDEF]], ['if', ['!=', copy(test), NULL], block([...h.pre, ['=', r, h.expr]])])
    return { pre, expr: r }
  }
  // An assignment that suspends reads first what JS reads first: its target's
  // object and computed key (a named receiver none may assign meanwhile
  // stays: the machine stores through it), and a compound assignment's current value, which a logical
  // one tests before its value runs at all.
  function hoistAssign(op, target, value) {
    const pre = [], temp = (x) => { const t = genTemp('aw'); pre.push(['let', ['=', t, x]]); return t }
    const part = (x, keep) => { const h = hoistExpr(x); pre.push(...h.pre); return keep(h.expr) ? h.expr : temp(h.expr) }
    let place = target
    if (Array.isArray(target) && target[0] === '.') place = ['.', part(target[1], isSettled), target[2]]
    else if (Array.isArray(target) && target[0] === '[]' && target.length === 3)
      place = ['[]', part(target[1], isSettled), part(target[2], (k) => Array.isArray(k) && k[0] == null)]
    const at = () => Array.isArray(place) ? place.slice() : place
    const v = hoistExpr(value)
    if (op === '=') return { pre: [...pre, ...v.pre], expr: ['=', at(), v.expr] }
    const t = temp(at())
    if (op === '&&=' || op === '||=' || op === '??=') {
      const test = op === '&&=' ? t : op === '||=' ? ['!', t] : ['==', t, NULL]
      return { pre: [...pre, ['if', test, block([...v.pre, ['=', t, ['=', at(), v.expr]]])]], expr: t }
    }
    return { pre: [...pre, ...v.pre], expr: ['=', at(), [op.slice(0, -1), t, v.expr]] }
  }
  function hoistStmt(st) {
    const out = hoistStmtNode(st)
    for (const s of out) withLoc(s, st)
    return out
  }
  function hoistStmtNode(st) {
    if (!Array.isArray(st) || !refsAwait(st)) return [st]
    const op = st[0]
    if (op === ';') return st.slice(1).flatMap(hoistStmt)
    // a statement's parentheses group nothing a statement reads (`({ a = yield } = o)`)
    if (op === '()' && st.length === 2) return hoistStmt(st[1])
    if (op === '{}') return [block(hoistList(st[1]))]
    if (isAwaitOf(st)) { const inner = hoistExpr(st[1]); return [...inner.pre, [op, inner.expr]] }
    if (op === 'let' || op === 'const' || op === 'var') {
      const out = []
      for (const d of st.slice(1)) {
        if (!Array.isArray(d) || d[0] !== '=' || !refsAwait(d[2])) { out.push([op, d]); continue }
        if (typeof d[1] === 'string' && isAwaitOf(d[2])) { const inner = hoistExpr(d[2][1]); out.push(...inner.pre, [op, ['=', d[1], [d[2][0], inner.expr]]]); continue }
        const h = hoistExpr(d[2]); out.push(...h.pre, [op, ['=', d[1], h.expr]])
      }
      return out
    }
    if (ASSIGN_OPS.has(op)) {
      const target = st[1], plain = typeof target === 'string' || (Array.isArray(target) && target[0] === '.' && typeof target[1] === 'string' && isSettled(target[1]))
      if (op === '=' && plain && isAwaitOf(st[2])) { const inner = hoistExpr(st[2][1]); return [...inner.pre, ['=', target, [st[2][0], inner.expr]]] }
      const h = hoistAssign(op, target, st[2])
      return [...h.pre, ...(typeof h.expr === 'string' ? [] : [h.expr])]
    }
    if (op === 'return' || op === 'throw') { const h = hoistExpr(st[1]); return [...h.pre, [op, h.expr]] }
    if (op === 'if') { const c = hoistExpr(st[1]); return [...c.pre, ['if', c.expr, blockOf(st[2]), ...(st.length > 3 ? [blockOf(st[3])] : [])]] }
    if (op === 'while') return [['while', st[1], blockOf(st[2])]]
    if (op === 'do') return [['do', blockOf(st[1]), st[2]]]
    if (op === 'for' && Array.isArray(st[1])) {
      const head = st[1]
      if (head[0] === 'of' || head[0] === 'in') { const src = hoistExpr(head[2]); return [...src.pre, ['for', [head[0], head[1], src.expr], blockOf(st[2])]] }
      if (head[0] === ';') {
        const [, init, cond, step] = head
        return [['for', [';', init != null && refsAwait(init) ? seq(hoistStmt(init)) : init, cond, step], blockOf(st[2])]]
      }
    }
    if (op === 'for await' && Array.isArray(st[1]) && st[1][0] === 'of') { const src = hoistExpr(st[1][2]); return [...src.pre, ['for await', ['of', st[1][1], src.expr], blockOf(st[2])]] }
    if (op === 'try') return [['try', blockOf(st[1]), ...st.slice(2).map(c => c[0] === 'catch' ? ['catch', c[1], blockOf(c[2])] : c[0] === 'finally' ? ['finally', blockOf(c[1])] : c)]]
    if (op === 'switch') { const d = hoistExpr(st[1]); return [...d.pre, ['switch', d.expr, ...st.slice(2).map(c => c[0] === 'case' ? ['case', c[1], seq(hoistList(c[2]))] : c[0] === 'default' ? ['default', seq(hoistList(c[1]))] : c)]] }
    // what the labeled statement evaluates first stands ahead of the label
    if (op === ':' && typeof st[1] === 'string') { const list = hoistStmt(st[2]); return [...list.slice(0, -1), [':', st[1], list[list.length - 1]]] }
    const h = hoistExpr(st)
    return [...h.pre, ...(typeof h.expr === 'string' ? [] : [h.expr])]
  }
  /** A body whose every yield and await stands at a statement (above). */
  const hoistSuspensions = (body) => Array.isArray(body) && body[0] === '{}' ? block(hoistList(body)) : seq(hoistList(body))

  // An async generator's `return E` awaits E (ECMA-262 ReturnStatement), inside
  // whatever try it stands in; a bare `return` does not.
  function awaitReturns(node) {
    if (!Array.isArray(node) || FN_OPS.has(node[0])) return node
    if (node[0] === 'return' && node[1] !== undefined) return withLoc(['return', ['await', node[1]]], node)
    return withLoc(node.map((n, i) => i === 0 ? n : awaitReturns(n)), node)
  }

  // async (a, b) => body / async function (a, b) { body } →
  //   (a, b) => __async_run(MACHINE_FACTORY(a, b))
  // The factory is the standard generator lowering of the body.
  function lowerAsync(params, body) {
    // Source-level desugar: (a, b) => __async_run((function* (a, b) { mappedBody })(a, b))
    // The function* expression rides the standard generator lowering; the body
    // runs synchronously to the first await (spec), then parks on the promise.
    // The wrapper passes each argument on as it took it, a pattern's or a
    // default's in a name of its own, a rest by spreading it: the machine's
    // parameters are then its callers' arguments, as a plain function's are. A
    // function reading `arguments` takes them all, `(...aa)`, keeping their count.
    // An async function is no generator: its machine would take a yield for a suspension.
    if (some([null, params, body], n => n[0] === 'yield' || n[0] === 'yield*', { boundary: fnBoundary }))
      err('yield outside a generator body: an async function yields nothing, an `async function*` does')
    const prior = enterBody(params, body)
    let hoisted
    try { hoisted = hoistSuspensions(body) } finally { leaveBody(prior) }
    const machine = ['function*', null, params, mapAwait(hoisted)], list = extractParams(params)
    const own = usesArguments(body) || usesArguments(params) ? [['...', genTemp('aa')]]
      : list.map(p => typeof p === 'string' ? p : Array.isArray(p) && p[0] === '...' ? ['...', genTemp('aa')] : genTemp('ap'))
    const seq = (l) => l.length === 0 ? null : l.length === 1 ? l[0] : [',', ...l]
    const run = ['()', '__async_run', ['()', machine, seq(own.map(p => Array.isArray(p) ? p.slice() : p))]]
    if (list.every(p => typeof p === 'string')) return ['=>', ['()', seq(own)], run]
    // Defaults and destructuring run in the factory, before the driver can
    // catch body exceptions. An async call rejects for either kind of failure.
    const error = genTemp('ae')
    return ['=>', ['()', seq(own)], ['{}', [';',
      ['try', ['{}', ['return', run]], ['catch', error, ['{}', ['return', ['()', '__p_reject', error]]]]]]]]
  }

  // async function* (params) { body } → (...aa) => __ag_run(TAGGED_MACHINE(...aa)):
  // the body lowers as an async function's does, its for await desugared; the
  // machine (generators.js, its async mode) suspends at awaits and yields
  // alike, tagging which for the driver, and lowers yield*.
  function lowerAsyncGen(params, body) {
    const aa = genTemp('ag'), prior = enterBody(params, body)
    let hoisted
    try { hoisted = hoistSuspensions(awaitReturns(body)) } finally { leaveBody(prior) }
    return ['=>', ['()', ['...', aa]],
      ['()', '__ag_run', ['()', ['function*', null, params, mapAwait(hoisted), 'async'], ['...', aa]]]]
  }

  return {
    lowerAsync, lowerAsyncGen, hoistSuspensions, hoistExpr, enterBody, leaveBody,
  }
}
