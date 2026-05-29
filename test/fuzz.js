// Differential FUZZER — generative correctness oracle for the compiler.
//
// `differential.js` pins 13 hand-written programs; this file SYNTHESIZES random
// programs from the jz subset, runs each one two ways — as plain JavaScript
// (ground truth, since "valid jz = valid JS") and as jz-compiled WASM at every
// optimize level — and asserts the results agree. A disagreement is a miscompile;
// the run is deterministic (seeded) and self-shrinks the failing program to a
// minimal reproducer.
//
// Scope = the bit-exact numeric core: arithmetic, bitwise, comparisons, ternary,
// let/assignment, if/else, bounded while loops, and the Math.* fns that are
// IEEE-identical between wasm f64 and JS f64 (floor/ceil/round/trunc/abs/sqrt/
// min/max/imul). Transcendental Math.* and fractional `**` are excluded — their
// last-ULP differences are not jz bugs. Strings/objects/arrays are future work
// (the generator is feature-gated so they can be added without touching the loop).
//
// Run modes:
//   node test/fuzz.js                      exploratory: 2000 random programs
//   node test/fuzz.js --count=20000        longer sweep
//   node test/fuzz.js --seed=12345         reproduce/diagnose one program (verbose)
//   node test/fuzz.js --opt=0,2 --inputs=40
//   npm test                               the seeded gate below (deterministic)
//
// @module test/fuzz
import test from 'tst'
import { ok } from 'tst/assert.js'
import jz from '../index.js'

// ─────────────────────────────────────────────────────────────────────────────
// PRNG — explicit LCG so every program + input vector reproduces from its seed.
// ─────────────────────────────────────────────────────────────────────────────
const mkRng = (seed) => {
  let s = seed >>> 0
  const r = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296
  r.int = (n) => (r() * n) | 0
  r.pick = (arr) => arr[r.int(arr.length)]
  r.chance = (p) => r() < p
  return r
}

// ─────────────────────────────────────────────────────────────────────────────
// Generator — builds a small AST of plain tagged objects. Every expression is
// numeric; the serializer fully parenthesizes, so generation never reasons about
// precedence and the shrinker can swap any subtree freely.
// ─────────────────────────────────────────────────────────────────────────────
const ARITH = ['+', '-', '*', '/', '%']
const BITWISE = ['&', '|', '^', '<<', '>>', '>>>']
const CMP = ['<', '>', '<=', '>=', '===', '!==']
const UN = ['-', '~']
const MATH1 = ['Math.floor', 'Math.ceil', 'Math.round', 'Math.trunc', 'Math.abs', 'Math.sqrt']
const MATH2 = ['Math.min', 'Math.max', 'Math.imul']
const LITS = [0, 1, 2, 3, 5, 8, 16, 31, 32, 255, 256, 1000, 65535]

const DEFAULTS = { maxDepth: 4, maxStmts: 6, maxParams: 3, loops: true, branches: true }

// Scope discipline (so generated programs are valid JS *and* jz-equivalent):
//   • Every binding name is globally unique (shared `ctr`). jz hoists `let` to
//     function scope, so two same-named block-locals would merge in jz but not in
//     JS — uniqueness erases that divergence.
//   • `rw` = readable+writable in-scope names (params + lets declared earlier in
//     this block / enclosing blocks). `ro` = read-only (loop counters). A child
//     block copies its parent's names; its own `let`s do NOT leak back out, so a
//     binding is never read before its declaration or outside its block.
const readable = (scope) => scope.ro.length ? scope.rw.concat(scope.ro) : scope.rw
const childScope = (scope, extraRo = []) => ({ rw: [...scope.rw], ro: [...scope.ro, ...extraRo], ctr: scope.ctr })

const genExpr = (g, scope, depth) => {
  const rd = readable(scope)
  if (depth <= 0 || (rd.length && g.chance(0.34)))
    return (rd.length && g.chance(0.6)) ? { k: 'var', n: g.pick(rd) } : { k: 'num', v: g.pick(LITS) }
  switch (g.int(5)) {
    case 0: return { k: 'bin', o: g.pick(g.chance(0.55) ? ARITH : BITWISE), l: genExpr(g, scope, depth - 1), r: genExpr(g, scope, depth - 1) }
    case 1: return { k: 'un', o: g.pick(UN), x: genExpr(g, scope, depth - 1) }
    case 2: return { k: 'cond', c: genCond(g, scope, depth - 1), t: genExpr(g, scope, depth - 1), e: genExpr(g, scope, depth - 1) }
    case 3: return { k: 'call', f: g.pick(MATH1), a: [genExpr(g, scope, depth - 1)] }
    default: return { k: 'call', f: g.pick(MATH2), a: [genExpr(g, scope, depth - 1), genExpr(g, scope, depth - 1)] }
  }
}

// A condition is usually a comparison (clean boolean) but sometimes a bare numeric
// expression — exercising JS↔wasm f64 truthiness (0 / -0 / NaN are falsy).
const genCond = (g, scope, depth) =>
  g.chance(0.75)
    ? { k: 'bin', o: g.pick(CMP), l: genExpr(g, scope, depth), r: genExpr(g, scope, depth) }
    : genExpr(g, scope, depth)

// Generate n statements into `scope` (lets accumulate into scope.rw, visible to
// later statements). Child blocks pass a childScope so their lets don't escape.
const genStmts = (g, scope, cfg, n) => {
  const stmts = []
  for (let i = 0; i < n; i++) stmts.push(genStmt(g, scope, cfg))
  return stmts
}

const genStmt = (g, scope, cfg) => {
  const roll = g.int(10)
  if (roll < 4) {                                               // let v = expr
    const n = `v${scope.ctr.n++}`
    const init = genExpr(g, scope, cfg.maxDepth)
    scope.rw.push(n)                                            // visible after decl, this block onward
    return { k: 'let', n, init }
  }
  if (roll < 7) return { k: 'set', n: g.pick(scope.rw), x: genExpr(g, scope, cfg.maxDepth) }
  if (roll < 9 && cfg.branches) {
    const then = genStmts(g, childScope(scope), cfg, 1 + g.int(2))
    const els = g.chance(0.5) ? genStmts(g, childScope(scope), cfg, 1 + g.int(2)) : null
    return { k: 'if', c: genCond(g, scope, cfg.maxDepth), then, els }
  }
  if (cfg.loops) {                                              // counted while
    const ctr = `i${scope.ctr.n++}`
    const bound = 2 + g.int(30)
    // counter is read-only inside the body (in `ro`), so the harness's `i=i+1`
    // is the only writer → termination is guaranteed.
    const body = genStmts(g, childScope(scope, [ctr]), cfg, 1 + g.int(2))
    return { k: 'while', ctr, bound, body }
  }
  return { k: 'set', n: g.pick(scope.rw), x: genExpr(g, scope, cfg.maxDepth) }
}

const genProgram = (seed, cfg = DEFAULTS) => {
  const g = mkRng(seed)
  const np = 1 + g.int(cfg.maxParams)
  const params = Array.from({ length: np }, (_, i) => `p${i}`)
  const scope = { rw: [...params], ro: [], ctr: { n: 0 } }
  const body = genStmts(g, scope, cfg, 1 + g.int(cfg.maxStmts))  // top-level lets stay in scope for `ret`
  const ret = genExpr(g, scope, cfg.maxDepth)
  return { params, body, ret }
}

// ─────────────────────────────────────────────────────────────────────────────
// Serializer — AST → source. Fully parenthesized; identical text for JS and jz.
// ─────────────────────────────────────────────────────────────────────────────
const sExpr = (e) => {
  switch (e.k) {
    case 'num': return String(e.v)
    case 'var': return e.n
    case 'bin': return `(${sExpr(e.l)} ${e.o} ${sExpr(e.r)})`
    case 'un': return `(${e.o}(${sExpr(e.x)}))`
    case 'cond': return `((${sExpr(e.c)}) ? (${sExpr(e.t)}) : (${sExpr(e.e)}))`
    case 'call': return `${e.f}(${e.a.map(sExpr).join(', ')})`
  }
}
const sStmts = (stmts) => stmts.map(sStmt).join(' ')
const sStmt = (s) => {
  switch (s.k) {
    case 'let': return `let ${s.n} = ${sExpr(s.init)};`
    case 'set': return `${s.n} = ${sExpr(s.x)};`
    case 'if': return `if (${sExpr(s.c)}) { ${sStmts(s.then)} }${s.els ? ` else { ${sStmts(s.els)} }` : ''}`
    case 'while': return `let ${s.ctr} = 0; while (${s.ctr} < ${s.bound}) { ${sStmts(s.body)} ${s.ctr} = (${s.ctr} + 1); }`
  }
}
const toSource = (prog) =>
  `export let f = (${prog.params.join(', ')}) => { ${sStmts(prog.body)} return ${sExpr(prog.ret)}; }`

// ─────────────────────────────────────────────────────────────────────────────
// Oracle — compile/run both ways; compare bit-exactly (Object.is folds -0/NaN).
// ─────────────────────────────────────────────────────────────────────────────
// Input range = jz's integer CONTRACT-valid range. jz's integer arithmetic is
// asm.js-style: `+`/`-`/`*`/`~`/`<<`/`|0` stay i32 (wrapping / ToInt32) for speed,
// matching JS exactly only while operands stay where i32 == f64 — i.e. |x| < 2^31
// for bitwise (ToInt32) and products/sums < 2^31 for arithmetic. Adversarial
// ±2^31-scale integers fed into escaping arithmetic (e.g. returning `(~p0)*5`,
// `~(p*p)` at 2^32) wrap where JS keeps an f64 Number — a deliberately-allowed
// boundary (see README integer contract), NOT a miscompile. So finite magnitudes
// are capped < 2^14 (products < 2^28 ≪ 2^31, exact) while NaN/±Inf/±0 and a few
// non-integer floats stay in — they exercise the % / Math / NaN-box edges (which
// flow through f64 paths) without tripping the integer contract.
const SPECIALS = [0, -0, 1, -1, 2, -2, 0.5, -0.5, 3, 7, 255, 256, -256, 1000, -1000, 8191, 0.1, NaN, Infinity, -Infinity, 12345.678, -9876.5]
const argval = (g) => g.chance(0.4) ? g.pick(SPECIALS) : (g() - 0.5) * (g.chance(0.5) ? 2 ** 14 : 200)
// `a` = jz-wasm result, `b` = JS result. Exact match, or both NaN. Plus jz's
// documented integer contract: its `+`/`-`/`*`/`~`/`<<`/`|0` are asm.js-style
// ToInt32-wrapping (kept i32 for speed), so when JS yields an integer OUTSIDE
// int32 range, jz returns its ToInt32 — accept that (`a === (b|0)`, b an integer
// jz wrapped). For results ≤ 2^53 this is exactly ToInt32 of the true result
// (mod 2^32 is a ring homomorphism, so per-op i32 wrapping == wrapping the whole
// expression). NaN/±Inf and non-integers fall through to the strict checks, so
// real miscompiles (a wrong value that ISN'T the ToInt32 wrap) are still caught.
const same = (a, b) =>
  Object.is(a, b) || a === b || (Number.isNaN(a) && Number.isNaN(b)) ||
  (Number.isInteger(b) && Number.isInteger(a) && a === (b | 0) && a !== b)

const compileJS = (src) => new Function(`${src.replace(/export\s+let\s+f\s*=/, 'let f =')}\nreturn f`)()

// Static lexical-scope validity. JS only throws on an undeclared read when the
// read is *evaluated*, so a dead branch (`(1) ? 0 : undeclared`) runs fine in JS
// but jz (AOT, compiles all branches) rejects it — not a miscompile. A runtime
// probe can't see this; this static walk does. Used to reject shrink candidates
// that break scoping (the generator's own output is always well-scoped).
const exprScoped = (e, sc) =>
  e.k === 'num' ? true
    : e.k === 'var' ? sc.has(e.n)
      : e.k === 'un' ? exprScoped(e.x, sc)
        : e.k === 'bin' ? exprScoped(e.l, sc) && exprScoped(e.r, sc)
          : e.k === 'cond' ? exprScoped(e.c, sc) && exprScoped(e.t, sc) && exprScoped(e.e, sc)
            : e.a.every(a => exprScoped(a, sc))   // call
const stmtsScoped = (stmts, scope) => {
  const sc = new Set(scope)
  for (const s of stmts) {
    if (s.k === 'let') { if (!exprScoped(s.init, sc)) return null; sc.add(s.n) }
    else if (s.k === 'set') { if (!sc.has(s.n) || !exprScoped(s.x, sc)) return null }
    else if (s.k === 'if') { if (!exprScoped(s.c, sc) || !stmtsScoped(s.then, sc) || (s.els && !stmtsScoped(s.els, sc))) return null }
    else if (s.k === 'while') { if (!stmtsScoped(s.body, new Set(sc).add(s.ctr))) return null }
  }
  return sc
}
const wellScoped = (prog) => {
  const top = stmtsScoped(prog.body, new Set(prog.params))
  return top != null && exprScoped(prog.ret, top)
}

// Check one program. Returns null when every opt level matches JS for every
// input, else the divergence { kind, opt, args, got, want }. `kind: 'invalid'`
// means the program is malformed JS (the numeric subset never throws at runtime,
// so a JS throw ⇒ a bad shrink dropped a still-referenced binding) — it is NOT a
// jz finding; failsKind ignores it, so shrinking can never drift there.
const check = (prog, opts) => {
  if (!wellScoped(prog)) return { kind: 'invalid' }   // reject scope-broken shrink candidates
  const src = toSource(prog)
  let jsFn
  try { jsFn = compileJS(src) } catch { return { kind: 'invalid' } }
  // Establish JS ground truth FIRST. The numeric subset never throws at runtime,
  // so a JS throw ⇒ malformed program (a bad shrink dropped a referenced binding);
  // bail as 'invalid' BEFORE touching jz, so such a program is never misreported as
  // a jz-compile bug (jz correctly rejecting an undeclared var is not a finding).
  const g = mkRng(opts.inputSeed)
  const inputs = Array.from({ length: opts.inputs }, () => prog.params.map(() => argval(g)))
  const wants = []
  for (const args of inputs) {
    try { wants.push(jsFn(...args)) } catch { return { kind: 'invalid' } }
  }
  // Program is valid JS — now compile once per opt level (compile is the cost).
  const wasmFns = {}
  for (const opt of opts.optLevels) {
    try { wasmFns[opt] = jz(src, { optimize: opt }).exports.f }
    catch (e) { return { kind: 'jz-compile', opt, err: String(e && e.message || e), src } }
  }
  for (let i = 0; i < inputs.length; i++) {
    const want = wants[i]
    if (typeof want !== 'number') continue   // non-numeric JS result — out of scope
    for (const opt of opts.optLevels) {
      let got, gotErr = false
      try { got = wasmFns[opt](...inputs[i]) } catch { gotErr = true }
      if (gotErr) return { kind: 'wasm-threw', opt, args: inputs[i], want }
      if (!same(got, want)) return { kind: 'mismatch', opt, args: inputs[i], got, want }
    }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Shrinker — greedily mutate the failing program toward a minimal still-failing
// one. Mutate-test-restore on the live tree: cheap, no path bookkeeping.
// ─────────────────────────────────────────────────────────────────────────────
// Shrinking preserves the divergence *kind*: a reduction is kept only if it still
// fails the SAME way (mismatch / jz-compile / wasm-threw). A dropped `let` that
// leaves an undeclared read makes JS throw (a different kind) → rejected →
// restored, so shrinking can never drift into a spurious scope error.
const failsKind = (prog, opts, kind) => { const r = check(prog, opts); return r && r.kind === kind ? r : null }

// All expression children of a node (for "replace node with a subterm").
const kids = (e) => e.k === 'bin' ? [e.l, e.r] : e.k === 'un' ? [e.x] : e.k === 'cond' ? [e.c, e.t, e.e] : e.k === 'call' ? e.a : []

const shrink = (prog, opts, kind, budget = 4000) => {
  const fails = (p) => failsKind(p, opts, kind)
  let changed = true
  while (changed && budget > 0) {
    changed = false

    // 1) Drop a statement (top-level body), keep if still failing.
    for (let i = 0; i < prog.body.length && budget > 0; i++) {
      budget--
      const removed = prog.body.splice(i, 1)[0]
      if (fails(prog)) { changed = true; i-- } else prog.body.splice(i, 0, removed)
    }

    // 2) Replace each expression hole with a subterm / literal, keep simpler.
    const holes = []
    const visit = (parent, key, node) => {
      if (!node || typeof node !== 'object') return
      holes.push({ parent, key, node })
      for (const c of kids(node)) visit(node, kidKey(node, c), c)
    }
    const roots = []
    prog.body.forEach((s, i) => collectStmtExprs(s).forEach(([p, k]) => roots.push([p, k])))
    roots.push([prog, 'ret'])
    for (const [p, k] of roots) visit(p, k, p[k])

    for (const h of holes) {
      if (budget <= 0) break
      const cur = h.parent[h.key]
      if (!cur || typeof cur !== 'object') continue
      const cands = [...kids(cur), { k: 'num', v: 0 }, { k: 'num', v: 1 }]
      for (const cand of cands) {
        budget--
        if (cand === cur) continue
        h.parent[h.key] = cand
        if (fails(prog)) { changed = true; break }
        h.parent[h.key] = cur
      }
    }
  }
  return prog
}
// Key under which child `c` sits on `node` (so mutate-restore can address it).
const kidKey = (node, c) =>
  node.l === c ? 'l' : node.r === c ? 'r' : node.x === c ? 'x'
    : node.c === c ? 'c' : node.t === c ? 't' : node.e === c ? 'e'
      : node.a ? node.a.indexOf(c) : null
// Expression holes directly held by a statement (so shrink can reach them).
const collectStmtExprs = (s) => {
  const out = []
  if (s.k === 'let') out.push([s, 'init'])
  else if (s.k === 'set') out.push([s, 'x'])
  else if (s.k === 'if') { out.push([s, 'c']); s.then.forEach(t => out.push(...collectStmtExprs(t))); s.els?.forEach(t => out.push(...collectStmtExprs(t))) }
  else if (s.k === 'while') s.body.forEach(t => out.push(...collectStmtExprs(t)))
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Driver.
// ─────────────────────────────────────────────────────────────────────────────
export const fuzz = (opts) => {
  const findings = []
  let invalid = 0   // generator produced malformed JS — should stay 0 (scope bug if not)
  for (let i = 0; i < opts.count; i++) {
    const seed = opts.seedStart + i
    const prog = genProgram(seed, opts.cfg)
    const r = check(prog, opts)
    if (r && r.kind === 'invalid') { invalid++; continue }
    if (r) findings.push({ seed, ...r, src: r.src || toSource(prog), prog })
    if (findings.length >= (opts.maxFindings || Infinity)) break
  }
  findings.invalid = invalid
  return findings
}

// One human-readable report for a finding. Shrinks to a minimal reproducer
// (preserving the failure kind), then RE-EVALUATES the shrunk program so the
// shown args/got/want describe the minimal program — never the original.
const report = (f, opts) => {
  let prog = f.prog, d = f
  if (prog) {
    prog = shrink(structuredClone(prog), opts, f.kind)
    d = check(prog, opts) || f   // actual divergence of the shrunk program
  }
  const src = prog ? toSource(prog) : f.src
  const lines = [`seed=${f.seed}  kind=${d.kind}${d.opt != null ? `  opt=${d.opt}` : ''}`]
  if (d.args) lines.push(`  args = [${d.args.map(String).join(', ')}]`)
  if (d.kind === 'mismatch') lines.push(`  jz = ${d.got}   js = ${d.want}`)
  if (d.err) lines.push(`  err = ${d.err}`)
  lines.push(`  ${src}`)
  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite gate — deterministic, modest counts so `npm test` stays green + fast.
// Exploratory long runs go through the CLI below.
// ─────────────────────────────────────────────────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`
// KNOWN-OPEN miscompiles the fuzzer already surfaced (seeds in the gate range).
// The gate is a RATCHET: it fails only on a *new* divergence, so `npm test` stays
// green while these are tracked, and any regression introduced by a code change
// trips immediately. Fixing a bug → delete its seed(s) here so the ratchet tightens.
// All known clusters fixed — the ratchet is now empty, so ANY divergence fails CI.
// History (fixed): `%` semantics (exact __rem); Math rounding elided after param
// reassign (intCertainMap seeds f64 params false); ToInt32 of large f64 (__toint32
// i64 bit-surgery); opt3 reassign-after-%0; opt2 ternary-in-return stack imbalance
// (watr branch-fold preserves block type); i32 arithmetic overflow at the int32
// boundary — a full-range bitwise/imul operand feeding `*`/`-`/unary-`-` now widens
// to f64 (isFullRangeI32; `+` stays i32 — the ToInt32-sunk accumulator op).
const KNOWN_OPEN = new Set([])
const GATE = { count: 200, seedStart: 1, inputs: 12, inputSeed: 7, optLevels: [0, 1, 2, 3], cfg: DEFAULTS }
if (!isMain) {
  test('fuzz: no new miscompiles in seeds 1..200 × opt {0,1,2,3}', () => {
    const findings = fuzz(GATE)
    ok(findings.invalid === 0, `generator emitted ${findings.invalid} malformed programs — scope bug`)
    const fresh = findings.filter(f => !KNOWN_OPEN.has(f.seed))
    ok(fresh.length === 0, fresh.length
      ? `NEW miscompile(s) — a change regressed the compiler:\n\n${fresh.map(f => report(f, GATE)).join('\n\n')}`
      : `no regressions (${findings.length} known-open)`)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI.
// ─────────────────────────────────────────────────────────────────────────────
if (isMain) {
  const arg = (name, def) => {
    const m = process.argv.find(a => a.startsWith(`--${name}=`))
    return m ? m.slice(name.length + 3) : def
  }
  const optLevels = arg('opt', '0,1,2,3').split(',').map(Number)
  const single = arg('seed', null)
  const opts = {
    count: single != null ? 1 : Number(arg('count', 2000)),
    seedStart: single != null ? Number(single) : Number(arg('seedStart', 1)),
    inputs: Number(arg('inputs', 20)),
    inputSeed: Number(arg('inputSeed', 7)),
    optLevels, cfg: DEFAULTS, maxFindings: Number(arg('maxFindings', 20)),
  }
  if (single != null) {
    const prog = genProgram(Number(single), opts.cfg)
    console.log(toSource(prog))
    const r = check(prog, opts)
    console.log(r ? `DIVERGENCE:\n${report({ seed: Number(single), ...r, prog }, opts)}` : 'ok — matches JS at all opt levels')
  } else {
    const t0 = performance.now()
    const findings = fuzz(opts)
    const ms = performance.now() - t0
    console.log(`fuzzed ${opts.count} programs (seeds ${opts.seedStart}..${opts.seedStart + opts.count - 1}), opt {${optLevels}}, ${opts.inputs} inputs each — ${ms.toFixed(0)}ms${findings.invalid ? `  (${findings.invalid} malformed — generator scope bug!)` : ''}`)
    if (!findings.length) console.log('✓ no divergence — jz wasm == JS for every program at every opt level')
    else {
      console.log(`✗ ${findings.length} finding(s):\n`)
      for (const f of findings) console.log(report(f, opts) + '\n')
      process.exit(1)
    }
  }
}
