// Loop codegen helpers - unified iteration patterns
import { ctx } from './compile.js'
import { wat } from './types.js'

// Resolve placeholders: {idx}, {len}, {$name}, {=name val}, {id}
const resolver = (prefix, id) => str => str
  .replace(/\{idx\}/g, `(local.get $_${prefix}_i_${id})`)
  .replace(/\{len\}/g, `(local.get $_${prefix}_len_${id})`)
  .replace(/\{\$(\w+)\}/g, (_, n) => `(local.get $_${prefix}_${n}_${id})`)
  .replace(/\{=(\w+)\s+([^}]+)\}/g, (_, n, v) => `(local.set $_${prefix}_${n}_${id} ${v})`)
  .replace(/\{id\}/g, String(id))

const addLocals = (prefix, id, locals) => {
  ctx.addLocal(`_${prefix}_i_${id}`, 'i32')
  ctx.addLocal(`_${prefix}_len_${id}`, 'i32')
  for (const loc of locals) {
    const [name, type] = loc.split(':')
    ctx.addLocal(`_${prefix}_${name}_${id}`, type)
  }
}

/** Forward loop: init → while(idx < len) { body; idx++ } → result */
export const genLoop = (prefix, { locals = [], init = '', body, result, type, schema }) => {
  const id = ctx.loopCounter++, r = resolver(prefix, id)
  addLocals(prefix, id, locals)
  return wat(`${r(init)}
    (local.set $_${prefix}_i_${id} (i32.const 0))
    (block $done_${id} (loop $loop_${id}
      (br_if $done_${id} (i32.ge_s (local.get $_${prefix}_i_${id}) (local.get $_${prefix}_len_${id})))
      ${r(body)}
      (local.set $_${prefix}_i_${id} (i32.add (local.get $_${prefix}_i_${id}) (i32.const 1)))
      (br $loop_${id})))
    ${r(result)}`, type, schema)
}

/** Early-exit loop: for find/indexOf/every/some - breaks on test match */
export const genEarlyExitLoop = (prefix, { locals = [], init = '', preTest = '', test, found, notFound, type }) => {
  const id = ctx.loopCounter++, r = resolver(prefix, id)
  addLocals(prefix, id, locals)
  return wat(`${r(init)}
    (local.set $_${prefix}_i_${id} (i32.const 0))
    (block $found_${id} (result ${type})
      (block $done_${id}
        (loop $loop_${id}
          (br_if $done_${id} (i32.ge_s (local.get $_${prefix}_i_${id}) (local.get $_${prefix}_len_${id})))
          ${preTest ? r(preTest) : ''}
          (if ${r(test)} (then (br $found_${id} ${r(found)})))
          (local.set $_${prefix}_i_${id} (i32.add (local.get $_${prefix}_i_${id}) (i32.const 1)))
          (br $loop_${id})))
      ${r(notFound)})`, type)
}
