/**
 * Generic IR feature probe — "does this subtree contain opcode X". It scans a
 * WAT-as-array subtree without assuming a tree (optimizer nodes may share large
 * subgraphs via CSE) and serves several otherwise-unrelated pass families.
 *
 * @module optimize/ir-scan
 */
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
