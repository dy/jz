/**
 * jzify — Transform JS AST into jz-compatible form.
 *
 * Crockford-aligned: eliminates bad parts, enforces good practices.
 * Runs before prepare() as an AST→AST pass.
 *
 * @module jzify
 */

import { JZIFY_CLASS_ERRORS as JC } from '../src/op-policy.js'
import { parse } from '../src/parse.js'
import { createAsyncLowering, ASYNC_RUNTIME, ASYNC_GEN_RUNTIME } from './async.js'
import { USP_RUNTIME } from './webrt.js'
import { createNames } from './names.js'
import { foldStaticExportHelpers, foldStaticBundlerHelpers, canonicalizeObjectIdioms } from './bundler.js'
import { createSwitchLowering, normalizeCaseBody } from './switch.js'
import { createClassLowering, foldPseudoClassical } from './classes.js'
import { hoistVars, prependDecls } from './hoist-vars.js'
import { createArgumentsLowering } from './arguments.js'
import { createTransform, bindGenerators } from './transform.js'
import { createGeneratorLowering, ITER_HELPERS_RUNTIME, ITER_ARR_RUNTIME } from './generators.js'

const names = createNames()
const { lowerArguments, transformPattern, bindTransform } = createArgumentsLowering(names)

let lowerClass, lowerObjectLiteralThis, lowerArrayConstructor, transformSwitch
let transform, transformScope

;({ transform, transformScope } = createTransform({
  names,
  lowerArguments,
  transformPattern,
  normalizeCaseBody,
  transformSwitch: (...a) => transformSwitch(...a),
  lowerClass: () => lowerClass,
  lowerObjectLiteralThis: () => lowerObjectLiteralThis,
  lowerArrayConstructor: () => lowerArrayConstructor,
}))
bindTransform(transform)

const constStrings = new Map()
;({ lowerClass, lowerObjectLiteralThis, lowerArrayConstructor } = createClassLowering({ transform, names, JC, constStrings }))
const generatorNames = new Set()
// Program mints iterator objects (generators anywhere, hand-rolled `next()`
// members, `[Symbol.iterator]` methods) — gates the for-of protocol fork so
// programs without iterator producers compile byte-identically.
const iterProto = { on: false }
const genErr = (msg) => { throw new Error('jzify: ' + msg) }
const { lowerGenerator, desugarForOfGenerator, desugarForOfProtocol, unwindChain, fuseTerminal, fusedLoop, isTerminal } = createGeneratorLowering({ transform, err: genErr, generatorNames, genTemp: (t) => names.genTemp(t), iterProto })
const { lowerAsync, lowerAsyncGen, noteAsync, asyncUsed, agenUsed, resetAsync } = createAsyncLowering({ genTemp: (t) => names.genTemp(t), err: genErr })
// Web-runtime splice flags (URLSearchParams, …) — reset per transform run.
const webrt = { usp: false }
bindGenerators({ lowerGenerator, desugarForOfGenerator, desugarForOfProtocol, lowerAsync, lowerAsyncGen, noteAsync, generatorNames, iterProto, unwindChain, fuseTerminal, fusedLoop, isTerminal, webrt })
transformSwitch = createSwitchLowering(transform, names)

// Spread normalization for iterator values — injected only when a spread site
// wrapped in __drain (iterProto.drain). Arrays/strings/Sets/Maps pass through
// untouched (the existing spread machinery owns them); machines and
// @@iterator providers materialize.
const ITER_RUNTIME = `
let __it_drain = (v) => {
  if (v == null) return v
  if (typeof v === 'object' && v['@@iterator'] != null) v = v['@@iterator']()
  if (typeof v !== 'object' || v.next == null) return v
  let r = v.next(), a = []
  while (!r.done) { a.push(r.value); r = v.next() }
  return a
}
`

const isSymbolWellKnown = (n, which) => Array.isArray(n) && n[0] === '.' && n[1] === 'Symbol' && n[2] === which
const WELL_KNOWN = { iterator: '@@iterator', dispose: '@@dispose', asyncIterator: '@@asyncIterator' }
// Iterator-helper method names (ES2025) — a CALL of one of these on any
// receiver, in a program that mints iterators, gates decorated generator
// objects (__it_mk). Fusable chains still fuse; this covers value positions.
const ITER_HELPER_NAMES = new Set(['map', 'filter', 'take', 'drop', 'flatMap',
  'toArray', 'reduce', 'forEach', 'some', 'every', 'find'])
// Entry walk, two jobs in one pass:
// 1. Canonicalize well-known-symbol shapes to reserved literal props — a
//    fixed-shape object has no symbol slots, so `[Symbol.iterator]` becomes
//    the '@@iterator' prop in BOTH key position (computed member/method) and
//    access position (`x[Symbol.iterator]`).
// 2. Detect iterator producers for the protocol-fork gate, and helper-method
//    use / `instanceof Iterator` for the decorated-iterator gate.
function canonSymbols(node) {
  if (!Array.isArray(node)) return node
  const [op] = node
  if (op === 'function*') iterProto.on = true
  if (op === ':' && (node[1] === 'next' || node[1] === '@@iterator') &&
      Array.isArray(node[2]) && (node[2][0] === '=>' || node[2][0] === 'function' || node[2][0] === 'function*'))
    iterProto.on = true
  if (op === '()' && Array.isArray(node[1]) && node[1][0] === '.' && ITER_HELPER_NAMES.has(node[1][2]))
    iterProto.helpers = true
  if (op === 'instanceof' && node[2] === 'Iterator') iterProto.helpers = true
  // computed key: [':', ['[]', Symbol.X], value]
  if (op === ':' && Array.isArray(node[1]) && node[1][0] === '[]' && node[1].length === 2) {
    for (const [k, prop] of Object.entries(WELL_KNOWN))
      if (isSymbolWellKnown(node[1][1], k)) { node[1] = prop; if (prop === '@@iterator') iterProto.on = true }
  }
  // access: ['[]', obj, Symbol.X] → ['.', obj, '@@X']
  if (op === '[]' && node.length === 3) {
    for (const [k, prop] of Object.entries(WELL_KNOWN))
      if (isSymbolWellKnown(node[2], k)) { node[0] = '.'; node[2] = prop }
  }
  for (let i = 1; i < node.length; i++) canonSymbols(node[i])
  return node
}

/**
 * Transform AST in-place. Returns transformed AST.
 * @param {Array} ast - subscript/jessie parsed AST
 * @returns {Array} Transformed AST
 */
export default function jzify(ast) {
  names.reset()
  // Module-scope `const K = 'str'` bindings — lets class lowering fold computed
  // member names `[K]() {}` (const guarantees the binding never changes).
  constStrings.clear()
  generatorNames.clear()
  iterProto.on = false
  iterProto.helpers = false
  iterProto.helpersUsed = false
  iterProto.arr = false
  iterProto.fromUsed = false
  ast = canonSymbols(ast)
  if (Array.isArray(ast)) {
    const stmts = ast[0] === ';' ? ast.slice(1) : [ast]
    for (const st of stmts) {
      if (Array.isArray(st) && st[0] === 'function*' && typeof st[1] === 'string' && st[1]) generatorNames.add(st[1])
      if (Array.isArray(st) && st[0] === 'export' && Array.isArray(st[1]) && st[1][0] === 'function*' && st[1][1]) generatorNames.add(st[1][1])
      if (!Array.isArray(st) || st[0] !== 'const') continue
      for (let i = 1; i < st.length; i++) {
        const d = st[i]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' &&
            Array.isArray(d[2]) && d[2][0] == null && typeof d[2][1] === 'string')
          constStrings.set(d[1], d[2][1])
      }
    }
  }
  const hoisted = new Set()
  ast = hoistVars(ast, hoisted)
  if (hoisted.size) ast = prependDecls(ast, hoisted)
  if (Array.isArray(ast) && ast[0] === ';') ast = [';', ...foldPseudoClassical(ast.slice(1))]
  resetAsync()
  iterProto.drain = false
  webrt.usp = false
  let out = transformScope(ast)
  const prepend = (src) => {
    // runtimes ride the same well-known-symbol canonicalization as user code
    // ([Symbol.iterator] → '@@iterator' in key/access/assign positions) — the
    // dot-canonical form keeps writes and prehashed dot-reads on ONE path.
    const rt = transformScope(canonSymbols(parse(src)))
    const rtStmts = Array.isArray(rt) && rt[0] === ';' ? rt.slice(1) : [rt]
    const outStmts = Array.isArray(out) && out[0] === ';' ? out.slice(1) : [out]
    out = [';', ...rtStmts, ...outStmts]
  }
  // Runtime splices, to QUIESCENCE: each prepended runtime is itself
  // transformed, and that transform can flag a need whose check has already
  // passed in a single linear chain — ASYNC_RUNTIME's `__p_try` holds
  // `fn(...aa)`, which wraps to `fn(...__it_drain(aa))`, so a linear chain
  // left `__it_drain` a free name (→ `local.get` of an undeclared local in
  // `$__p_try`). Loop until no runtime is newly needed; each splices once.
  // First pass preserves the historical order exactly:
  //  - spread-of-iterator sites wrapped in __drain → ITER_RUNTIME
  //    (pass-through for arrays/strings; materializes machines/providers).
  //  - Array.from-over-iterators sites → __it_arr (materialize/copy).
  //  - helper-bearing generator mints (__it_mk) or literal-receiver
  //    [Symbol.iterator]() mints (__it_from) → decorated-iterator factory.
  //  - URLSearchParams sites → the jz-source implementation (webrt.js).
  //  - async generators → tagged-yield driver, checked BEFORE the promise
  //    runtime so it lands AFTER it in module order (it calls __p_*).
  //  - async anywhere → the plain-jz promise runtime (microtask queue,
  //    __async_run driver, promise shape + boundary readers) ahead of user
  //    code. Sync programs never reach this — byte-identical.
  const spliced = {}
  const spliceOnce = () => {
    let did = false
    const need = (key, cond, src) => {
      if (!cond || spliced[key]) return
      spliced[key] = did = true
      prepend(src)
    }
    need('drain', iterProto.drain, ITER_RUNTIME)
    need('arr', iterProto.arr, ITER_ARR_RUNTIME)
    need('helpers', iterProto.helpersUsed || iterProto.fromUsed, ITER_HELPERS_RUNTIME)
    need('usp', webrt.usp, USP_RUNTIME)
    need('agen', agenUsed(), ASYNC_GEN_RUNTIME)
    need('async', asyncUsed(), ASYNC_RUNTIME)
    return did
  }
  while (spliceOnce()) {}
  return foldStaticBundlerHelpers(foldStaticExportHelpers(canonicalizeObjectIdioms(out)))
}
