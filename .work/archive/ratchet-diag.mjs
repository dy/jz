import jz from '../index.js'
import { CATEGORIES, genProgram } from '../scripts/perf-corpus.mjs'
import parseWat from 'watr/parse'

const loopBodyOps = (wat) => {
  let count = 0
  const walk = (n, inLoop) => {
    if (!Array.isArray(n)) return
    const here = inLoop || n[0] === 'loop'
    if (here && typeof n[0] === 'string') count++
    for (let i = 1; i < n.length; i++) walk(n[i], here)
  }
  walk(parseWat(wat), false)
  return count
}

for (const cat of ['ring', 'fgather']) {
  let sum = 0, worst = null, worstDelta = -1
  for (let s = 1; s <= 40; s++) {
    try {
      const wat = jz.compile(genProgram(cat, s), { optimize: 2, wat: true })
      const n = loopBodyOps(wat)
      sum += n
      if (n > worstDelta) { worstDelta = n; worst = s }
    } catch {}
  }
  console.log(cat, 'total', sum, 'worst seed', worst, 'ops', worstDelta)
}
