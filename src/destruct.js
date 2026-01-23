/**
 * Destructuring code generation for jz compiler
 *
 * Handles all destructuring patterns:
 * - Array: [a, b], [a, [b, c]], [a = 10], [a, ...rest]
 * - Object: {a, b}, {a = 5}, {a: x}, {a, ...rest}
 *
 * @module destruct
 */

import { PTR_TYPE, wat, f64, i32 } from './types.js'

/**
 * Generate array destructuring for declarations (let/const).
 * Handles: simple [a, b], nested [a, [b, c]], defaults [a = 10], rest [a, ...rest]
 *
 * @param {object} ctx - Compilation context
 * @param {function} gen - AST generator function
 * @param {any[]} pattern - Destructuring pattern AST
 * @param {any} valueAst - Right-hand side value AST
 * @param {boolean} isConst - Whether declaration is const
 * @param {string|null} srcLocal - Source local if already loaded (for nested)
 * @param {boolean} isNested - Whether this is a nested destructuring
 * @returns {object|{code: string, lastVar: string}} Typed WAT value or nested result
 */
export function genArrayDestructDecl(ctx, gen, pattern, valueAst, isConst, srcLocal = null, isNested = false) {
  ctx.usedArrayType = true
  ctx.usedMemory = true

  const elems = Array.isArray(pattern[1]) && pattern[1][0] === ','
    ? pattern[1].slice(1)
    : (pattern[1] != null ? [pattern[1]] : [])

  // Parse each element: { name, default, isRest, isNested, nestedPattern }
  const parsed = []
  let restVar = null
  for (let i = 0; i < elems.length; i++) {
    const e = elems[i]
    if (e == null) continue

    if (Array.isArray(e) && e[0] === '...') {
      restVar = { name: e[1], idx: i }
      ctx.declareVar(e[1], isConst)
      ctx.addLocal(e[1], 'array')
    } else if (Array.isArray(e) && e[0] === '=') {
      const varName = e[1]
      const defaultVal = e[2]
      ctx.declareVar(varName, isConst)
      ctx.addLocal(varName, 'f64')
      parsed.push({ name: varName, default: defaultVal, idx: i })
    } else if (Array.isArray(e) && e[0] === '[]') {
      parsed.push({ isNestedPattern: true, nestedPattern: e, idx: i })
    } else if (typeof e === 'string') {
      ctx.declareVar(e, isConst)
      ctx.addLocal(e, 'f64')
      parsed.push({ name: e, idx: i })
    }
  }

  const id = ctx.uniqueId++
  const tmp = `$_destruct_${id}`
  ctx.addLocal(tmp, 'array')

  let code = ''
  if (srcLocal) {
    code += `(local.set ${tmp} (local.get ${srcLocal}))\n    `
  } else {
    const aw = gen(valueAst)
    code += `(local.set ${tmp} ${aw})\n    `
  }

  const lenTmp = `$_dlen_${id}`
  ctx.addLocal(lenTmp, 'i32')
  code += `(local.set ${lenTmp} (call $__ptr_len (local.get ${tmp})))\n    `

  let lastAssigned = null

  for (const p of parsed) {
    if (p.isNestedPattern) {
      const nestedTmp = `$_nested_${id}_${p.idx}`
      ctx.addLocal(nestedTmp, 'array')
      code += `(local.set ${nestedTmp} (f64.load (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${p.idx * 8}))))\n    `
      const nestedResult = genArrayDestructDecl(ctx, gen, p.nestedPattern, null, isConst, nestedTmp, true)
      code += nestedResult.code + '\n    '
      lastAssigned = nestedResult.lastVar
    } else {
      const info = ctx.getLocal(p.name)
      if (p.default) {
        const defaultWat = f64(gen(p.default))
        code += `(local.set $${info.scopedName} (if (result f64) (i32.gt_s (local.get ${lenTmp}) (i32.const ${p.idx})) (then (f64.load (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${p.idx * 8})))) (else ${defaultWat})))\n    `
      } else {
        code += `(local.set $${info.scopedName} (f64.load (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${p.idx * 8}))))\n    `
      }
      lastAssigned = p.name
    }
  }

  // Handle rest element
  if (restVar) {
    const info = ctx.getLocal(restVar.name)
    const restLenTmp = `$_rlen_${id}`
    ctx.addLocal(restLenTmp, 'i32')
    code += `(local.set ${restLenTmp} (i32.sub (local.get ${lenTmp}) (i32.const ${restVar.idx})))\n    `
    code += `(local.set ${restLenTmp} (select (local.get ${restLenTmp}) (i32.const 0) (i32.gt_s (local.get ${restLenTmp}) (i32.const 0))))\n    `
    code += `(local.set $${info.scopedName} (call $__alloc (i32.const 1) (local.get ${restLenTmp})))\n    `
    const iVar = `$_ri_${id}`
    ctx.addLocal(iVar, 'i32')
    code += `(local.set ${iVar} (i32.const 0))
    (block $rest_done (loop $rest_loop
      (br_if $rest_done (i32.ge_s (local.get ${iVar}) (local.get ${restLenTmp})))
      (f64.store
        (i32.add (call $__ptr_offset (local.get $${info.scopedName})) (i32.shl (local.get ${iVar}) (i32.const 3)))
        (f64.load (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.shl (i32.add (local.get ${iVar}) (i32.const ${restVar.idx})) (i32.const 3)))))
      (local.set ${iVar} (i32.add (local.get ${iVar}) (i32.const 1)))
      (br $rest_loop)))
    `
    lastAssigned = restVar.name
  }

  const lastVar = lastAssigned || (restVar ? restVar.name : (parsed.length > 0 ? (parsed[parsed.length - 1].name || null) : null))

  if (isNested) {
    return { code, lastVar }
  }

  if (lastVar) {
    const lastInfo = ctx.getLocal(lastVar)
    return wat(code + `(local.get $${lastInfo.scopedName})`, lastInfo.type || 'f64')
  }
  return wat(code + '(f64.const 0)', 'f64')
}

/**
 * Generate object destructuring for declarations (let/const).
 * Handles: simple {a, b}, defaults {a, b = 5}, rename {a: x}, rest {a, ...rest}
 *
 * @param {object} ctx - Compilation context
 * @param {function} gen - AST generator function
 * @param {any[]} pattern - Destructuring pattern AST
 * @param {any} valueAst - Right-hand side value AST
 * @param {boolean} isConst - Whether declaration is const
 * @returns {object} Typed WAT value
 */
export function genObjectDestructDecl(ctx, gen, pattern, valueAst, isConst) {
  ctx.usedArrayType = true
  ctx.usedMemory = true

  const props = Array.isArray(pattern[1]) && pattern[1][0] === ','
    ? pattern[1].slice(1)
    : (pattern[1] != null ? [pattern[1]] : [])

  const parsed = []
  let restVar = null
  const usedProps = new Set()

  for (const p of props) {
    if (p == null) continue

    if (Array.isArray(p) && p[0] === '...') {
      restVar = p[1]
      ctx.declareVar(restVar, isConst)
      ctx.addLocal(restVar, 'object')
    } else if (Array.isArray(p) && p[0] === '=') {
      const varName = p[1]
      ctx.declareVar(varName, isConst)
      ctx.addLocal(varName, 'f64')
      parsed.push({ propName: varName, varName, default: p[2] })
      usedProps.add(varName)
    } else if (Array.isArray(p) && p[0] === ':') {
      const propName = p[1]
      const varName = p[2]
      ctx.declareVar(varName, isConst)
      ctx.addLocal(varName, 'f64')
      parsed.push({ propName, varName })
      usedProps.add(propName)
    } else if (typeof p === 'string') {
      ctx.declareVar(p, isConst)
      ctx.addLocal(p, 'f64')
      parsed.push({ propName: p, varName: p })
      usedProps.add(p)
    }
  }

  const id = ctx.uniqueId++
  const tmp = `$_destruct_${id}`
  ctx.addLocal(tmp, 'object')
  const obj = gen(valueAst)

  const schema = (obj.type === 'object' && obj.schema !== undefined)
    ? ctx.objectSchemas[obj.schema]
    : []

  let code = `(local.set ${tmp} ${obj})\n    `

  for (const p of parsed) {
    const info = ctx.getLocal(p.varName)
    const idx = schema.indexOf(p.propName)

    if (p.default) {
      if (idx >= 0) {
        const defaultWat = f64(gen(p.default))
        const loadExpr = `(f64.load (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${idx * 8})))`
        code += `(local.set $${info.scopedName} (if (result f64) (f64.eq ${loadExpr} (f64.const 0)) (then ${defaultWat}) (else ${loadExpr})))\n    `
      } else {
        const defaultWat = f64(gen(p.default))
        code += `(local.set $${info.scopedName} ${defaultWat})\n    `
      }
    } else {
      if (idx >= 0) {
        code += `(local.set $${info.scopedName} (f64.load (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${idx * 8}))))\n    `
      } else {
        code += `(local.set $${info.scopedName} (f64.const 0))\n    `
      }
    }
  }

  // Handle object rest: {...rest}
  if (restVar) {
    const info = ctx.getLocal(restVar)
    const restProps = schema.filter(p => !usedProps.has(p))
    if (restProps.length > 0) {
      // Create new schema for rest object
      const restSchemaId = ctx.objectCounter + 1
      ctx.objectCounter++
      ctx.objectSchemas[restSchemaId] = restProps

      // Allocate and copy remaining properties
      code += `(local.set $${info.scopedName} (call $__alloc (i32.const ${PTR_TYPE.OBJECT}) (i32.const ${restProps.length})))\n    `
      code += `(local.set $${info.scopedName} (call $__ptr_with_id (local.get $${info.scopedName}) (i32.const ${restSchemaId})))\n    `
      for (let i = 0; i < restProps.length; i++) {
        const srcIdx = schema.indexOf(restProps[i])
        code += `(f64.store (i32.add (call $__ptr_offset (local.get $${info.scopedName})) (i32.const ${i * 8})) (f64.load (i32.add (call $__ptr_offset (local.get ${tmp})) (i32.const ${srcIdx * 8}))))\n    `
      }
      // Update type info for rest variable
      info.type = 'object'
      info.schema = restSchemaId
    } else {
      // No remaining properties - create empty object
      const restSchemaId = ctx.objectCounter + 1
      ctx.objectCounter++
      ctx.objectSchemas[restSchemaId] = []
      code += `(local.set $${info.scopedName} (call $__alloc (i32.const ${PTR_TYPE.OBJECT}) (i32.const 0)))\n    `
      code += `(local.set $${info.scopedName} (call $__ptr_with_id (local.get $${info.scopedName}) (i32.const ${restSchemaId})))\n    `
    }
  }

  const lastVar = restVar || (parsed.length > 0 ? parsed[parsed.length - 1].varName : null)
  if (lastVar) {
    const lastInfo = ctx.getLocal(lastVar)
    return wat(code + `(local.get $${lastInfo.scopedName})`, lastInfo.type || 'f64')
  }
  return wat(code + '(f64.const 0)', 'f64')
}
