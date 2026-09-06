// Incremental baseline: hold all other working-tree changes/dependencies fixed.
// Use NODE_OPTIONS so fresh-child comparisons inherit the same compiler.
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const root = fileURLToPath(new URL('../../', import.meta.url))
const files = new Set(['module/core.js', 'src/kind/val-type-of.js', 'src/compile/emit/comparisons.js',
  'src/compile/representation-plan/body-data.js', 'src/compile/representation-plan/materialize.js'])
export async function load(url, context, next) {
  if (url.startsWith('file:')) {
    const path = fileURLToPath(url)
    if (path.startsWith(root) && files.has(path.slice(root.length)))
      return {format:'module', shortCircuit:true, source:execFileSync('git',
        ['show', '45868ec5:' + path.slice(root.length)], {cwd:root, encoding:'utf8'})}
  }
  return next(url, context)
}
