// Named test-only compiler mutants (test/_mutant.mjs applies one as Node loads
// the module; test/reachability-mutants.js runs the reachability suite under
// each and requires the outcome below). Each is one edit of one module,
// applied with test/_self-overlay.js's rule: the find occurs exactly once.
export const MUTANTS = {
  // A required root lost: only the syntactic inline export roots a function, so
  // `export { f as g }`, `export default f` and a re-exported entry lose theirs.
  'root-export-alias': {
    outcome: 'fail',
    edits: { 'src/compile/program-index.js': [[
      'if (id >= 0 && isExported(func) && !rootSeen[id]) { rootSeen[id] = true; rootIds.push(id) }',
      'if (id >= 0 && func.exported && !rootSeen[id]) { rootSeen[id] = true; rootIds.push(id) }',
    ]] },
  },
  // A required edge lost: a call made inside an arrow body is not a call site of
  // the function enclosing it, so a callee reached only from a closure has no edge.
  'edge-closure-call': {
    outcome: 'fail',
    edits: { 'src/compile/program-facts/walk-facts.js': [[
      'acc.callSites.push({ callee: node[1], argList, callerFunc: caller, node })',
      'if (!inArrow) acc.callSites.push({ callee: node[1], argList, callerFunc: caller, node })',
    ]] },
  },
}
