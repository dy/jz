/**
 * Settle declarations — a `var`, or a `let` declared bare, is declared at its
 * first assignment when that assignment dominates every other use: `const`
 * when it is the only write, `let` otherwise.
 *
 *   var t; var i            let t = 0.0
 *   t = 0.0          →      for (let i = 0; i < n; i++) t += x[i]
 *   for (i = 0; …) t += x[i]
 *
 *   var K = 1.5e146  →      const K = 1.5e146
 *
 * Hoisting splits a declaration from its value: the binding is then undefined
 * until the assignment runs, and written twice as far as any later analysis
 * can tell. Where no code can observe the binding before its first assignment
 * the split has no meaning, and the declaration carries its value again.
 *
 * The assignment D dominates when, in source order,
 *   - the first occurrence of the name is D itself, a statement of a list L;
 *   - every other occurrence sits in L after D, at any depth;
 *   - a closure naming it is created in L after D, with D at the top of the
 *     scope, so one binding serves every call;
 *   - a function declaration naming it (hoisted, callable from anywhere) is
 *     reached by no statement that runs before D.
 * A counter is declared by its loop: a name every occurrence of which sits in
 * a `for` whose head assigns it first (`for (i = 0; …)`, `for (var i = 0; …)`,
 * one loop or several in turn) and which no closure names.
 * Anything else keeps the hoisted form. Occurrences are matched by name, so a
 * shadowing binding only makes the pass decline.
 *
 * @module jzify/settle-vars
 */

import { MUTATE_OPS, withLoc } from '../src/ast.js'

const isFn = n => Array.isArray(n) && (n[0] === 'function' || n[0] === 'function*' || n[0] === '=>' || n[0] === 'class')
const isFnDecl = n => Array.isArray(n) && (n[0] === 'function' || n[0] === 'function*') && typeof n[1] === 'string' && n[1] !== ''
const isAccess = n => Array.isArray(n) && (n[0] === '.' || n[0] === '?.' || (n[0] === '[]' && n.length === 3))
const isDeclarator = d => Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string'

export function settleVars(ast) {
  return settleScope(ast, null)
}

function settleScope(body, params) {
  if (body == null || !Array.isArray(body)) return body
  body = splitVars(body)
  const scope = collect(body, params)
  if (scope.cands.size) analyze(body, scope)
  return rewrite(body, scope.cands, scope.heads)
}

// `var a = 1, b = a` → `var a = 1; var b = a` inside a list: each declarator its own statement.
function splitVars(node) {
  if (!Array.isArray(node) || node[0] == null || isFn(node)) return node
  if (node[0] === 'for') {
    const body = splitVars(node[2])
    return body === node[2] ? node : ['for', node[1], body]
  }
  let out = null
  const push = (i, items) => {
    if (!out) out = withLoc(node.slice(0, i), node)
    for (const item of items) out.push(item)
  }
  for (let i = 1; i < node.length; i++) {
    const child = node[i]
    if (node[0] === ';' && Array.isArray(child) && child[0] === 'var' && child.length > 2) {
      push(i, child.slice(1).map(d => withLoc(['var', d], child)))
      continue
    }
    const next = splitVars(child)
    if (next !== child) push(i, [next])
    else if (out) out.push(child)
  }
  return out || node
}

// ── candidates ──────────────────────────────────────────────────────────────

function collect(body, params) {
  const cands = new Map(), blocked = new Set(), fnDecls = new Map()
  const names = (node, each) => {   // every name a pattern or parameter list mentions
    if (typeof node === 'string') each(node)
    else if (Array.isArray(node) && node[0] != null) for (let i = 1; i < node.length; i++) names(node[i], each)
  }
  const block = name => { blocked.add(name) }
  // the names a declaration binds: its targets, never what its values mention
  const bound = (decl, each) => {
    for (let i = 1; i < decl.length; i++) {
      const d = decl[i]
      names(Array.isArray(d) && (d[0] === '=' || d[0] === 'in' || d[0] === 'of') ? d[1] : d, each)
    }
  }
  const cand = (name, kind, decl) => {
    let c = cands.get(name)
    if (!c) cands.set(name, c = { name, kind, decls: [], def: null, ok: true, writes: 0, captured: false, hoisted: null })
    else if (c.kind !== kind) c.ok = false
    c.decls.push(decl)
  }
  names(params, block)
  const walk = (node) => {
    if (!Array.isArray(node) || node[0] == null) return
    const op = node[0]
    if (isFn(node)) {
      if (typeof node[1] === 'string' && node[1] && op !== '=>') { block(node[1]); if (isFnDecl(node)) fnDecls.set(node[1], node) }
      return
    }
    if (op === 'var' || op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (typeof d === 'string') { if (op === 'const') block(d); else cand(d, op, node) }
        else if (isDeclarator(d)) { if (op === 'var') cand(d[1], op, node); else block(d[1]); walk(d[2]) }
        else { names(Array.isArray(d) && d[0] === '=' ? d[1] : d, block); walk(d) }   // a pattern
      }
      return
    }
    if (op === 'for') {   // an in/of head's binding stays with the loop; a counted head's `var` may settle there
      const head = node[1]
      if (Array.isArray(head) && head[0] === ';' && Array.isArray(head[1]) && head[1][0] === 'var' && head[1].slice(1).every(isDeclarator)) {
        for (const d of head[1].slice(1)) { cand(d[1], 'var', head[1]); walk(d[2]) }
        for (let i = 2; i < head.length; i++) walk(head[i])
      } else { heads(head); walk(head) }
      walk(node[2])
      return
    }
    if (op === 'export') {   // an exported binding keeps its form
      const d = node[1]
      if (Array.isArray(d) && (d[0] === 'var' || d[0] === 'let' || d[0] === 'const')) bound(d, block)
      walk(d)
      return
    }
    if (op === 'catch') { names(node[1], block); walk(node[2]); return }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  const heads = (head) => {
    if (!Array.isArray(head)) return
    if (head[0] === 'var' || head[0] === 'let' || head[0] === 'const') { bound(head, block); return }
    for (let i = 1; i < head.length; i++) heads(head[i])
  }
  walk(body)
  for (const name of blocked) cands.delete(name)
  return { cands, fnDecls }
}

// ── analysis ────────────────────────────────────────────────────────────────

function analyze(body, scope) {
  const { cands, fnDecls } = scope
  const heads = scope.heads = new Map()   // a `for` → the counters its head defines
  const path = []   // [list, index] of every enclosing statement list
  let top = null
  const after = def => { for (const f of path) if (f[0] === def.list && f[1] > def.idx) return true; return false }
  const occur = (name) => {
    const c = cands.get(name)
    if (c && c.ok && !(c.region || (c.def && after(c.def)))) c.ok = false
  }
  // the bindings a counted head defines, `[name, value]` declarators; null when it holds anything else
  const counters = (init) => {
    if (!Array.isArray(init)) return null
    const items = init[0] === ',' || init[0] === 'var' ? init.slice(1) : [init]
    for (const d of items) if (!isDeclarator(d) || !cands.has(d[1])) return null
    return items.length ? items : null
  }
  const write = (name) => { const c = cands.get(name); if (c) { c.writes++; occur(name) } }

  // every occurrence inside a nested function, by name
  const scan = (node, each) => {
    if (typeof node === 'string') { each(node, false); return }
    if (!Array.isArray(node) || node[0] == null) return
    const op = node[0]
    if (op === '.' || op === '?.') { scan(node[1], each); return }
    if (op === ':') { if (typeof node[1] !== 'string') scan(node[1], each); scan(node[2], each); return }
    if ((MUTATE_OPS.has(op) || op === 'in' || op === 'of') && !isAccess(node[1])) {
      scan(node[1], (name) => each(name, true))
      for (let i = 2; i < node.length; i++) scan(node[i], each)
      return
    }
    for (let i = 1; i < node.length; i++) scan(node[i], each)
  }
  const capture = (fn) => {
    const hoisted = isFnDecl(fn) && fnDecls.get(fn[1]) === fn
    scan(fn, (name, isWrite) => {
      const c = cands.get(name)
      if (!c) return
      if (isWrite) c.writes++
      if (hoisted) (c.hoisted ||= new Set()).add(fn[1])
      else { c.captured = true; occur(name) }
    })
  }

  const target = (node) => {   // the left side of a write
    if (typeof node === 'string') write(node)
    else if (isAccess(node)) expr(node)
    else if (Array.isArray(node) && node[0] != null) {
      if (node[0] === '=') { expr(node[2]); target(node[1]) }   // a default inside a pattern
      else if (node[0] === ':') { if (typeof node[1] !== 'string') expr(node[1]); target(node[2]) }
      else for (let i = 1; i < node.length; i++) target(node[i])
    }
  }
  const expr = (node) => {
    if (typeof node === 'string') { occur(node); return }
    if (!Array.isArray(node) || node[0] == null) return
    const op = node[0]
    if (isFn(node)) { capture(node); return }
    if (op === '.' || op === '?.') { expr(node[1]); return }
    if (op === ':') { if (typeof node[1] !== 'string') expr(node[1]); expr(node[2]); return }
    if (MUTATE_OPS.has(op) || op === 'in' || op === 'of') {   // a loop head writes its binding
      for (let i = 2; i < node.length; i++) expr(node[i])
      target(node[1])
      return
    }
    if (op === 'var' || op === 'let' || op === 'const') { declare(node, null); return }
    for (let i = 1; i < node.length; i++) expr(node[i])
  }
  const define = (c, init, node, frame) => {
    expr(init)   // the value is read before the binding holds it
    c.writes++
    if (!c.ok) return
    if (c.loops) { c.ok = false; return }   // a counter lives in its loops alone
    if (c.def) { if (!after(c.def)) c.ok = false; return }
    if (isFn(init)) { c.ok = false; return }   // a function binding keeps its own lowering
    c.def = { list: frame[0], idx: frame[1], node, init, top: frame[0] === top }
  }
  const declare = (node, frame) => {
    for (let i = 1; i < node.length; i++) {
      const d = node[i]
      if (typeof d === 'string') continue
      const c = isDeclarator(d) ? cands.get(d[1]) : null
      if (c && frame && node.length === 2) define(c, d[2], node, frame)
      else if (isDeclarator(d)) { expr(d[2]); write(d[1]); if (c) c.ok = false }
      else expr(d)
    }
  }
  const list = (node) => {
    for (let i = 1; i < node.length; i++) {
      path.push([node, i])
      stmt(node[i], path[path.length - 1])
      path.pop()
    }
  }
  // `frame` is set for a direct statement of a list: only there can a definition stand
  const stmt = (node, frame) => {
    if (!Array.isArray(node) || node[0] == null) { expr(node); return }
    const op = node[0]
    if (op === ';') { list(node); return }
    if (op === '{}' && node.length === 2) { stmt(node[1], null); return }
    if (isFnDecl(node) && fnDecls.get(node[1]) === node) { capture(node); return }
    if (op === 'var' || op === 'let' || op === 'const') { declare(node, frame); return }
    if (op === '=' && frame && typeof node[1] === 'string' && cands.has(node[1])) { define(cands.get(node[1]), node[2], node, frame); return }
    if (op === 'if') { expr(node[1]); stmt(node[2], null); stmt(node[3], null); return }
    if (op === 'for') {
      const head = node[1], defs = Array.isArray(head) && head[0] === ';' ? counters(head[1]) : null
      if (defs && defs.every(d => { const c = cands.get(d[1]); return c.ok && !c.def && !c.region })) {
        for (const d of defs) expr(d[2])
        for (const d of defs) { const c = cands.get(d[1]); c.writes++; c.region = node; (c.loops ||= []).push(node) }
        heads.set(node, defs)
        for (let i = 2; i < head.length; i++) expr(head[i])
        stmt(node[2], null)
        for (const d of defs) cands.get(d[1]).region = null
        return
      }
      expr(head); stmt(node[2], null)
      return
    }
    if (op === 'while') { expr(node[1]); stmt(node[2], null); return }
    if (op === 'do') { stmt(node[1], null); expr(node[2]); return }
    if (op === 'switch') { expr(node[1]); for (let i = 2; i < node.length; i++) stmt(node[i], null); return }
    if (op === 'case') { expr(node[1]); stmt(node[2], null); return }
    if (op === 'default' || op === 'finally') { stmt(node[1], null); return }
    if (op === 'try') { for (let i = 1; i < node.length; i++) stmt(node[i], null); return }
    if (op === 'catch') { stmt(node[2], null); return }
    if (op === ':' && typeof node[1] === 'string') { stmt(node[2], null); return }
    if (op === 'export') { stmt(node[1], null); return }
    if (op === 'import') return
    expr(node)
  }

  if (body[0] === ';') top = body
  else if (body[0] === '{}' && body.length === 2 && Array.isArray(body[1]) && body[1][0] === ';') top = body[1]
  stmt(body, null)

  // a function declaration is callable before its text: nothing that runs ahead of D may reach one naming the binding
  const mentions = (node, set) => {
    if (typeof node === 'string') return set.has(node)
    if (!Array.isArray(node) || node[0] == null) return false
    for (let i = 1; i < node.length; i++) if (mentions(node[i], set)) return true
    return false
  }
  for (const c of cands.values()) {
    if (!c.ok || !(c.def || c.loops)) { c.ok = false; continue }
    if (c.loops) { if (c.captured || c.hoisted) c.ok = false; continue }   // a closure would share one binding across iterations
    if ((c.captured || c.hoisted) && !c.def.top) { c.ok = false; continue }
    if (!c.hoisted) continue
    const reach = new Set(c.hoisted)
    for (let grew = true; grew;) {
      grew = false
      for (const [name, fn] of fnDecls) if (!reach.has(name) && mentions(fn, reach)) { reach.add(name); grew = true }
    }
    if (mentions(c.def.init, reach)) { c.ok = false; continue }   // its own value runs ahead of it too
    for (let i = 1; i < c.def.idx && c.ok; i++) {
      const s = c.def.list[i]
      if (!(isFnDecl(s) && fnDecls.get(s[1]) === s) && mentions(s, reach)) c.ok = false
    }
  }
  // one head declares all its counters or none
  for (let again = true; again;) {
    again = false
    for (const defs of heads.values()) {
      if (defs.every(d => cands.get(d[1]).ok) || !defs.some(d => cands.get(d[1]).ok)) continue
      for (const d of defs) cands.get(d[1]).ok = false
      again = true
    }
  }
}

// ── rewrite ─────────────────────────────────────────────────────────────────

// What a node rewrites to stands at its source position (ast.js withLoc).
function rewrite(node, cands, heads) { return withLoc(rewriteNode(node, cands, heads), node) }
function rewriteNode(node, cands, heads) {
  if (!Array.isArray(node) || node[0] == null) return node
  const op = node[0]
  if (op === 'function' || op === 'function*') {
    const body = settleScope(node[3], node[2])
    return body === node[3] ? node : [op, node[1], node[2], body]
  }
  if (op === '=>') {
    const body = settleScope(node[2], node[1])
    return body === node[2] ? node : ['=>', node[1], body]
  }
  if (op === 'var' || op === 'let') {
    const c = node.length === 2 && isDeclarator(node[1]) ? cands.get(node[1][1]) : null
    if (c?.ok && c.def) {
      const value = rewrite(node[1][2], cands, heads)
      // the definition declares; a later `var x = v` of the same name is a plain write
      return c.def.node === node ? [c.writes === 1 ? 'const' : 'let', ['=', c.name, value]] : ['=', c.name, value]
    }
    const out = [op]
    let changed = false
    for (let i = 1; i < node.length; i++) {
      const d = node[i]
      if (typeof d === 'string' && cands.get(d)?.ok) { changed = true; continue }   // declared at its definition
      const next = rewrite(d, cands, heads)
      if (next !== d) changed = true
      out.push(next)
    }
    if (!changed) return node
    return out.length === 1 ? null : out
  }
  if (op === 'for' && Array.isArray(node[1]) && node[1][0] === ';') {   // an empty head part is a part
    const defs = heads?.get(node)
    const settled = defs && cands.get(defs[0][1]).ok
    const head = node[1].map((part, i) => i === 0 ? part
      : i === 1 && settled ? ['let', ...defs.map(d => ['=', d[1], rewrite(d[2], cands, heads)])]
      : rewrite(part, cands, heads))
    const body = rewrite(node[2], cands, heads)
    return body === node[2] && head.every((part, i) => part === node[1][i]) ? node : ['for', head, body]
  }
  if (op === '=' && typeof node[1] === 'string') {
    const c = cands.get(node[1])
    if (c?.ok && c.def?.node === node) return [c.writes === 1 ? 'const' : 'let', ['=', c.name, rewrite(node[2], cands, heads)]]
  }
  let out = null
  for (let i = 1; i < node.length; i++) {
    const child = node[i], next = rewrite(child, cands, heads)
    if (next === child && !out) continue
    if (!out) out = node.slice(0, i)
    if (next != null || op !== ';') out.push(next)
  }
  if (!out) return node
  if (op === ';' && out.length === 1) return null
  return out
}
