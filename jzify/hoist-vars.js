/**
 * Var hoisting — bubble `var` to scope top, normalize for-heads, destructure patterns.
 * @module jzify/hoist-vars
 */

import { JZ_BLOCK_OPS } from '../src/ast.js'

// A `'[]'`-tagged node is ambiguous pre-prepare(): an array literal/destructure
// pattern (`[a, b]` → `['[]', commaSeqOrSingleElem]`, length ≤ 2 — empty `[]`
// is length 1, one element is length 2, 2+ elements comma-wrap into that one
// slot) and an element-access expression (`arr[i]` → `['[]', receiver, index]`,
// ALWAYS exactly length 3 — two separate args, never comma-wrapped) share the
// tag until prepare() splits them into `'['` (literal) vs `'[]'` (access).
// Length disambiguates: without it, `arr[i] = v` misclassifies as a
// destructuring assignment and gets walked as a pattern (`arr`/`i` treated as
// binding targets) instead of falling through to the plain-assignment path.
// Native jzify happens to reconstruct byte-identical IR either way for this
// shape (both the pattern-walk and the generic-transform fallback are no-ops
// on a receiver-name + literal-index pair) — masking it there; the self-hosted
// kernel exercises the (wrong) pattern-walk's own compiled path and diverges.
export const isDestructurePat = p =>
  Array.isArray(p) && ((p[0] === '[]' && p.length !== 3) || p[0] === '{}' || (p[0] === '=' && isDestructurePat(p[1])))

export function hoistVars(node, names) {
  if (node == null || !Array.isArray(node)) return node
  const op = node[0]
  if (op === 'function') {
    const inner = new Set()
    let body = hoistVars(node[3], inner)
    if (inner.size) body = prependDecls(body, inner)
    return ['function', node[1], node[2], body]
  }
  if (op === '=>') {
    const inner = new Set()
    let body = hoistVars(node[2], inner)
    if (inner.size) body = prependDecls(body, inner)
    return ['=>', node[1], body]
  }
  if (op === 'in' || op === 'of') {
    let lhs = node[1]
    if (Array.isArray(lhs) && lhs[0] === 'var' && typeof lhs[1] === 'string' && lhs.length === 2) {
      names.add(lhs[1])
      lhs = lhs[1]
    } else if (Array.isArray(lhs) && lhs[0] === 'var' && lhs.length === 2 && isDestructurePat(lhs[1])) {
      // `for (var [a, b] of …)` — hoist the pattern's bindings, keep an
      // assignment-form head (the generic var branch DROPPED the declarator).
      lhs = hoistVarPattern(lhs[1], names)
    } else {
      lhs = hoistVars(lhs, names)
    }
    return [op, lhs, hoistVars(node[2], names)]
  }
  if (op === ':' && typeof node[1] === 'string') {
    return [':', node[1], hoistVars(node[2], names)]
  }
  if (op === '=' && Array.isArray(node[1]) && node[1][0] === 'var' && typeof node[1][1] === 'string' && node[1].length === 2) {
    names.add(node[1][1])
    return ['=', node[1][1], hoistVars(node[2], names)]
  }
  if (op === '=' && isDestructurePat(node[1])) {
    return ['=', hoistPattern(node[1], names), hoistVars(node[2], names)]
  }
  if (op === 'for') {
    const head = node[1]
    let h2
    const normalizedHead = normalizeForDeclHead(head, names) || normalizeForCommaHead(head, names)
    if (normalizedHead) {
      h2 = normalizedHead
    } else if (Array.isArray(head) && head[0] === 'var' && Array.isArray(head[1]) &&
        (head[1][0] === 'in' || head[1][0] === 'of') && typeof head[1][1] === 'string') {
      names.add(head[1][1])
      h2 = [head[1][0], head[1][1], hoistVars(head[1][2], names)]
    } else if (Array.isArray(head) && head[0] === 'var' && Array.isArray(head[1]) &&
        (head[1][0] === 'in' || head[1][0] === 'of') && isDestructurePat(head[1][1])) {
      // `for (var [a, b] of …)` / `for (var {x} in …)` — hoist the pattern's
      // bindings, keep an assignment-form head (a silently DROPPED head here
      // was the "'y' is not in scope" class).
      h2 = [head[1][0], hoistVarPattern(head[1][1], names), hoistVars(head[1][2], names)]
    } else if (Array.isArray(head) && head[0] === ';') {
      h2 = [';']
      for (let i = 1; i < head.length; i++) h2.push(hoistVars(head[i], names))
    } else {
      h2 = hoistVars(head, names)
    }
    return ['for', h2, hoistVars(node[2], names)]
  }
  if (op === 'var') {
    const decls = []
    for (let i = 1; i < node.length; i++) {
      const d = node[i]
      if (typeof d === 'string') { names.add(d); continue }
      if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') {
        names.add(d[1])
        decls.push(['=', d[1], hoistVars(d[2], names)])
        continue
      }
      // `var [a, b] = src` / `var {x} = src` — hoist every pattern binding,
      // keep the declarator as an assignment-form destructure (a silently
      // DROPPED declarator here was the "'b' is not in scope" class).
      if (Array.isArray(d) && d[0] === '=' && isDestructurePat(d[1])) {
        decls.push(['=', hoistVarPattern(d[1], names), hoistVars(d[2], names)])
      }
    }
    if (decls.length === 0) return null
    if (decls.length === 1) return decls[0]
    return [',', ...decls]
  }
  if (op === 'let' || op === 'const') {
    const decls = [op]
    for (let i = 1; i < node.length; i++) {
      const d = node[i]
      if (Array.isArray(d) && d[0] === '=' && isDestructurePat(d[1])) {
        decls.push(['=', hoistPattern(d[1], names), hoistVars(d[2], names)])
      } else {
        decls.push(hoistVars(d, names))
      }
    }
    return decls
  }
  if (op === ';') {
    const out = [op]
    for (let i = 1; i < node.length; i++) {
      const child = node[i]
      if (Array.isArray(child) && child[0] === 'var' && child.length === 2 &&
          Array.isArray(child[1]) && child[1][0] === '=' && typeof child[1][1] === 'string' &&
          Array.isArray(child[1][2]) && child[1][2][0] === '=>') {
        out.push(['let', ['=', child[1][1], hoistVars(child[1][2], names)]])
        continue
      }
      const c = hoistVars(child, names)
      if (c != null) out.push(c)
    }
    if (out.length === 1) return null
    if (out.length === 2) return out[1]
    return out
  }
  if (op === '{}' && node.length === 2) {
    const inner = node[1]
    const wasBlock = inner != null && Array.isArray(inner) && JZ_BLOCK_OPS.has(inner[0])
    const t = hoistVars(inner, names)
    if (!wasBlock || t == null) return ['{}', t]
    const stayed = Array.isArray(t) && JZ_BLOCK_OPS.has(t[0])
    return ['{}', stayed ? t : [';', t]]
  }
  const out = new Array(node.length)
  out[0] = op
  for (let i = 1; i < node.length; i++) out[i] = hoistVars(node[i], names)
  return out
}

export function hoistPattern(node, names) {
  if (node == null || !Array.isArray(node)) return node
  const op = node[0]
  if (op === '=') return ['=', hoistPattern(node[1], names), hoistVars(node[2], names)]
  if (op === ':') return [':', hoistVars(node[1], names), hoistPattern(node[2], names)]
  if (op === '...') return ['...', hoistPattern(node[1], names)]
  if (op === '[]' || op === '{}' || op === ',') return [op, ...node.slice(1).map(n => hoistPattern(n, names))]
  return hoistVars(node, names)
}

// `var`-declared pattern: every bare leaf in binding position is a hoisted
// name (the declarator itself becomes a plain assignment). let/const patterns
// keep hoistPattern above — their names are declared by the surviving `let`,
// so collecting them here would predeclare duplicates.
function hoistVarPattern(node, names) {
  if (typeof node === 'string') { names.add(node); return node }
  if (node == null || !Array.isArray(node)) return node
  const op = node[0]
  if (op === '=') return ['=', hoistVarPattern(node[1], names), hoistVars(node[2], names)]
  if (op === ':') return [':', hoistVars(node[1], names), hoistVarPattern(node[2], names)]
  if (op === '...') return ['...', hoistVarPattern(node[1], names)]
  if (op === '[]' || op === '{}' || op === ',') return [op, ...node.slice(1).map(n => hoistVarPattern(n, names))]
  return hoistVars(node, names)
}

export function prependDecls(body, names) {
  const decl = ['let', ...names]
  if (Array.isArray(body) && body[0] === ';') return [';', decl, ...body.slice(1)]
  if (Array.isArray(body) && body[0] === '{}') {
    const inner = body[1]
    if (Array.isArray(inner) && inner[0] === ';') return ['{}', [';', decl, ...inner.slice(1)]]
    if (inner == null) return ['{}', decl]
    return ['{}', [';', decl, inner]]
  }
  return body == null ? decl : [';', decl, body]
}

function normalizeForDeclHead(head, names) {
  if (!Array.isArray(head) || (head[0] !== 'var' && head[0] !== 'let' && head[0] !== 'const')) return null
  const kind = head[0]
  if (head.length === 2) {
    const expr = head[1]
    if (!Array.isArray(expr)) return null
    if (expr.length >= 3 && Array.isArray(expr[1]) &&
        (expr[1][0] === 'in' || expr[1][0] === 'of') && typeof expr[1][1] === 'string') {
      const iter = expr[1]
      return [iter[0], normalizeForDecl(kind, iter[1], names), hoistVars([expr[0], iter[2], ...expr.slice(2)], names)]
    }
    return null
  }
  if (head.length > 2 && Array.isArray(head[1]) &&
      (head[1][0] === 'in' || head[1][0] === 'of') && typeof head[1][1] === 'string') {
    const iter = head[1]
    return [iter[0], normalizeForDecl(kind, iter[1], names), hoistVars([',', iter[2], ...head.slice(2)], names)]
  }
  return null
}

function normalizeForCommaHead(head, names) {
  if (!Array.isArray(head) || head[0] !== ',' || head.length < 3) return null
  const iter = head[1]
  if (!Array.isArray(iter) || (iter[0] !== 'in' && iter[0] !== 'of') || typeof iter[1] !== 'string') return null
  return [iter[0], iter[1], hoistVars([',', iter[2], ...head.slice(2)], names)]
}

function normalizeForDecl(kind, name, names) {
  if (kind === 'var') {
    names.add(name)
    return name
  }
  return [kind, name]
}
