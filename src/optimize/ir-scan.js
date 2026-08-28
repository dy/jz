/**
 * Generic IR feature probes — "does this subtree contain opcode/shape X".
 * Both linear-scan a WAT-as-array subtree without assuming a tree (optimizer
 * nodes may share large subgraphs via CSE), and are consumed by several
 * otherwise-unrelated pass families (locals, peephole, globals), so they live
 * here rather than inside any one of them.
 *
 * @module optimize/ir-scan
 */
import { walkAst } from '../ast.js'

export const containsV128 = node => {
  let found = false
  walkAst(node, { enter: n => {
    if (found || !Array.isArray(n)) return false
    const op = n[0]
    if (typeof op === 'string' && (op.startsWith('v128.') || /^[if]\d+x\d+\./.test(op))) { found = true; return false }
  } })
  return found
}

// IR is usually a tree but optimizer nodes may share large subgraphs. Keep
// feature probes linear rather than recursively revisiting a shared DAG.
export function hasIROp(roots, opcode) {
  const stack = Array.isArray(roots) ? [...roots] : [roots], seen = new Set()
  while (stack.length) {
    const node = stack.pop()
    if (!Array.isArray(node) || seen.has(node)) continue
    seen.add(node)
    if (node[0] === opcode) return true
    for (let i = 1; i < node.length; i++) if (Array.isArray(node[i])) stack.push(node[i])
  }
  return false
}
