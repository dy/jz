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
// The LAB set — jz-internal probe cases: the self-host compiler rows (jz/watr/
// jessie compiling code) and the JS-only intrinsic probes (color* — pow/cbrt/
// exp2/atan2 gap trackers with no cross-language ports). They answer jz-internal
// questions, not the cross-language comparison, so every aggregate excludes them.
// The ONE definition, shared by every consumer: bench/bench.mjs (geomean SVG +
// web emit), bench/index.html (page corpus + `lab` chip), scripts/bench-readme.mjs
// (README aggregate table), and headlineStats below (hero + strip).
export const LAB = new Set(['watr', 'jessie', 'jz', 'colorconv', 'colorlch', 'colorlog', 'colorpq', 'deltae'])

export function headlineStats(results) {
  const cases = Object.entries(results.cases || {}).filter(([id]) => !LAB.has(id)).map(([, c]) => c)
  const geo = a => { let p = 1, n = 0; for (const x of a) if (x > 0 && isFinite(x)) { p *= x; n++ } return n ? Math.pow(p, 1 / n) : null }
  const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null }
  const f = (x, d = 1) => x == null ? null : x.toFixed(d).replace(/\.0$/, '') + '×'
  // A target row counts only when it actually ran (a self-host row can carry a
  // valid v8 but a failed jz — `medianUs` undefined — which would poison the math).
  const ran = x => x && x.status !== 'fail' && isFinite(x.medianUs)
  const ratio = tgt => { const a = []; for (const c of cases) { const t = c.targets; if (ran(t.jz) && ran(t[tgt]) && t[tgt].parity !== 'DIFF') a.push(t[tgt].medianUs / t.jz.medianUs) } return geo(a) }
  let peak = 0
  for (const c of cases) { const t = c.targets; if (ran(t.jz) && ran(t.v8) && t.v8.parity !== 'DIFF') peak = Math.max(peak, t.v8.medianUs / t.jz.medianUs) }
  const sizeRatio = tgt => { const a = []; for (const c of cases) { const t = c.targets; if (t.jz?.bytes && t[tgt]?.bytes) a.push(t.jz.bytes / t[tgt].bytes) } return median(a) }
  return {
    v8: f(ratio('v8')), peak: f(peak || null), porf: f(ratio('porf')), rust: f(ratio('rust-wasm')),
    jsc: f(ratio('jsc')),                    // jz vs JavaScriptCore (Safari's engine)
    cwasm: f(ratio('c-wasm')),               // jz vs C → wasm (same V8)
    nat: f(ratio('nat'), 2),                 // jz vs native C (clang -O3) — the native ceiling (≈ parity)
    rustnat: f(ratio('rust'), 2),            // jz vs native Rust (rustc -O) — same native-parity story (the hero's 3rd stat)
    asspeed: f(ratio('as')),                 // jz vs AssemblyScript on speed
    assize: f(sizeRatio('as')), porfsize: f(sizeRatio('porf')),
  }
}

// The substrate-class glyphs (JS / WASM / native), shared by the bench strip, the bench
// rows, and the landing hero, so a class reads the same mark everywhere. Coloured through
// .cico.cls-* in CSS (currentColor; native adds a themed --cls-native-bg square behind the
// prompt). Lives here — the one module both pages already import.
export const CLS_ICO = {
  js: `<svg class="cico cls-js" viewBox="0 0 24 24" aria-hidden="true"><title>JS</title><path fill="currentColor" d="M0 0h24v24H0V0zm22.034 18.276c-.175-1.095-.888-2.015-3.003-2.873-.736-.345-1.554-.585-1.797-1.14-.091-.33-.105-.51-.046-.705.15-.646.915-.84 1.515-.66.39.12.75.42.976.9 1.034-.676 1.034-.676 1.755-1.125-.27-.42-.404-.601-.586-.78-.63-.705-1.469-1.065-2.834-1.034l-.705.089c-.676.165-1.32.525-1.71 1.005-1.14 1.291-.811 3.541.569 4.471 1.365 1.02 3.361 1.244 3.616 2.205.24 1.17-.87 1.545-1.966 1.41-.811-.18-1.26-.586-1.755-1.336l-1.83 1.051c.21.48.45.689.81 1.109 1.74 1.756 6.09 1.666 6.871-1.004.029-.09.24-.705.074-1.65l.046.067zm-8.983-7.245h-2.248c0 1.938-.009 3.864-.009 5.805 0 1.232.063 2.363-.138 2.711-.33.689-1.18.601-1.566.48-.396-.196-.597-.466-.83-.855-.063-.105-.11-.196-.127-.196l-1.825 1.125c.305.63.75 1.172 1.324 1.517.855.51 2.004.675 3.207.405.783-.226 1.458-.691 1.811-1.411.51-.93.402-2.07.397-3.346.012-2.054 0-4.109 0-6.179l.004-.056z"/></svg>`,
  wasm: `<svg class="cico cls-wasm" viewBox="0 0 24 24" aria-hidden="true"><title>WASM</title><path fill="currentColor" d="M14.745,0c0,0.042,0,0.085,0,0.129c0,1.52-1.232,2.752-2.752,2.752c-1.52,0-2.752-1.232-2.752-2.752 c0-0.045,0-0.087,0-0.129H0v24h24V0H14.745z M11.454,21.431l-1.169-5.783h-0.02l-1.264,5.783H7.39l-1.824-8.497h1.59l1.088,5.783 h0.02l1.311-5.783h1.487l1.177,5.854h0.02l1.242-5.854h1.561l-2.027,8.497H11.454z M20.209,21.431l-0.542-1.891h-2.861l-0.417,1.891 h-1.59l2.056-8.497h2.509l2.5,8.497H20.209z M17.812,15.028l-0.694,3.118h2.159l-0.796-3.118H17.812z"/></svg>`,
  // native = a terminal: dark square (the --cls-native-bg block, transparent in dark so the
  // glyph stays a bare >_ as before) with a light >_ prompt — a sharp square silhouette that
  // sits with the JS/WASM brand squares instead of floating apart.
  native: `<svg class="cico cls-native" viewBox="0 0 24 24" aria-hidden="true"><title>native</title><rect class="term-bg" width="24" height="24"/><path fill="none" stroke="currentColor" stroke-width="2.6" d="M5 18.735l4.134-4.134-4.134-4.134"/><path fill="none" stroke="currentColor" stroke-width="2.2" d="M11.124 19.5h8.124"/></svg>`,
}
