/**
 * jzify — Transform JS AST into jz-compatible form.
 *
 * Crockford-aligned: eliminates bad parts, enforces good practices.
 * Runs before prepare() as an AST→AST pass.
 *
 * @module jzify
 */

import { JZIFY_CLASS_ERRORS as JC } from '../src/op-policy.js'
import { createNames } from './names.js'
import { foldStaticExportHelpers, foldStaticBundlerHelpers, canonicalizeObjectIdioms } from './bundler.js'
import { createSwitchLowering, normalizeCaseBody } from './switch.js'
import { createClassLowering } from './classes.js'
import { hoistVars, prependDecls } from './hoist-vars.js'
import { createArgumentsLowering } from './arguments.js'
import { createTransform, bindGenerators } from './transform.js'
import { createGeneratorLowering } from './generators.js'

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
const genErr = (msg) => { throw new Error('jzify: ' + msg) }
const { lowerGenerator, desugarForOfGenerator, unwindChain, fuseTerminal, fusedLoop, isTerminal } = createGeneratorLowering({ transform, err: genErr, generatorNames, genTemp: (t) => names.genTemp(t) })
bindGenerators({ lowerGenerator, desugarForOfGenerator, generatorNames, unwindChain, fuseTerminal, fusedLoop, isTerminal })
transformSwitch = createSwitchLowering(transform, names)

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
  return foldStaticBundlerHelpers(foldStaticExportHelpers(canonicalizeObjectIdioms(transformScope(ast))))
}
