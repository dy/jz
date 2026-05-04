/** Pre-emit compile planning: collect facts, resolve ABIs, and run narrowing. */

import { ctx } from './ctx.js'
import { VAL, valTypeOf, typedElemCtor, typedElemAux, updateGlobalRep, collectProgramFacts } from './analyze.js'
import { MAX_CLOSURE_ARITY } from './ir.js'
import narrowSignatures, { specializeBimorphicTyped, refineDynKeys } from './narrow.js'

const scanGlobalValueFacts = (root) => {
  if (!root) return
  const stmts = Array.isArray(root) && root[0] === ';' ? root.slice(1) : [root]
  for (const stmt of stmts) {
    if (!Array.isArray(stmt) || (stmt[0] !== 'const' && stmt[0] !== 'let')) continue
    for (const decl of stmt.slice(1)) {
      if (!Array.isArray(decl) || decl[0] !== '=' || typeof decl[1] !== 'string') continue
      const vt = valTypeOf(decl[2])
      if (vt) {
        if (!ctx.scope.globalValTypes) ctx.scope.globalValTypes = new Map()
        ctx.scope.globalValTypes.set(decl[1], vt)
        if (vt === VAL.REGEX && ctx.runtime.regex) ctx.runtime.regex.vars.set(decl[1], decl[2])
      }
      const ctor = typedElemCtor(decl[2])
      if (ctor) {
        if (!ctx.scope.globalTypedElem) ctx.scope.globalTypedElem = new Map()
        ctx.scope.globalTypedElem.set(decl[1], ctor)
      }
    }
  }
}

const unboxConstTypedGlobals = () => {
  if (!ctx.scope.globalTypedElem || !ctx.scope.consts) return
  for (const [name, ctor] of ctx.scope.globalTypedElem) {
    if (!ctx.scope.consts.has(name)) continue
    if (ctx.scope.globalValTypes?.get(name) !== VAL.TYPED) continue
    const aux = typedElemAux(ctor)
    if (aux == null) continue
    const decl = ctx.scope.globals.get(name)
    if (typeof decl !== 'string' || !decl.includes('mut f64')) continue
    ctx.scope.globals.set(name, `(global $${name} (mut i32) (i32.const 0))`)
    ctx.scope.globalTypes.set(name, 'i32')
    updateGlobalRep(name, { ptrKind: VAL.TYPED, ptrAux: aux })
  }
}

const materializeAutoBoxSchemas = (programFacts) => {
  if (!ctx.schema.register) return
  for (const [name, props] of programFacts.propMap) {
    if (ctx.schema.vars.has(name)) {
      const existing = ctx.schema.resolve(name)
      const newProps = [...props].filter(prop => !existing.includes(prop))
      if (newProps.length) {
        const merged = [...existing, ...newProps]
        const mergedId = ctx.schema.register(merged)
        ctx.schema.vars.set(name, mergedId)
      }
      continue
    }
    const valueProps = [...props].filter(prop => !ctx.func.names.has(`${name}$${prop}`))
    if (!valueProps.length) continue
    const allProps = [...props]
    const schema = ['__inner__', ...allProps]
    const schemaId = ctx.schema.register(schema)
    ctx.schema.vars.set(name, schemaId)
    if (ctx.func.names.has(name) && !ctx.scope.globals.has(name))
      ctx.scope.globals.set(name, `(global $${name} (mut f64) (f64.const 0))`)
    if (!ctx.schema.autoBox) ctx.schema.autoBox = new Map()
    ctx.schema.autoBox.set(name, { schemaId, schema })
  }
}

const resolveClosureWidth = (programFacts) => {
  if (!ctx.closure.make) return
  const { hasSpread, hasRest, maxCall, maxDef } = programFacts
  const floor = ctx.closure.floor ?? 0
  ctx.closure.width = (hasSpread && hasRest)
    ? MAX_CLOSURE_ARITY
    : Math.min(MAX_CLOSURE_ARITY, Math.max(maxCall, maxDef + (hasRest ? 1 : 0), floor))
}

const canSkipWholeProgramNarrowing = (programFacts) =>
  programFacts.callSites.length === 0 &&
  programFacts.valueUsed.size === 0 &&
  !programFacts.anyDyn &&
  programFacts.propMap.size === 0 &&
  !programFacts.hasSchemaLiterals &&
  !ctx.closure.make

export default function plan(ast) {
  scanGlobalValueFacts(ast)
  unboxConstTypedGlobals()

  const programFacts = collectProgramFacts(ast)
  ctx.types.dynKeyVars = programFacts.dynVars
  ctx.types.anyDynKey = programFacts.anyDyn

  materializeAutoBoxSchemas(programFacts)
  resolveClosureWidth(programFacts)
  if (canSkipWholeProgramNarrowing(programFacts)) return programFacts

  narrowSignatures(programFacts, ast)
  specializeBimorphicTyped(programFacts)
  refineDynKeys(programFacts)

  return programFacts
}