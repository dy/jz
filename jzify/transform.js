/**
 * AST transform handlers — function/class/control-flow lowering after hoisting.
 * @module jzify/transform
 */

import { warn } from '../src/ctx.js'
import { JZ_BLOCK_OPS, LABEL_BODY_OPS, STMT_ONLY_OPS, paramList } from '../src/ast.js'
import { isDestructurePat } from './hoist-vars.js'

const ERROR_INSTANCEOF = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'ReferenceError', 'URIError', 'EvalError'])

const TYPED_ARRAYS = new Set(['Float64Array','Float32Array','Int32Array','Uint32Array',
  'Int16Array','Uint16Array','Int8Array','Uint8Array',
  'ArrayBuffer','BigInt64Array','BigUint64Array','DataView'])

const isProto = n => Array.isArray(n) && n[0] === '.' && Array.isArray(n[1]) && n[1][0] === '.' && n[1][2] === 'prototype'

function staticInstanceofFold(val, ctor) {
  if (typeof ctor !== 'string' || !Array.isArray(val)) return null
  if (val[0] === '()' && val.length === 2) return staticInstanceofFold(val[1], ctor)
  if (val[0] === '[]' && val.length <= 2) return ctor === 'Array' || ctor === 'Object'
  if (val[0] === '{}') return ctor === 'Object'
  if (val[0] === '//') return ctor === 'RegExp' || ctor === 'Object'
  if (val[0] === 'new') {
    const inner = val[1]
    const cname = typeof inner === 'string' ? inner
      : (Array.isArray(inner) && inner[0] === '()' && typeof inner[1] === 'string') ? inner[1]
      : null
    if (cname) return cname === ctor || (cname !== 'Object' && ctor === 'Object')
  }
  if (val[0] == null && val.length === 2) {
    const v = val[1]
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v == null) return false
  }
  return null
}

function dedupeRedecls(stmts) {
  const declName = d => typeof d === 'string' ? d
    : Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' ? d[1] : null
  const seen = new Set(), out = []
  for (const s of stmts) {
    if (!Array.isArray(s) || (s[0] !== 'let' && s[0] !== 'const' && s[0] !== 'var')) { out.push(s); continue }
    const keep = [s[0]], reassign = []
    for (let i = 1; i < s.length; i++) {
      const d = s[i], n = declName(d)
      if (n == null) { keep.push(d); continue }
      if (seen.has(n)) { if (Array.isArray(d) && d[0] === '=') reassign.push(['=', d[1], d[2]]) }
      else { seen.add(n); keep.push(d) }
    }
    if (keep.length > 1) out.push(keep)
    for (const r of reassign) out.push(r)
  }
  return out
}

function functionBodyBlock(body) {
  if (Array.isArray(body) && body[0] === '{}') return body
  if (Array.isArray(body) && body[0] === ';') return ['{}', body]
  return ['{}', [';', body]]
}

const arrowParams = params => Array.isArray(params) && params[0] === '()' ? params : ['()', params]

/**
 * @param {object} opts
 * @param {ReturnType<import('./names.js').createNames>} opts.names
 * @param {Function} opts.lowerArguments
 * @param {Function} opts.transformPattern
 * @param {Function} opts.normalizeCaseBody
 * @param {Function} opts.transformSwitch
 * @param {() => Function} opts.lowerClass
 * @param {() => Function} opts.lowerObjectLiteralThis
 * @param {() => Function} opts.lowerArrayConstructor
 */
export function createTransform(opts) {
  const { names, lowerArguments, transformPattern, normalizeCaseBody, transformSwitch } = opts
  const lowerClass = (...a) => opts.lowerClass()(...a)
  const lowerObjectLiteralThis = (...a) => opts.lowerObjectLiteralThis()(...a)
  const lowerArrayConstructor = (...a) => opts.lowerArrayConstructor()(...a)

  const methodOverrideHasOwn = (a, b) => {
    const proto = isProto(a) ? a : isProto(b) ? b : null
    if (!proto) return null
    const other = proto === a ? b : a
    if (!Array.isArray(other) || other[0] !== '.' || other[2] !== proto[2]) return null
    return ['()', ['.', transform(other[1]), 'hasOwnProperty'], [null, proto[2]]]
  }

  function wrapArrowBody(body) {
    const t = transformScope(body)
    if (!Array.isArray(t)) return ['{}', [';', t]]
    if (t[0] === ';') return ['{}', t]
    if (t[0] !== '{}') return ['{}', [';', t]]
    if (t.length === 2 && !(Array.isArray(t[1]) && t[1][0] === ';')) return ['{}', [';', t[1]]]
    return t
  }

  function hoistFnDecl(name, params, body) {
    const [p2, b2] = lowerArguments(params, functionBodyBlock(body))
    const decl = ['const', ['=', name, ['=>', p2, wrapArrowBody(b2)]]]
    decl._hoisted = true
    return decl
  }

  function transformScope(node) {
    if (!Array.isArray(node)) return transform(node)

    const [op, ...args] = node

    if (op === 'function' && args[0]) return hoistFnDecl(...args)
    if (op === 'class' && args[0]) return ['let', ['=', args[0], lowerClass(...args)]]

    if (op === ';') {
      const hoisted = [], rest = []
      for (let i = 0; i < args.length; i++) {
        const stmt = args[i]
        if (Array.isArray(stmt) && stmt[0] === 'function' && stmt[1]) {
          hoisted.push(hoistFnDecl(stmt[1], stmt[2], stmt[3]))
          continue
        }
        if (Array.isArray(stmt) && stmt[0] === 'class' && stmt[1]) {
          rest.push(['let', ['=', stmt[1], lowerClass(stmt[1], stmt[2], stmt[3])]])
          continue
        }
        const t = transform(stmt)
        if (t == null) continue
        if (Array.isArray(t) && t[0] === 'const' && t._hoisted) {
          hoisted.push(t)
        } else if (Array.isArray(t) && t[0] === ';') {
          for (const s of t.slice(1)) {
            if (s != null) {
              if (Array.isArray(s) && s[0] === 'const' && s._hoisted) hoisted.push(s)
              else rest.push(s)
            }
          }
        } else {
          rest.push(t)
        }
      }
      // ES hoists every import binding above any function body. jzify mirrors
      // that by floating imports ahead of hoisted function decls. A combo import
      // `import d, { n } from 'm'` parses as `[',', ['import',…], ['from',…]]`, so
      // match the comma-wrapped form too — otherwise its bindings land after the
      // hoisted functions that reference them ("X is not in scope").
      const isImportStmt = s => Array.isArray(s) &&
        (s[0] === 'import' || (s[0] === ',' && Array.isArray(s[1]) && s[1][0] === 'import'))
      const imports = rest.filter(isImportStmt)
      const nonImports = rest.filter(s => !isImportStmt(s))
      const all = dedupeRedecls([...imports, ...hoisted, ...nonImports])
      return all.length === 0 ? null : all.length === 1 ? all[0] : [';', ...all]
    }

    return transform(node)
  }

  const handlers = {
    '()'(callee, ...rest) {
      if (callee === 'Array') {
        const lit = lowerArrayConstructor(rest[0])
        if (lit) return lit
      }
      if (Array.isArray(callee) && callee[0] === '()' && Array.isArray(callee[1]) && callee[1][0] === 'function' && callee[1][1]) {
        const [, name, params, body] = callee[1]
        const [p2, b2] = lowerArguments(params, functionBodyBlock(body))
        return [';', ['let', ['=', name, ['=>', arrowParams(p2), wrapArrowBody(b2)]]], ['()', name, ...rest.map(transform)]]
      }
    },

    'function'(name, params, body) {
      const [p2, b2] = lowerArguments(params, functionBodyBlock(body))
      const arrow = ['=>', p2, wrapArrowBody(b2)]
      if (name) {
        return ['()', ['()', ['=>', null, ['{}', [';',
          ['let', name],
          ['=', name, arrow],
          ['return', name]
        ]]]], null]
      }
      return arrow
    },

    '=>'(params, body) {
      let b = body
      if (Array.isArray(b) && b[0] === '{}' && b.length === 2) {
        const inner = b[1]
        if (inner != null && !(Array.isArray(inner) && inner[0] === ';')) {
          b = ['{}', [';', inner]]
        }
      } else if (Array.isArray(b) && STMT_ONLY_OPS.has(b[0])) {
        // Subscript's expression grammar lets statement-only ops (`if`, `for`,
        // `return`, `;`, …) appear in concise-body position — method shorthand
        // `m(){ stmt }` parses to `['=>', p, stmt]` with no `{}` wrap (the body
        // braces are structural, not a group operator). A concise body must
        // yield a value, so these void ops would otherwise be coerced into the
        // f64 return slot ("not enough arguments on the stack for f64.convert_i32_s").
        // Re-wrap as a block — statement bodies belong in block form.
        b = b[0] === ';' ? ['{}', b] : ['{}', [';', b]]
      }
      const [p2, b2] = lowerArguments(params, b)
      return ['=>', p2, transform(b2)]
    },

    'class'(name, heritage, body) { return lowerClass(name, heritage, body) },

    'var'(...args) {
      return ['let', ...args.map(transform)]
    },

    ':'(label, body) {
      if (typeof label === 'string' && Array.isArray(body) && LABEL_BODY_OPS.has(body[0]))
        return ['label', label, transform(body)]
    },

    '='(lhs, rhs) {
      if (isDestructurePat(lhs)) return ['=', transformPattern(lhs), transform(rhs)]
    },

    'switch'(disc, ...cases) {
      const clean = cases.map(c => {
        if (c[0] === 'case') return ['case', c[1], normalizeCaseBody(c[2])]
        if (c[0] === 'default') return ['default', normalizeCaseBody(c[1])]
        return c
      })
      return transformSwitch(disc, clean)
    },

    '=='(a, b) { const own = methodOverrideHasOwn(a, b); if (own) return ['!', own]; return isProto(a) || isProto(b) ? 1 : ['==', transform(a), transform(b)] },
    '!='(a, b) { const own = methodOverrideHasOwn(a, b); if (own) return own; return isProto(a) || isProto(b) ? 0 : ['!=', transform(a), transform(b)] },
    '==='(a, b) { const own = methodOverrideHasOwn(a, b); if (own) return ['!', own]; if (isProto(a) || isProto(b)) return 1 },
    '!=='(a, b) { const own = methodOverrideHasOwn(a, b); if (own) return own; if (isProto(a) || isProto(b)) return 0 },

    'new'(ctor, ...cargs) {
      if (Array.isArray(ctor) && ctor[0] === '()' && ctor[1] === 'Array') {
        const lit = lowerArrayConstructor(ctor[2])
        if (lit) return lit
      }
      const name = typeof ctor === 'string' ? ctor : (Array.isArray(ctor) && ctor[0] === '()' ? ctor[1] : null)
      if (typeof name === 'string' && (TYPED_ARRAYS.has(name) || name === 'Array' || name === 'RegExp')) return ['new', transform(ctor), ...cargs.map(transform)]
      if (Array.isArray(ctor) && ctor[0] === '()') return transform(ctor)
      return ['()', transform(ctor), ...(cargs.length ? cargs.map(transform) : [null])]
    },

    'instanceof'(val, ctor) {
      const t = transform(val)
      const name = typeof ctor === 'string' ? ctor : (Array.isArray(ctor) && ctor[0] === '()' ? ctor[1] : null)
      const fold = staticInstanceofFold(val, name)
      if (fold != null) return [null, fold]
      if (typeof name === 'string' && ERROR_INSTANCEOF.has(name)) {
        warn('untagged-instanceof',
          `\`instanceof ${name}\` does not discriminate thrown values in jz — errors are untagged; inspect the message or value instead`,
          {}, Array.isArray(val) ? val.loc : null)
      }
      if (name === 'Array') return ['()', ['.', 'Array', 'isArray'], t]
      if (name === 'Map') return ['()', '__is_map', t]
      if (name === 'Set') return ['()', '__is_set', t]
      if (typeof name === 'string' && TYPED_ARRAYS.has(name) && name !== 'ArrayBuffer' && name !== 'DataView')
        return ['()', '__is_typed', t]
      return ['===', ['typeof', t], [null, 'object']]
    },

    'do'(body, cond) {
      const flag = names.doFlag()
      return [';',
        ['let', ['=', flag, [null, true]]],
        ['while', ['||', flag, transform(cond)], ['{}', [';', ['=', flag, [null, false]], transform(body)]]]]
    },

    // A bare statement sequence is a block scope too. `parse` only wraps
    // function/arrow bodies in `{}`; loop/conditional bodies arrive as a raw
    // `;`. Route them through transformScope so `function` declarations nested
    // in a loop/if body get hoisted (→ block-top `const f = arrow`) instead of
    // falling to the discard-IIFE path, which would scope the name inside the
    // IIFE and leave later `f()` references dangling.
    ';'(...args) { return transformScope([';', ...args]) },

    '{}'(...args) {
      const loweredObject = lowerObjectLiteralThis(args)
      if (loweredObject) return loweredObject

      return ['{}', ...args.map((a, i) => {
        const t = transformScope(a) ?? a
        if (i !== 0 || a == null) return t
        const blockIn = Array.isArray(a) && JZ_BLOCK_OPS.has(a[0])
        if (!blockIn || t == null) return t
        return Array.isArray(t) && t[0] === ';' ? t : [';', t]
      })]
    },

    'export'(inner) {
      if (Array.isArray(inner) && inner[0] === 'function' && inner[1]) {
        return ['export', hoistFnDecl(inner[1], inner[2], inner[3])]
      }
      if (Array.isArray(inner) && inner[0] === 'class' && inner[1]) {
        return ['export', ['let', ['=', inner[1], lowerClass(inner[1], inner[2], inner[3])]]]
      }
      if (Array.isArray(inner) && inner[0] === 'default' && Array.isArray(inner[1]) && inner[1][0] === 'function' && inner[1][1]) {
        const decl = hoistFnDecl(inner[1][1], inner[1][2], inner[1][3])
        return [';', decl, ['export', ['default', inner[1][1]]]]
      }
      if (Array.isArray(inner) && inner[0] === 'default' && Array.isArray(inner[1]) && inner[1][0] === 'class' && inner[1][1]) {
        return [';', ['let', ['=', inner[1][1], lowerClass(inner[1][1], inner[1][2], inner[1][3])]], ['export', ['default', inner[1][1]]]]
      }
      return ['export', transform(inner)]
    },
  }

  function transform(node) {
    if (node == null || typeof node !== 'object' || !Array.isArray(node)) return node
    const [op, ...args] = node
    if (op == null) return node
    const h = handlers[op]
    return (h && h(...args)) ?? [op, ...args.map(transform)]
  }

  return { transform, transformScope }
}
