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
let _gen = null
export const bindGenerators = (g) => { _gen = g }

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

  // `using x = res` (ERM): bind, resolve [Symbol.dispose] up front (TypeError
  // if absent on a non-null resource — spec checks at binding), then wrap the
  // REST of the scope in try/finally calling it. Multiple resources nest —
  // LIFO disposal falls out of the nesting. Divergence (documented): if both
  // the body and a dispose throw, the dispose error propagates (no
  // SuppressedError aggregation).
  function lowerUsing(declarators, remaining) {
    const NULL = [null, null]
    const dispose = (name) => ['if', ['!=', name, NULL], ['()', ['.', name, '@@dispose'], null]]
    let inner = remaining.length ? transformScope([';', ...remaining]) : null
    for (let k = declarators.length - 1; k >= 0; k--) {
      const [, name, init] = declarators[k]
      inner = [';',
        ['let', ['=', name, transform(init)]],
        ['if', ['&&', ['!=', name, NULL], ['==', ['.', name, '@@dispose'], NULL]],
          ['throw', [null, 'using: value has no [Symbol.dispose]() method']]],
        ['try', inner ?? ['{}', null], ['finally', dispose(name)]],
      ]
    }
    return inner
  }

  function transformScope(node) {
    if (!Array.isArray(node)) return transform(node)

    const [op, ...args] = node

    if (op === 'function' && args[0]) return hoistFnDecl(...args)
    if (op === 'function*' && args[0] && _gen)
      return ['const', ['=', args[0], _gen.lowerGenerator(args[1], args[2])]]
    if (op === 'async' && Array.isArray(args[0]) && args[0][0] === 'function' && args[0][1] && _gen?.lowerAsync)
      return ['const', ['=', args[0][1], transform(_gen.lowerAsync(args[0][2], args[0][3]))]]
    if (op === 'class' && args[0]) return ['let', ['=', args[0], lowerClass(...args)]]
    if (op === 'using') return lowerUsing(args, [])

    if (op === ';') {
      const hoisted = [], rest = []
      for (let i = 0; i < args.length; i++) {
        const stmt = args[i]
        if (Array.isArray(stmt) && stmt[0] === 'function' && stmt[1]) {
          hoisted.push(hoistFnDecl(stmt[1], stmt[2], stmt[3]))
          continue
        }
        if (Array.isArray(stmt) && stmt[0] === 'function*' && stmt[1] && _gen) {
          hoisted.push(['const', ['=', stmt[1], _gen.lowerGenerator(stmt[2], stmt[3])]])
          continue
        }
        // async function DECLARATION — hoists like any function declaration.
        if (Array.isArray(stmt) && stmt[0] === 'async' && Array.isArray(stmt[1]) &&
            stmt[1][0] === 'function' && stmt[1][1] && _gen?.lowerAsync) {
          hoisted.push(['const', ['=', stmt[1][1], transform(_gen.lowerAsync(stmt[1][2], stmt[1][3]))]])
          continue
        }
        if (Array.isArray(stmt) && stmt[0] === 'class' && stmt[1]) {
          rest.push(['let', ['=', stmt[1], lowerClass(stmt[1], stmt[2], stmt[3])]])
          continue
        }
        // `using` consumes the REST of the scope into its try body (disposal
        // runs at scope exit however the scope exits).
        if (Array.isArray(stmt) && stmt[0] === 'using') {
          rest.push(lowerUsing(stmt.slice(1), args.slice(i + 1)))
          break
        }
        // Labeled BLOCK in statement position (`lbl: { … }`): unambiguous here —
        // a ':' STATEMENT can't be an object prop. '{}' stays out of
        // LABEL_BODY_OPS (the expression-context disambiguator), so literal
        // props `k: {…}` never label.
        if (Array.isArray(stmt) && stmt[0] === ':' && typeof stmt[1] === 'string' &&
            Array.isArray(stmt[2]) && stmt[2][0] === '{}') {
          rest.push(['label', stmt[1], transform(stmt[2])])
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

  // Promise statics → the injected plain-jz runtime helpers.
  const P_STATIC = { resolve: '__p_resolve', reject: '__p_reject', all: '__p_all', race: '__p_race' }

  // Spread of a possibly-iterator value (iterator-minting programs only):
  // `...E` → `...__drain(E)` — pass-through for arrays/strings, materializes
  // machines/@@iterator providers. Array literals skip (statically safe).
  const wrapSpreadDrain = (e) => {
    if (!_gen?.iterProto?.on) return null
    const v = e[1]
    if (Array.isArray(v) && (v[0] === '[]' || v[0] == null)) return null
    _gen.iterProto.drain = true
    return ['...', ['()', '__it_drain', transform(v)]]
  }
  const wrapArg = (a) => (Array.isArray(a) && a[0] === '...' && wrapSpreadDrain(a)) || transform(a)

  const handlers = {
    // async function/arrow → (...aa) => __async_run((function* …)(...aa))
    'async'(inner) {
      if (!_gen?.lowerAsync || !Array.isArray(inner)) return
      if (inner[0] === 'function') return transform(_gen.lowerAsync(inner[2], inner[3]))
      if (inner[0] === '=>') {
        const params = Array.isArray(inner[1]) && inner[1][0] === '()' ? inner[1][1] : inner[1]
        return transform(_gen.lowerAsync(params, inner[2]))
      }
      // `async function () {}()` — the parser binds the CALL inside the async
      // wrapper; lower the callee, keep the call.
      if (inner[0] === '()' && Array.isArray(inner[1]) && (inner[1][0] === 'function' || inner[1][0] === '=>'))
        return transform(['()', ['async', inner[1]], ...inner.slice(2)])
    },

    '()'(callee, ...rest) {
      // Promise API rides the async runtime: new Promise(fn) arrives here as a
      // plain call (the `new` handler unwraps unknown ctors), statics by name.
      if (_gen?.noteAsync) {
        if (callee === 'Promise' && rest.length) {
          _gen.noteAsync()
          return ['()', '__p_exec', ...rest.map(a => a == null ? a : transform(a))]
        }
        if (Array.isArray(callee) && callee[0] === '.' && callee[1] === 'Promise' && P_STATIC[callee[2]]) {
          _gen.noteAsync()
          return ['()', P_STATIC[callee[2]], ...rest.map(a => a == null ? a : transform(a))]
        }
      }
      // Terminal iterator helper (toArray/reduce/forEach/some/every/find) on a
      // chain rooted at a known generator call → fused IIFE loop.
      if (_gen && Array.isArray(callee) && callee[0] === '.') {
        const chain = _gen.unwindChain(['()', callee, ...rest])
        if (chain && chain.stages.length && _gen.isTerminal(chain.stages[chain.stages.length - 1].h)) {
          const fused = _gen.fuseTerminal(chain, names.genTemp)
          if (fused) return transform(fused)
        }
      }
      if (callee === 'Array') {
        const lit = lowerArrayConstructor(rest[0])
        if (lit) return lit
      }
      // spread ARG of a possibly-iterator value → __drain (iterator programs only)
      if (_gen?.iterProto?.on && rest.length === 1 && Array.isArray(rest[0])) {
        const args = rest[0]
        if (args[0] === ',' && args.slice(1).some(x => Array.isArray(x) && x[0] === '...'))
          return ['()', transform(callee), [',', ...args.slice(1).map(wrapArg)]]
        if (args[0] === '...') {
          const w = wrapSpreadDrain(args)
          if (w) return ['()', transform(callee), w]
        }
      }
      if (Array.isArray(callee) && callee[0] === '()' && Array.isArray(callee[1]) && callee[1][0] === 'function' && callee[1][1]) {
        const [, name, params, body] = callee[1]
        const [p2, b2] = lowerArguments(params, functionBodyBlock(body))
        // `(function name(){…})(args)` — the named binding must be lowered as a
        // self-contained EXPRESSION (it can sit in concise-arrow-body / argument
        // position), so wrap the `let name = arrow; name(args)` in a block IIFE
        // rather than emitting a bare `;`-sequence. A statement-sequence in
        // expression position never reaches the `'=>'` handler's block-wrap (that
        // runs before this transform), and emit miscompiles a `let`-closure decl in
        // a concise `;`-body. Mirrors the bare-`function name` lowering below.
        return ['()', ['=>', null, ['{}', [';',
          ['let', ['=', name, ['=>', arrowParams(p2), wrapArrowBody(b2)]]],
          ['return', ['()', name, ...rest.map(transform)]],
        ]]], null]
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

    'function*'(name, params, body) {
      // Expression form (`let g = function* () {…}`). Named statement forms are
      // hoisted in transformScope like plain function declarations.
      if (!_gen) return
      return _gen.lowerGenerator(params, body)
    },

    '[]'(payload, idx) {
      // 2-arg form is INDEXING (obj[key]) — not ours. The 1-arg form is the
      // array LITERAL: rewrite a spread of a generator / helper chain into a
      // spread of the FUSED toArray (a plain array) — the existing
      // array-spread machinery takes it from there. In an iterator-minting
      // program, any OTHER spread of a non-literal wraps in __drain (returns
      // the value untouched unless it's an iterator — then materializes it).
      if (!_gen || idx !== undefined) return
      const rewrite = (e) => {
        if (!Array.isArray(e) || e[0] !== '...') return null
        if (Array.isArray(e[1])) {
          const chain = _gen.unwindChain(e[1])
          if (chain && (!chain.stages.length || !_gen.isTerminal(chain.stages[chain.stages.length - 1].h))) {
            const fused = _gen.fuseTerminal({ root: chain.root, stages: [...chain.stages, { h: 'toArray', args: [] }] }, names.genTemp)
            if (fused) return ['...', transform(fused)]
          }
        }
        return wrapSpreadDrain(e)
      }
      if (payload === undefined) return
      if (Array.isArray(payload) && payload[0] === ',') {
        let hit = false
        const mapped = payload.slice(1).map((e) => { const r = rewrite(e); if (r) hit = true; return r ?? transform(e) })
        if (hit) return ['[]', [',', ...mapped]]
        return
      }
      const one = rewrite(payload)
      if (one) return ['[]', one]
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
      // Preserve `new` for native constructors the compiler resolves under its own
      // `new` handler (prepare/index.js): typed arrays/Array/RegExp need the `new`
      // form, and `new URL(rel, import.meta.url)` lowers to a static href string there.
      // User classes (lowered to factory arrows by jzify) become plain calls below.
      if (typeof name === 'string' && (TYPED_ARRAYS.has(name) || name === 'Array' || name === 'RegExp' || name === 'URL')) return ['new', transform(ctor), ...cargs.map(transform)]
      if (Array.isArray(ctor) && ctor[0] === '()') return transform(ctor)
      return ['()', transform(ctor), ...(cargs.length ? cargs.map(transform) : [null])]
    },

    'instanceof'(val, ctor) {
      // promise-shape probe — promises are fixed-shape objects, no ctor chain
      if (ctor === 'Promise' && _gen?.noteAsync) {
        _gen.noteAsync()
        const t0 = transform(val)
        return ['&&', ['!=', t0, [null, null]], ['==', ['.', t0, '__p'], [null, 1]]]
      }
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

    // The classic for-head `[';', init, cond, step]` is a fixed 3-slot structure,
    // NOT a statement sequence. Transform each slot individually and keep null slots
    // in place. Without this handler, `for` falls to the generic recurse, the head
    // hits the `;` handler (transformScope), and an empty `init` (null) is dropped as
    // an empty statement — shifting cond→init/step→cond and miscompiling the loop
    // (`for (; i < n; i++)` ran zero/garbage iterations). for-of/for-in heads aren't
    // `;`-lists, so they pass through transform unchanged.
    'for'(head, body) {
      // for-of over a KNOWN generator call → while-next desugar (the generator
      // object is plain closures + a fixed-shape result record).
      if (_gen && Array.isArray(head) && head[0] === 'of' &&
          Array.isArray(head[2]) && head[2][0] === '()' &&
          typeof head[2][1] === 'string' && _gen.generatorNames.has(head[2][1]))
        return transform(_gen.desugarForOfGenerator(head[1], transform(head[2]), body, names.genTemp))
      // for-of over an iterator-HELPER CHAIN rooted at a known generator call
      // → one fused while-next loop (map/filter/take/drop compose in place).
      if (_gen && Array.isArray(head) && head[0] === 'of' && Array.isArray(head[2])) {
        const chain = _gen.unwindChain(head[2])
        if (chain && chain.stages.length && chain.stages.every(st => !_gen.isTerminal(st.h))) {
          const name = Array.isArray(head[1]) ? head[1][1] : head[1]
          const bodyStmts = Array.isArray(body) && body[0] === ';' ? body.slice(1) : [body]
          const x = names.genTemp('gx')
          const fused = _gen.fusedLoop(chain.root, chain.stages, names.genTemp, x,
            () => [['let', ['=', name, x]], ...bodyStmts])
          return transform(fused)
        }
      }
      // 'of-idx' — the protocol fork's array arm: plain indexed for-of, no re-fork.
      if (Array.isArray(head) && head[0] === 'of-idx') {
        const t = transform(['of', head[1], head[2]])
        return ['for', t, transform(body)]
      }
      // for-of over an UNKNOWN source in an iterator-minting program → runtime
      // protocol fork (probe once, drive next() lazily, else indexed path).
      if (_gen && _gen.iterProto?.on && Array.isArray(head) && head[0] === 'of')
        return transform(_gen.desugarForOfProtocol(head[1], head[2], body, names.genTemp))
      if (Array.isArray(head) && head[0] === ';')
        return ['for', [';', ...head.slice(1).map(s => s == null ? s : transform(s))], transform(body)]
      return ['for', transform(head), transform(body)]
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
        // Route a named default-export function through the named-export path: a bare
        // `const NAME` lifted in a bundled module loses its recursive self-reference
        // (the default-alias resolver renames the func but not in-body call sites),
        // so the function is dropped. Exporting NAME as a named binding makes prepare
        // mangle it and resolve self-calls correctly; alias `default` to it.
        const decl = hoistFnDecl(inner[1][1], inner[1][2], inner[1][3])
        return [';', ['export', decl], ['export', ['{}', ['as', inner[1][1], 'default']]]]
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
