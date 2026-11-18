/**
 * A chain that is a list in meaning, written as a list. src/parse.js runs it on
 * every tree it reads (the program, each imported module), before the early
 * errors and every walk after them.
 *
 * Those walks recurse down the tree a few frames a level, so a chain thousands
 * of links long (generated code: a decision list, a long sum, a string built by
 * `+`, a call chain) reached the end of the stack in one of them. Past LEN links a
 * chain is written in a form of the same meaning no deeper than LEN:
 *
 *   - an else-if chain: a guard list, `L: { if (c1) { A1; break L } … E }`. An arm
 *     that cannot complete normally takes no `break`; with none the label goes.
 *   - a `?:` chain returned, standing as a statement, or assigned to a name by a
 *     statement: that else-if chain. Elsewhere: chunks of LEN arms behind a flag,
 *     `(d = 1, c1 ? (v = a1, d = 0) : … : 0, d && (…), …, d ? e : v)`.
 *   - `&&`, `||` or `??` of one operator: a balanced tree, the same in value and in
 *     what it evaluates.
 *   - a left spine of any other binary operator, member read or call: steps on an
 *     accumulator, `(t = <LEN links>, t = t <LEN links>, …, t <rest>)`; a second one
 *     from the first link that adds a string literal or a template, where the value
 *     turns to a string, so neither holds both.
 *
 * Each form evaluates what the chain evaluated, in its order: a cut stores a left
 * operand the chain held anyway. A cut never parts a call from the member it calls
 * (the receiver is its `this`) and never stands above a link an optional link's
 * short circuit spans. The temps (accumulator, flag, value) are declared at the
 * top of the enclosing function body (an expression body made a block) or of the
 * program; a chain with no body to declare them in (a parameter's default, a class
 * member) keeps its form, as does a nesting no list flattens (`-(-(…))`, `[[[…]]]`).
 *
 * @module list-form
 */
import { T } from './ast.js'

export const LEN = 64
const isArr = Array.isArray
const LEFT = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>', '>>>', '<', '>', '<=', '>=',
  '==', '!=', '===', '!==', 'in', 'instanceof', '.', '[]', '()'])
const LOGIC = new Set(['&&', '||', '??'])
const OPTIONAL = new Set(['?.', '?.[]', '?.()'])
const TARGET = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '&=', '|=', '^=', '<<=', '>>=', '>>>=',
  '&&=', '||=', '??=', '++', '--', 'delete'])
const LEAVES = new Set(['return', 'throw', 'break', 'continue'])
const DECL = new Set(['let', 'const', 'var', 'class', 'function', 'function*', 'async', 'using', 'await'])
// (the modes a node is walked in: a statement's place; a reference's top, which stays a member)
const STMT = 1, KEEP = 2

const isLink = n => isArr(n) && n.length === 3 && LEFT.has(n[0])
const isParen = n => isArr(n) && n.length === 2 && n[0] === '()'
const isCall = n => isArr(n) && n.length === 3 && n[0] === '()'
const isMember = n => isArr(n) && n.length === 3 && (n[0] === '.' || n[0] === '[]')
const isStrLit = n => isArr(n) && n.length === 2 && n[0] == null && typeof n[1] === 'string'
const isText = n => isStrLit(n) || isArr(n) && n[0] === '`'
const at = (node, from) => { if (isArr(from) && typeof from.loc === 'number') node.loc = from.loc; return node }

// (fresh names; a compile restarts them, src/parse.js)
let names = 0
const fresh = (stem) => `${T}lf${stem}${names++}`
export const restartNames = () => { names = 0 }

/** The statements of an arm or a body: a list's items, or the one statement. */
const items = (s) => s == null ? [] : isArr(s) && s[0] === ';' ? s.slice(1) : [s]
const list = (a) => a.length === 1 ? a[0] : [';', ...a]
/** Whether arm `s` cannot complete normally: its last statement leaves. */
const leaves = (s) => {
  const a = items(s)
  let k = a.length - 1
  while (k >= 0 && a[k] == null) k--
  return k >= 0 && isArr(a[k]) && LEAVES.has(a[k][0])
}
const declares = (s) => items(s).some(x => isArr(x) && DECL.has(x[0]))

/** An else-if chain (its links, `if` nodes reused in place, and the last else
 *  arm) as the guard list of the same meaning. `label()` names the block where an
 *  arm completes normally and must leave it; `labelOp` is the labeled statement's
 *  operator (jzify writes its own, `label`). */
export function guardList(links, elseArm, label, from, labelOp = ':') {
  const ends = links.every(l => leaves(l[2]))
  const name = ends ? null : label()
  const out = [';']
  for (const l of links) {
    l.length = 3
    if (!ends && !leaves(l[2])) l[2] = list([...items(l[2]), ['break', name]])
    out.push(l)
  }
  // an else arm that declares keeps a block of its own: the tests before it would see its names
  if (elseArm != null) declares(elseArm) ? out.push(at(['{}', elseArm], from)) : out.push(...items(elseArm))
  const block = at(['{}', out], from)
  return ends ? block : at([labelOp, name, block], from)
}

/** Rewrite `ast` in place; returns the tree that stands for it. */
export function listForm(ast) {
  const root = [ast]
  const program = { holder: root, at: 0, arrow: false, temps: null }
  const scopes = [program]
  // a flat stack of quadruples: holder, index of the node in it, the scope its
  // temps go to (null: none), the mode
  const todo = [root, 0, program, STMT]
  const push = (h, i, s, m) => { if (isArr(h[i])) todo.push(h, i, s, m) }
  const pushFrom = (n, from, s, m) => { for (let i = n.length - 1; i >= from; i--) push(n, i, s, m) }
  const temp = (scope, stem) => { const t = fresh(stem); (scope.temps ??= []).push(t); return t }
  while (todo.length) {
    const mode = todo.pop(), scope = todo.pop(), i = todo.pop(), holder = todo.pop()
    const n = holder[i], op = n[0]
    if (op == null) continue
    // a function's body is a scope; its parameters have none
    if (op === '=>' || op === 'function' || op === 'function*' || op === 'get' || op === 'set') {
      const arrow = op === '=>', bi = arrow ? 2 : 3
      // an expression body that is a long `?:` chain: the value it returns
      if (arrow && ternaryLength(n[2]) > LEN) n[2] = at(['{}', at(['return', n[2]], n[2])], n[2])
      const s = { holder: n, at: bi, arrow, temps: null }
      scopes.push(s)
      push(n, bi, s, arrow && !(isArr(n[2]) && n[2][0] === '{}') ? 0 : STMT)
      push(n, bi - 1, null, 0)
      continue
    }
    if (op === 'class') {
      push(n, 2, scope, 0)
      if (isArr(n[3]) && n[3][0] === ';') pushFrom(n[3], 1, null, 0); else push(n, 3, null, 0)
      continue
    }
    // statements
    if (op === ';') {
      for (let k = n.length - 1; k >= 1; k--) {
        if (isArr(n[k])) n[k] = statementTernary(n[k]) ?? n[k]
        push(n, k, scope, STMT)
      }
      continue
    }
    if (op === 'return' && ternaryLength(n[1]) > LEN) {
      holder[i] = elseIfOf(n[1], v => at(['return', v], n))
      push(holder, i, scope, STMT)
      continue
    }
    if (op === 'if') {
      const links = []
      let m = n
      while (isArr(m) && m[0] === 'if') { links.push(m); m = m[3] }
      if (links.length > LEN) { holder[i] = guardList(links, m, () => fresh('L'), n); push(holder, i, scope, STMT); continue }
      const last = links[links.length - 1]
      push(last, 3, scope, STMT)
      for (let k = links.length - 1; k >= 0; k--) { push(links[k], 2, scope, STMT); push(links[k], 1, scope, 0) }
      continue
    }
    if (op === 'for' || op === 'for await') {
      const head = n[1]
      push(n, 2, scope, STMT)
      if (isArr(head) && head[0] === ';') pushFrom(head, 1, scope, 0)
      else if (isArr(head) && (head[0] === 'in' || head[0] === 'of')) { push(head, 2, scope, 0); push(head, 1, scope, KEEP) }
      else push(n, 1, scope, 0)
      continue
    }
    if (op === 'while' || op === 'with') { push(n, 2, scope, STMT); push(n, 1, scope, 0); continue }
    if (op === 'do') { push(n, 2, scope, 0); push(n, 1, scope, STMT); continue }
    if (op === 'switch') {
      for (let k = n.length - 1; k >= 2; k--) {
        const c = n[k]
        if (!isArr(c)) continue
        if (c[0] === 'case') { push(c, 2, scope, STMT); push(c, 1, scope, 0) } else push(c, 1, scope, STMT)
      }
      push(n, 1, scope, 0)
      continue
    }
    if (op === 'try') {
      for (let k = n.length - 1; k >= 2; k--) {
        const c = n[k]
        if (!isArr(c)) continue
        if (c[0] === 'catch') { push(c, 2, scope, STMT); push(c, 1, null, 0) } else push(c, 1, scope, STMT)
      }
      push(n, 1, scope, STMT)
      continue
    }
    if (mode & STMT && op === '{}') { pushFrom(n, 1, scope, STMT); continue }
    if (mode & STMT && op === ':' && typeof n[1] === 'string') { push(n, 2, scope, STMT); continue }
    // expressions
    if (op === '?' && n.length === 4) {
      if (scope && ternaryLength(n) > LEN) { holder[i] = flagged(n, temp(scope, 'D'), temp(scope, 'V')); push(holder, i, scope, 0); continue }
      let m = n
      while (isArr(m) && m[0] === '?' && m.length === 4) { push(m, 2, scope, 0); push(m, 1, scope, 0); if (!(isArr(m[3]) && m[3][0] === '?' && m[3].length === 4)) push(m, 3, scope, 0); m = m[3] }
      continue
    }
    if (LOGIC.has(op) && n.length === 3) {
      const ops = [], slots = []
      if (inOrder(n, op, ops, slots) > LEN) {
        const operands = []
        for (let k = 0; k < slots.length; k += 2) operands.push(slots[k][slots[k + 1]])
        holder[i] = balance(ops, operands, 0, operands.length)
        push(holder, i, scope, 0)
        continue
      }
      for (let k = slots.length - 2; k >= 0; k -= 2) push(slots[k], slots[k + 1], scope, 0)
      continue
    }
    if (isLink(n) && !(mode & KEEP)) {
      const links = []
      let m = n
      for (;;) {
        links.push(m)
        let c = m[1]
        while (isParen(c) && isLink(c[1])) c = c[1]
        if (!isLink(c)) break
        m = c
      }
      if (links.length > LEN && scope) {
        const out = accumulate(links, () => temp(scope, 'A'))
        if (out !== n) { holder[i] = out; push(holder, i, scope, 0); continue }
      }
      // what the links hold beside the next link, and the operand at the bottom
      const bottom = links[links.length - 1]
      push(bottom, 1, scope, isCall(bottom) ? KEEP : 0)
      for (let k = links.length - 1; k >= 0; k--) push(links[k], 2, scope, 0)
      continue
    }
    // a reference's top stays a member: the object below it may be a chain
    if (isLink(n)) { push(n, 2, scope, 0); push(n, 1, scope, isCall(n) ? KEEP : 0); continue }
    if (TARGET.has(op) || op === '?.()' || op === '``') { pushFrom(n, 2, scope, 0); push(n, 1, scope, KEEP); continue }
    if (op === 'new' && isCall(n[1])) { push(n[1], 2, scope, 0); push(n[1], 1, scope, 0); continue }
    pushFrom(n, 1, scope, 0)
  }
  for (const s of scopes) if (s.temps) declare(s)
  return root[0]
}

/** The links of a `?:` chain down its alternates; 0 for any other node. */
function ternaryLength(n) {
  let k = 0
  while (isArr(n) && n[0] === '?' && n.length === 4) { k++; n = n[3] }
  return k
}
/** A `?:` chain as the else-if chain whose arms are `arm(value)`. */
function elseIfOf(n, arm) {
  let first = null, prev = null
  while (isArr(n) && n[0] === '?' && n.length === 4) {
    const link = at(['if', n[1], arm(n[2])], n)
    if (prev) prev.push(link); else first = link
    prev = link
    n = n[3]
  }
  prev.push(arm(n))
  return first
}
/** A statement that is a long `?:` chain, or assigns one to a name: its else-if chain. */
function statementTernary(s) {
  if (ternaryLength(s) > LEN) return elseIfOf(s, v => v)
  if (s[0] === '=' && typeof s[1] === 'string' && ternaryLength(s[2]) > LEN) return elseIfOf(s[2], v => at(['=', s[1], v], s))
  return null
}

/** A `?:` chain in an expression: chunks of LEN arms behind flag `d`, the value in `v`. */
function flagged(n, d, v) {
  const arms = []
  while (isArr(n) && n[0] === '?' && n.length === 4) { arms.push(n); n = n[3] }
  const seq = [',', at(['=', d, [null, 1]], arms[0])]
  for (let k = 0; k < arms.length; k += LEN) {
    let chunk = [null, 0]
    for (let j = Math.min(k + LEN, arms.length) - 1; j >= k; j--) {
      const a = arms[j]
      a[2] = at(['()', [',', ['=', v, a[2]], ['=', d, [null, 0]]]], a)
      a[3] = chunk
      chunk = a
    }
    seq.push(k ? at(['&&', d, ['()', chunk]], chunk) : chunk)
  }
  seq.push(at(['?', d, n, v], arms[0]))
  return at(['()', seq], arms[0])
}

/** A tree of one logical operator, left to right through parentheses around the
 *  same operator: its operators between operands into `ops`, the holder and index
 *  of each operand into `slots`. Returns its depth. */
function inOrder(n, op, ops, slots) {
  let depth = 0
  // [holder, index, depth]; an operator stands for itself at depth -1, between its operands
  const st = [[n], 0, 0]
  while (st.length) {
    const d = st.pop(), k = st.pop(), h = st.pop()
    if (d < 0) { ops.push(h); continue }
    let x = h[k]
    while (isParen(x) && isArr(x[1]) && x[1][0] === op && x[1].length === 3) x = x[1]
    if (isArr(x) && x[0] === op && x.length === 3) {
      if (d + 1 > depth) depth = d + 1
      st.push(x, 2, d + 1, x, 0, -1, x, 1, d + 1)
      continue
    }
    slots.push(h, k)
  }
  return depth
}
/** The balanced tree over operands [lo, hi), its interior the operators between them. */
function balance(ops, operands, lo, hi) {
  if (hi - lo === 1) return operands[lo]
  const mid = (lo + hi) >> 1, node = ops[mid - 1]
  const left = balance(ops, operands, lo, mid), right = balance(ops, operands, mid, hi)
  node.length = 3
  node[1] = left
  node[2] = right
  return node
}

/** A long left spine (`links`, top down) as steps on accumulators made by `acc()`. */
function accumulate(links, acc) {
  const m = links.length, top = links[0]
  // where the value turns to a string: a text at the bottom, or the first text a `+` adds
  let turn = -1
  if (isText(links[m - 1][1])) turn = m
  else for (let k = m - 1; k >= 0; k--) if (links[k][0] === '+' && isText(links[k][2])) { turn = k; break }
  // whether an optional link's short circuit spans link k: a member or call on such, with no parenthesis between
  const open = []
  for (let k = m - 1; k >= 0; k--) {
    const l = links[k], below = k === m - 1 ? isArr(l[1]) && OPTIONAL.has(l[1][0]) : l[1] === links[k + 1] && open[k + 1]
    open[k] = (isMember(l) || isCall(l)) && below
  }
  // the cuts, bottom up: at k, links[k] begins a step and reads the accumulator for its left operand
  const cuts = []
  let run = 1
  for (let k = m - 2; k >= 0; k--) {
    const l = links[k], ok = !(isCall(l) && isMember(links[k + 1])) && !((isMember(l) || isCall(l)) && open[k + 1])
    if (ok && (run >= LEN || k === turn)) { cuts.push(k); run = 1 } else run++
  }
  if (!cuts.length) return top
  const seq = [',']
  let t = null, numeric = null, text = null, bottom = m - 1
  for (const k of cuts) {
    // the step whose links run from links[bottom] up to links[k + 1]
    if (t != null) links[bottom][1] = t
    t = k + 1 > turn ? (numeric ??= acc()) : (text ??= acc())
    seq.push(at(['=', t, links[k + 1]], links[k + 1]))
    bottom = k
  }
  links[bottom][1] = t
  seq.push(top)
  return at(['()', seq], top)
}

/** Declare a scope's temps at the top of its body, after its directives. */
function declare(s) {
  const decl = ['let', ...s.temps], body = s.holder[s.at]
  if (s.arrow && !(isArr(body) && body[0] === '{}')) { s.holder[s.at] = at(['{}', [';', decl, at(['return', body], body)]], body); return }
  const stmts = items(s.arrow ? body[1] : body)
  let k = 0
  while (k < stmts.length && isStrLit(stmts[k])) k++
  stmts.splice(k, 0, decl)
  if (s.arrow) body[1] = [';', ...stmts]
  else s.holder[s.at] = [';', ...stmts]
}
