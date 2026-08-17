// Standalone watr-optimize wasm entry for the codegen differential (.work
// scratch — see .work/todo.md shaped-parser hunt). WAT text + pass list JSON →
// optimized WAT text. Mirrors the jzify-diff harness that cracked the
// generator-machine class: node-watr vs jz-compiled-watr, diffed per pass.
import { optimize, resetNameUids } from 'watr/optimize'
import print from 'watr/print'
import parse from 'watr/parse'

export default (wat, passesJSON) => {
  resetNameUids()
  const tree = parse(wat)
  const passes = passesJSON ? JSON.parse(passesJSON) : undefined
  // string → watr's selective pass-string form; array → { passes };
  // plain object → full watr opts (profile/ifset/licm/guard…); else default
  const o = typeof passes === 'string' ? passes
    : Array.isArray(passes) ? { passes }
    : passes || undefined
  return print(optimize(tree, o))
}
