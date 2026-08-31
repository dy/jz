// Deterministic equal-shape direct-call graphs for allocation measurements.
// The requested count includes the exported root. Every function is reachable.

export function generateDirectCallGraph(count) {
  if (!Number.isInteger(count) || count < 2) throw new RangeError('graph function count must be an integer >= 2')
  const lines = new Array(count)
  lines[0] = 'let g0=x=>x+1'
  for (let i = 1; i < count - 1; i++) lines[i] = `let g${i}=x=>g${i - 1}(x)+1`
  lines[count - 1] = `export let run=x=>{x=+x;return g${count - 2}(x)}`
  return {
    source: lines.join(';'),
    exportName: 'run',
    args: [3],
    expected: count + 2,
    functionCount: count,
  }
}
