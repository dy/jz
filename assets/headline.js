// Shared headline statistics — the figures behind the landing hero (.mstats, the top three)
// and the bench page's stat strip, computed once from bench/results.json so the two
// can never drift. Returns formatted "N×" strings (null when a target is absent):
//   v8/porf/rust  geomean of target.medianUs / jz.medianUs over correct cases
//                 (rust = Rust→wasm — apples-to-apples, same V8 engine as jz)
//   asspeed       geomean of as.medianUs / jz.medianUs (jz vs AssemblyScript on speed)
//   peak          max V8/jz speedup (the best single-case SIMD win)
//   assize/porfsize  MEDIAN of jz.wasm / target.wasm bytes (apples-to-apples binary↔binary)
// Parity-DIFF runs (a target that produced the WRONG answer) are excluded — speed on a
// wrong result isn't a fair comparison (matters for Porffor, which miscompiles several).
export function headlineStats(results) {
  const cases = Object.values(results.cases || {})
  const geo = a => { let p = 1, n = 0; for (const x of a) if (x > 0 && isFinite(x)) { p *= x; n++ } return n ? Math.pow(p, 1 / n) : null }
  const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null }
  const f = (x, d = 1) => x == null ? null : x.toFixed(d).replace(/\.0$/, '') + '×'
  const ratio = tgt => { const a = []; for (const c of cases) { const t = c.targets; if (t.jz && t[tgt] && t[tgt].parity !== 'DIFF') a.push(t[tgt].medianUs / t.jz.medianUs) } return geo(a) }
  let peak = 0
  for (const c of cases) { const t = c.targets; if (t.jz && t.v8 && t.v8.parity !== 'DIFF') peak = Math.max(peak, t.v8.medianUs / t.jz.medianUs) }
  const sizeRatio = tgt => { const a = []; for (const c of cases) { const t = c.targets; if (t.jz?.bytes && t[tgt]?.bytes) a.push(t.jz.bytes / t[tgt].bytes) } return median(a) }
  return {
    v8: f(ratio('v8')), peak: f(peak || null), porf: f(ratio('porf')), rust: f(ratio('rust-wasm')),
    asspeed: f(ratio('as')),                 // jz vs AssemblyScript on speed (the hero's 3rd stat)
    assize: f(sizeRatio('as')), porfsize: f(sizeRatio('porf')),
  }
}
