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

// ─────────────────────────────────────────────────────────────────────────────
// Integer-CONTRACT model — decides whether an input is in-contract for a program.
// ─────────────────────────────────────────────────────────────────────────────
// `same()` accepts a final-value i32 wrap (a === b|0). But jz narrows i32 at every
// op, so an INTERMEDIATE that overflows ±2^31 (or is -0, which i32 can't hold, or a
// `>>>` past 2^31 since jz keeps signed) and then flows through a NON-wrapping op
// (Math.*, /, comparison, 1/x) yields a final value `same()` can't recognize as the
// wrap — jz is correct PER CONTRACT, not a miscompile. This walks the AST exactly
// like JS (so values match the JS oracle) while tracking which results jz holds as
// i32; if any i32 result is out-of-contract for these args, the input is skipped.
// Only i32 paths are gated — f64 / NaN / -0-via-f64 / % edges stay fully checked, so
// a real miscompile (e.g. a sign-flipped NaN) is never masked.
const I32MIN = -2147483648, I32MAX = 2147483647
const outOfContract = (v) => v < I32MIN || v > I32MAX || Object.is(v, -0)
// A bitwise/`~` operand outside i32 range needs a real ToInt32 (modulo-2^32) wrap;
// JS does that, but jz converts via i32.trunc (saturating / precision-lossy for
// |x| ≥ 2^31), so the result diverges. In range, ToInt32 == trunc and jz matches.
const needsWrap = (v) => v < I32MIN || v > I32MAX
const jsBin = (o, a, b) => {
  switch (o) {
    case '+': return a + b; case '-': return a - b; case '*': return a * b
    case '/': return a / b; case '%': return a % b
    case '&': return a & b; case '|': return a | b; case '^': return a ^ b
    case '<<': return a << b; case '>>': return a >> b; case '>>>': return a >>> b
    case '<': return a < b; case '>': return a > b; case '<=': return a <= b
    case '>=': return a >= b; case '===': return a === b; case '!==': return a !== b
  }
}
const MATHFN = {
  'Math.floor': Math.floor, 'Math.ceil': Math.ceil, 'Math.round': Math.round,
  'Math.trunc': Math.trunc, 'Math.abs': Math.abs, 'Math.sqrt': Math.sqrt,
  'Math.min': Math.min, 'Math.max': Math.max, 'Math.imul': Math.imul,
}
// Returns { v, i32 } — v is the JS value, i32 marks results jz keeps as int32.
// Sets st.oob when an i32-typed value leaves the contract-exact domain.
const evalC = (e, env, st) => {
  switch (e.k) {
    case 'num': return { v: e.v, i32: Number.isInteger(e.v) }
    case 'var': return env.get(e.n) || { v: 0, i32: false }
    case 'un': {
      const x = evalC(e.x, env, st)
      if (e.o === '~') { if (needsWrap(x.v)) st.oob = true; return { v: ~x.v, i32: true } }
      const v = -x.v
      if (x.i32 && outOfContract(v)) st.oob = true              // i32 negate: no -0, may overflow (-(1<<31))
      return { v, i32: x.i32 }
    }
    case 'bin': {
      const l = evalC(e.l, env, st), r = evalC(e.r, env, st)
      const o = e.o, v = jsBin(o, l.v, r.v)
      if (o === '>>>') { if (needsWrap(l.v) || v > I32MAX) st.oob = true; return { v, i32: true } }  // jz keeps signed i32
      if (o === '<<' || o === '>>') { if (needsWrap(l.v)) st.oob = true; return { v, i32: true } }    // LHS ToInt32'd
      if (o === '&' || o === '|' || o === '^') { if (needsWrap(l.v) || needsWrap(r.v)) st.oob = true; return { v, i32: true } }
      if (o === '<' || o === '>' || o === '<=' || o === '>=' || o === '===' || o === '!==')
        return { v, i32: true }                                 // boolean 0/1 — i32 (so -(cmp) sees -0)
      if (o === '+' || o === '-' || o === '*') {
        const i32 = l.i32 && r.i32
        if (i32 && outOfContract(v)) st.oob = true
        return { v, i32 }
      }
      return { v, i32: false }                                  // '/', '%' → f64
    }
    case 'cond': {
      const c = evalC(e.c, env, st)
      return c.v ? evalC(e.t, env, st) : evalC(e.e, env, st)
    }
    case 'call': {
      const a = e.a.map((x) => evalC(x, env, st))
      if (e.f === 'Math.imul') return { v: Math.imul(a[0].v, a[1].v), i32: true }
      return { v: MATHFN[e.f](...a.map((x) => x.v)), i32: false }
    }
  }
}
const execC = (stmts, env, st) => {
  for (const s of stmts) {
    if (st.oob) return
    if (s.k === 'let' || s.k === 'set') env.set(s.n, evalC(s.k === 'let' ? s.init : s.x, env, st))
    else if (s.k === 'if') { const c = evalC(s.c, env, st); c.v ? execC(s.then, env, st) : s.els && execC(s.els, env, st) }
    else if (s.k === 'while') {
      env.set(s.ctr, { v: 0, i32: true })
      while (!st.oob && env.get(s.ctr).v < s.bound) {
        execC(s.body, env, st)
        env.set(s.ctr, { v: env.get(s.ctr).v + 1, i32: true })
      }
    }
  }
}
// True when every i32-narrowed intermediate stays in contract for these args.
const inContract = (prog, args) => {
  const env = new Map()
  prog.params.forEach((p, i) => env.set(p, { v: args[i], i32: false }))  // params are f64 to jz
  const st = { oob: false }
  execC(prog.body, env, st)
  if (!st.oob) evalC(prog.ret, env, st)
  return !st.oob
}
// Coverage accounting — surfaced in the CLI summary so the i32-contract skips are
// never a silent cap (a generator change that suddenly skips everything is visible).
const contractStats = { compared: 0, skipped: 0, nonNumeric: 0 }

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
    if (typeof want !== 'number') { contractStats.nonNumeric++; continue }   // non-numeric JS result — out of scope
    if (!inContract(prog, inputs[i])) { contractStats.skipped++; continue }   // i32 contract exceeded for these args — skip
    contractStats.compared++
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
  contractStats.compared = contractStats.skipped = contractStats.nonNumeric = 0
  const findings = []
  let invalid = 0   // generator produced malformed JS — should stay 0 (scope bug if not)
  for (let i = 0; i < opts.count; i++) {
    if (opts.count >= 500 && i > 0 && i % 500 === 0) {
      console.log(`  .. processed ${i} / ${opts.count} programs ..`)
    }
    const seed = opts.seedStart + i
    const prog = genProgram(seed, opts.cfg)
    const r = check(prog, opts)
    if (r && r.kind === 'invalid') { invalid++; continue }
    if (r) findings.push({ seed, ...r, src: r.src || toSource(prog), prog })
    if (findings.length >= (opts.maxFindings || Infinity)) break
  }
  findings.invalid = invalid
  findings.stats = { ...contractStats }
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
// Typed-array mode (FUZZ-1) — exercises Float64Array element read/write/loop/reduce.
// ─────────────────────────────────────────────────────────────────────────────
// The scalar fuzzer never touches linear memory; this generates kernels that load,
// mutate and store Float64Array elements in a counted loop and a reduction, then
// diffs jz (memory-backed array) against JS (plain Float64Array) element-by-element
// AND on the returned reduction. Element VALUE expressions use ONLY f64-stable ops
// (+ - * / Math.sqrt/abs/min/max) over `buf[i]` and float literals: a Float64 load is
// exact and these never i32-narrow, so jz == JS bit-for-bit with no contract caveat.
// The loop counter `i` is i32 and is used only as the subscript — never inside a value
// expression, where e.g. `i * -1.0` would mint a -0 that jz's i32 path can't hold (the
// documented integer contract the scalar oracle skips; phase-2 with the contract model
// can add index-dependent values).
const F_LEAF = ['buf[i]', '0.5', '1.5', '2.0', '3.0', '-1.5', '10.0', '0.1', '-0.25']
const F_MATH1 = ['Math.sqrt', 'Math.abs']
const genFloatExpr = (g, d) => {
  if (d <= 0 || g.chance(0.4)) return g.chance(0.55) ? 'buf[i]' : g.pick(F_LEAF)
  switch (g.int(4)) {
    case 0: return `(${genFloatExpr(g, d - 1)} ${g.pick(['+', '-', '*', '/'])} ${genFloatExpr(g, d - 1)})`
    case 1: return `${g.pick(F_MATH1)}(${genFloatExpr(g, d - 1)})`
    case 2: return `Math.${g.pick(['min', 'max'])}(${genFloatExpr(g, d - 1)}, ${genFloatExpr(g, d - 1)})`
    default: return `(${genFloatExpr(g, d - 1)} * ${g.pick(['0.5', '2.0', '1.5', '-1.0'])})`
  }
}
const typedSource = (seed) => {
  const g = mkRng(seed)
  const writes = Array.from({ length: 1 + g.int(2) }, () => `buf[i] = ${genFloatExpr(g, 4)};`).join(' ')
  // Reduction over the mutated buffer so the return value also crosses the boundary.
  return `export let f = (buf, n) => { let acc = 0.0; for (let i = 0; i < n; i++) { ${writes} acc = acc + buf[i]; } return acc; }`
}
const checkTyped = (seed, opts) => {
  const src = typedSource(seed)
  let jsFn
  try { jsFn = compileJS(src) } catch { return { kind: 'invalid' } }
  const g = mkRng(opts.inputSeed + seed)
  const n = 6 + g.int(10)
  const data = Array.from({ length: n }, () => argval(g))
  const jsArr = Float64Array.from(data)
  let jsRet
  try { jsRet = jsFn(jsArr, n) } catch { return { kind: 'invalid' } }
  if (typeof jsRet !== 'number') return null
  for (const opt of opts.optLevels) {
    let inst, ret, jzArr
    try {
      inst = jz(src, { optimize: opt })
      const p = inst.memory.Float64Array(data)
      ret = inst.exports.f(p, n)
      jzArr = inst.memory.read(p)
    } catch (e) { return { kind: 'jz-compile', opt, err: String(e && e.message || e), src } }
    if (!same(ret, jsRet)) return { kind: 'mismatch-ret', opt, got: ret, want: jsRet, src }
    for (let i = 0; i < n; i++)
      if (!same(jzArr[i], jsArr[i])) return { kind: 'mismatch-elem', opt, idx: i, got: jzArr[i], want: jsArr[i], src }
  }
  return null
}
export const fuzzTyped = (opts) => {
  const findings = []
  for (let i = 0; i < opts.count; i++) {
    const seed = opts.seedStart + i
    const r = checkTyped(seed, opts)
    if (r && r.kind !== 'invalid') findings.push({ seed, ...r })
    if (findings.length >= (opts.maxFindings || Infinity)) break
  }
  return findings
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure-MAP mode (FUZZ-1) — the loop that ACTUALLY vectorizes.
// ─────────────────────────────────────────────────────────────────────────────
// `checkTyped` above mixes a store and a reduction in one loop, so `acc` is
// loop-carried and the loop never lifts to SIMD. This generates a PURE element
// map — `buf[i] = f(buf[i], consts)` with no cross-lane dataflow — which the
// vectorizer DOES lift. Such a map is bit-exact by construction: lane k computes
// exactly what scalar element k computes, with the same ops in the same order
// (no reassociation), so jz == JS for ANY data including NaN/±Inf/±0 — no contract
// caveat. The value expression includes `?:` conditionals (clamp / ReLU /
// threshold), which is the generative coverage for conditional-lane vectorization.
const genFloatCond = (g, d) => `(${genFloatExpr(g, d)} ${g.pick(CMP)} ${genFloatExpr(g, d)})`
const genFloatVal = (g, d) =>
  (d > 0 && g.chance(0.32))
    ? `((${genFloatCond(g, d - 1)}) ? ${genFloatVal(g, d - 1)} : ${genFloatVal(g, d - 1)})`
    : genFloatExpr(g, d)
// The array is INTERNAL with a CONSTANT length: a param-array map keeps `n` as an
// f64 (so the bound test is `f64.lt`, which the vectorizer skips) and lowers the
// element WRITE through the dynamic-assign path — neither vectorizes. An internal
// `new Float64Array(N)` with `i < N` gives the clean `i32`-bounded `f64.load`/
// `f64.store` loop the vectorizer lifts. We seed it with a spread spanning the
// comparison boundaries (negative/zero/positive) and return it for an element-wise
// diff (Object.is — exact, distinguishes ±0, treats NaN==NaN).
const typedMapSource = (seed) => {
  const g = mkRng(seed)
  const N = 60 + g.int(8)   // 60..67: even & odd ⇒ exercises the SIMD body AND the scalar tail
  const body = Array.from({ length: 1 + g.int(2) }, () => `buf[i] = ${genFloatVal(g, 4)};`).join(' ')
  return `export let f = () => { const buf = new Float64Array(${N}); for (let i = 0; i < ${N}; i++) buf[i] = (i - 30) * 0.5; for (let i = 0; i < ${N}; i++) { ${body} } return buf }`
}
const checkTypedMap = (seed, opts) => {
  const src = typedMapSource(seed)
  let jsFn
  try { jsFn = compileJS(src) } catch { return { kind: 'invalid' } }
  let jsArr
  try { jsArr = jsFn() } catch { return { kind: 'invalid' } }
  if (!(jsArr instanceof Float64Array)) return null
  for (const opt of opts.optLevels) {
    let jzArr
    try {
      const inst = jz(src, { optimize: opt })
      jzArr = inst.memory.read(inst.exports.f())
    } catch (e) { return { kind: 'jz-compile', opt, err: String(e && e.message || e), src } }
    for (let i = 0; i < jsArr.length; i++)
      if (!Object.is(jzArr[i], jsArr[i])) return { kind: 'mismatch-elem', opt, idx: i, got: jzArr[i], want: jsArr[i], src }
  }
  return null
}
export const fuzzTypedMap = (opts) => {
  const findings = []
  for (let i = 0; i < opts.count; i++) {
    const seed = opts.seedStart + i
    const r = checkTypedMap(seed, opts)
    if (r && r.kind !== 'invalid') findings.push({ seed, ...r })
    if (findings.length >= (opts.maxFindings || Infinity)) break
  }
  return findings
}

// ─────────────────────────────────────────────────────────────────────────────
// Int32Array mode (FUZZ-1) — integer maps + an i32 sum reduction.
// ─────────────────────────────────────────────────────────────────────────────
// Exercises the `(i32 ± i32)|0` lowering over typed-array loads (which emit as f64
// then ToInt32): the optimizer folds it back to i32.add/sub, which is what lets the
// int SUM reduction vectorize to i32x4.add. Every op is `|0`-clamped so JS and jz
// agree step-for-step under the integer contract (`same()` tolerates the wrap). The
// returned sum crosses both the map result and the reduction.
// `*` excluded: products of i32 values can exceed 2^53, where JS (Number) loses
// precision before `|0` while jz wraps each step — a documented integer-contract
// divergence, not a miscompile (the scalar fuzzer gates it via inContract). The
// kept ops are mod-2^32 homomorphic, so jz's per-step wrap == JS's exact-then-`|0`,
// and the small init keeps every value well inside the exact range.
const I_LEAF = ['a[i]', '1', '2', '3', '7', '255']
const iLeaf = (g) => g.chance(0.6) ? 'a[i]' : g.pick(I_LEAF)
// Comparison over LEAVES only (bounded operands): a comparison must never consume a
// non-`|0`'d arithmetic intermediate, which can overflow i32 (e.g. `(a<<a)`), where JS
// keeps the exact Number and jz wraps — a contract divergence, not a miscompile.
const genIntCmp = (g) => `(${iLeaf(g)} ${g.pick(['<', '>', '<=', '>=', '===', '!=='])} ${iLeaf(g)})`
const genIntExpr = (g, d) => {
  if (d <= 0 || g.chance(0.4)) return iLeaf(g)
  // The 0/1 result feeds the homomorphic arithmetic below. Exercises the
  // f64.cmp(convert,convert) → i32.cmp fold soundly.
  if (g.chance(0.2)) return genIntCmp(g)
  // Conditional over a LEAF comparison (exact 0/1 condition in both JS and jz). ToInt32
  // distributes through `?:` (selection just picks one already-homomorphic branch), so it
  // stays contract-sound. Exercises the ToInt32(if (result f64) C A B) → if (result i32)
  // push that turns int conditional maps into i32x4 v128.bitselect.
  if (g.chance(0.25)) return `(${genIntCmp(g)} ? ${genIntExpr(g, d - 1)} : ${genIntExpr(g, d - 1)})`
  return `(${genIntExpr(g, d - 1)} ${g.pick(['+', '-', '&', '|', '^', '<<'])} ${genIntExpr(g, d - 1)})`
}
const typedIntSource = (seed) => {
  const g = mkRng(seed)
  const N = 200 + g.int(60)
  const map = Array.from({ length: 1 + g.int(2) }, () => `a[i] = (${genIntExpr(g, 3)}) | 0;`).join(' ')
  return `export let f = () => { const a = new Int32Array(${N}); for (let i = 0; i < ${N}; i++) a[i] = (i * 7 - 90) | 0; for (let i = 0; i < ${N}; i++) { ${map} } let s = 0; for (let i = 0; i < ${N}; i++) s = (s + a[i]) | 0; return s | 0 }`
}
const checkTypedInt = (seed, opts) => {
  const src = typedIntSource(seed)
  let jsFn
  try { jsFn = compileJS(src) } catch { return { kind: 'invalid' } }
  let jsRet
  try { jsRet = jsFn() } catch { return { kind: 'invalid' } }
  if (typeof jsRet !== 'number') return null
  for (const opt of opts.optLevels) {
    let got
    try { got = jz(src, { optimize: opt }).exports.f() } catch (e) { return { kind: 'jz-compile', opt, err: String(e && e.message || e), src } }
    if (!same(got, jsRet)) return { kind: 'mismatch-ret', opt, got, want: jsRet, src }
  }
  return null
}
export const fuzzTypedInt = (opts) => {
  const findings = []
  for (let i = 0; i < opts.count; i++) {
    const seed = opts.seedStart + i
    const r = checkTypedInt(seed, opts)
    if (r && r.kind !== 'invalid') findings.push({ seed, ...r })
    if (findings.length >= (opts.maxFindings || Infinity)) break
  }
  return findings
}

// Integer min/max reductions over Int32Array — the peak-find idiom in all branch ×
// comparison orderings. Each reduces to i32x4.max_s/min_s (matchIntMinMaxReduce);
// min/max reassociate value-exactly (selection picks an operand, no arithmetic), so
// JS and jz agree step-for-step and `|0` is identity on the already-i32 accumulator.
const MINMAX_FORMS = [
  '(a[i] > m ? a[i] : m)', '(a[i] >= m ? a[i] : m)', '(m > a[i] ? m : a[i])', '(m >= a[i] ? m : a[i])',  // max
  '(a[i] < m ? a[i] : m)', '(a[i] <= m ? a[i] : m)', '(m < a[i] ? m : a[i])', '(m <= a[i] ? m : a[i])',  // min
]
const typedIntMinMaxSource = (seed) => {
  const g = mkRng(seed)
  const N = 64 + g.int(200)
  const form = g.pick(MINMAX_FORMS)
  const isMin = form.includes('<')
  const K = 1 + g.int(97), C = g.int(4000) - 2000
  // Seed styles: the op's neutral (INT_MIN/MAX), a mid value, or the `m=a[0]` idiom
  // (start at i=1 — exercises the overshoot-safe SIMD bound for a non-zero start).
  let init, start
  const style = g.int(3)
  if (style === 0) { init = isMin ? '2147483647' : '-2147483648'; start = 0 }
  else if (style === 1) { init = String(g.int(2000) - 1000); start = 0 }
  else { init = 'a[0]'; start = 1 }
  return `export let f = () => { const a = new Int32Array(${N}); for (let i = 0; i < ${N}; i++) a[i] = ((i * ${K} + ${C}) % 4001 - 2000) | 0; let m = ${init}; for (let i = ${start}; i < ${N}; i++) m = ${form} | 0; return m | 0 }`
}
const checkTypedIntMinMax = (seed, opts) => {
  const src = typedIntMinMaxSource(seed)
  let jsRet
  try { jsRet = compileJS(src)() } catch { return { kind: 'invalid' } }
  if (typeof jsRet !== 'number') return null
  for (const opt of opts.optLevels) {
    let got
    try { got = jz(src, { optimize: opt }).exports.f() } catch (e) { return { kind: 'jz-compile', opt, err: String(e && e.message || e), src } }
    if (!same(got, jsRet)) return { kind: 'mismatch-ret', opt, got, want: jsRet, src }
  }
  return null
}
export const fuzzTypedIntMinMax = (opts) => {
  const findings = []
  for (let i = 0; i < opts.count; i++) {
    const seed = opts.seedStart + i
    const r = checkTypedIntMinMax(seed, opts)
    if (r && r.kind !== 'invalid') findings.push({ seed, ...r })
    if (findings.length >= (opts.maxFindings || Infinity)) break
  }
  return findings
}

// Affine Int32Array loops that do NOT vectorize (an early break/continue), so the
// vectorizer falls through to induction-variable strength reduction — `a[i]` addressing
// becomes a strided pointer. Differential vs JS validates the IV-SR transform keeps the
// pointer in lockstep with `i` across break/continue control flow. Every op is `|0`-clamped
// so JS and jz agree under the integer contract (`same()` tolerates the wrap).
const IVSR_BODIES = [
  'if (a[i] > T) break; acc = (acc + a[i]) | 0;',
  'if (a[i] < 0) continue; acc = (acc ^ a[i]) | 0;',
  'acc = (acc + a[i]) | 0; if (acc > T) break;',
  'if ((a[i] & 1) === 0) continue; acc = (acc - a[i]) | 0;',
  'acc = (acc | a[i]) | 0; if (i > T) break;',
]
const typedIVSRSource = (seed) => {
  const g = mkRng(seed)
  const N = 64 + g.int(200)
  const K = 1 + g.int(50), C = g.int(4000) - 2000
  const T = g.int(4000) - 1000
  const body = g.pick(IVSR_BODIES).replace(/\bT\b/g, String(T))
  return `export let f = () => { const a = new Int32Array(${N}); for (let i = 0; i < ${N}; i++) a[i] = ((i * ${K} + ${C}) % 4001 - 2000) | 0; let acc = 0; for (let i = 0; i < ${N}; i++) { ${body} } return acc | 0 }`
}
const checkTypedIVSR = (seed, opts) => {
  const src = typedIVSRSource(seed)
  let jsRet
  try { jsRet = compileJS(src)() } catch { return { kind: 'invalid' } }
  if (typeof jsRet !== 'number') return null
  for (const opt of opts.optLevels) {
    let got
    try { got = jz(src, { optimize: opt }).exports.f() } catch (e) { return { kind: 'jz-compile', opt, err: String(e && e.message || e), src } }
    if (!same(got, jsRet)) return { kind: 'mismatch-ret', opt, got, want: jsRet, src }
  }
  return null
}
export const fuzzTypedIVSR = (opts) => {
  const findings = []
  for (let i = 0; i < opts.count; i++) {
    const seed = opts.seedStart + i
    const r = checkTypedIVSR(seed, opts)
    if (r && r.kind !== 'invalid') findings.push({ seed, ...r })
    if (findings.length >= (opts.maxFindings || Infinity)) break
  }
  return findings
}

// memchr-shaped Uint8Array scans ("find first index where b[i] ==/!= delim") — the byte-
// scan SIMD recognizer's target. Covers eq/ne, constant + runtime delimiters, and
// deliberately out-of-[0,255] targets (so the runtime guard must fall back to the scalar
// tail). The found index is exact, so JS and jz must agree byte-for-byte.
const typedByteScanSource = (seed) => {
  const g = mkRng(seed)
  const N = 32 + g.int(200)
  const K = 1 + g.int(255), C = g.int(256)
  const cmp = g.chance(0.5) ? '===' : '!=='
  let decl = '', delim
  const r = g.int(3)
  if (r === 0) delim = String(g.int(300) - 20)              // const, sometimes out of range
  else if (r === 1) { decl = `let t = (b[0] + ${g.int(300) - 20}) | 0;`; delim = 't' }  // runtime, maybe out of range
  else { decl = `let t = ${g.int(256)};`; delim = 't' }     // runtime in range
  return `export let f = () => { const b = new Uint8Array(${N}); for (let i = 0; i < ${N}; i++) b[i] = ((i * ${K} + ${C}) & 255); ${decl} let i = 0; while (i < ${N}) { if (b[i] ${cmp} ${delim}) break; i = (i + 1) | 0 } return i | 0 }`
}
const checkTypedByteScan = (seed, opts) => {
  const src = typedByteScanSource(seed)
  let jsRet
  try { jsRet = compileJS(src)() } catch { return { kind: 'invalid' } }
  if (typeof jsRet !== 'number') return null
  for (const opt of opts.optLevels) {
    let got
    try { got = jz(src, { optimize: opt }).exports.f() } catch (e) { return { kind: 'jz-compile', opt, err: String(e && e.message || e), src } }
    if (!same(got, jsRet)) return { kind: 'mismatch-ret', opt, got, want: jsRet, src }
  }
  return null
}
export const fuzzTypedByteScan = (opts) => {
  const findings = []
  for (let i = 0; i < opts.count; i++) {
    const seed = opts.seedStart + i
    const r = checkTypedByteScan(seed, opts)
    if (r && r.kind !== 'invalid') findings.push({ seed, ...r })
    if (findings.length >= (opts.maxFindings || Infinity)) break
  }
  return findings
}

// Source generators — exported so the STRUCTURAL-invariant verifier
// (test/wat-invariants.js) sweeps the SAME seeded programs the correctness
// fuzzer runs, but checks the optimized WAT for absence-of-overhead (no f64
// round-trip in an integer loop, no per-iteration pointer decode, …) rather
// than just value parity. Same population, two oracles: correctness + waste.
export {
  genProgram as genScalarProgram, toSource as scalarSource,
  typedSource, typedMapSource, typedIntSource, typedIntMinMaxSource,
  typedIVSRSource, typedByteScanSource,
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
// JZ_FUZZ_GATE scales the gate seed counts (0 < scale ≤ 1). The kernel-target CI
// leg (JZ_TEST_TARGET=jz.wasm on a 2-core runner) compiles every fuzz program
// through the wasm kernel — full 200×4 alone exceeds GitHub's 6-hour job limit.
// Local runs and the native CI legs keep the full gate.
const GATE_SCALE = Math.min(1, Math.max(0.05, +process.env.JZ_FUZZ_GATE || 1))
const N = (n) => Math.max(5, Math.round(n * GATE_SCALE))
const GATE = { count: N(200), seedStart: 1, inputs: 12, inputSeed: 7, optLevels: [0, 1, 2, 3], cfg: DEFAULTS }
if (!isMain) {
  test('fuzz: no new miscompiles in seeds 1..200 × opt {0,1,2,3}', () => {
    const findings = fuzz(GATE)
    ok(findings.invalid === 0, `generator emitted ${findings.invalid} malformed programs — scope bug`)
    const fresh = findings.filter(f => !KNOWN_OPEN.has(f.seed))
    ok(fresh.length === 0, fresh.length
      ? `NEW miscompile(s) — a change regressed the compiler:\n\n${fresh.map(f => report(f, GATE)).join('\n\n')}`
      : `no regressions (${findings.length} known-open)`)
  })
  test('fuzz: Float64Array element ops match JS in seeds 1..100 × opt {0,1,2,3}', () => {
    const findings = fuzzTyped({ ...GATE, count: N(100) })
    ok(findings.length === 0, findings.length
      ? `typed-array divergence:\n\n${findings.map(f => `seed=${f.seed} ${f.kind}${f.idx != null ? ` idx=${f.idx}` : ''} jz=${f.got} js=${f.want}\n  ${f.src}`).join('\n\n')}`
      : 'jz Float64Array == JS')
  })
  test('fuzz: Float64Array pure-map (incl. ?:) matches JS in seeds 1..120 × opt {0,1,2,3}', () => {
    const findings = fuzzTypedMap({ ...GATE, count: N(120) })
    ok(findings.length === 0, findings.length
      ? `typed-map divergence:\n\n${findings.map(f => `seed=${f.seed} ${f.kind}${f.idx != null ? ` idx=${f.idx}` : ''} jz=${f.got} js=${f.want}\n  ${f.src}`).join('\n\n')}`
      : 'jz Float64Array map == JS')
  })
  test('fuzz: Int32Array map + i32 sum reduction matches JS in seeds 1..120 × opt {0,1,2,3}', () => {
    const findings = fuzzTypedInt({ ...GATE, count: N(120) })
    ok(findings.length === 0, findings.length
      ? `typed-int divergence:\n\n${findings.map(f => `seed=${f.seed} ${f.kind} jz=${f.got} js=${f.want}\n  ${f.src}`).join('\n\n')}`
      : 'jz Int32Array == JS')
  })
  test('fuzz: Int32Array min/max reduction matches JS in seeds 1..120 × opt {0,1,2,3}', () => {
    const findings = fuzzTypedIntMinMax({ ...GATE, count: N(120) })
    ok(findings.length === 0, findings.length
      ? `typed-int-minmax divergence:\n\n${findings.map(f => `seed=${f.seed} ${f.kind} jz=${f.got} js=${f.want}\n  ${f.src}`).join('\n\n')}`
      : 'jz Int32Array min/max == JS')
  })
  test('fuzz: Int32Array affine break/continue loop (IV strength reduction) matches JS', () => {
    const findings = fuzzTypedIVSR({ ...GATE, count: N(120) })
    ok(findings.length === 0, findings.length
      ? `typed-ivsr divergence:\n\n${findings.map(f => `seed=${f.seed} ${f.kind} jz=${f.got} js=${f.want}\n  ${f.src}`).join('\n\n')}`
      : 'jz IV-SR == JS')
  })
  test('fuzz: Uint8Array memchr byte scan (SIMD i8x16) matches JS in seeds 1..120 × opt {0,1,2,3}', () => {
    const findings = fuzzTypedByteScan({ ...GATE, count: N(120) })
    ok(findings.length === 0, findings.length
      ? `byte-scan divergence:\n\n${findings.map(f => `seed=${f.seed} ${f.kind} jz=${f.got} js=${f.want}\n  ${f.src}`).join('\n\n')}`
      : 'jz byte-scan == JS')
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
  if (process.argv.includes('--typed-int')) {
    // FUZZ-1: Int32Array map + i32 sum reduction (exercises (i32±i32)|0 fold), jz vs JS.
    const t0 = performance.now()
    const findings = fuzzTypedInt(opts)
    console.log(`fuzzed ${opts.count} typed-int programs (seeds ${opts.seedStart}..${opts.seedStart + opts.count - 1}), opt {${optLevels}} — ${(performance.now() - t0).toFixed(0)}ms`)
    if (!findings.length) console.log('✓ no divergence — jz Int32Array == JS for every program')
    else {
      console.log(`✗ ${findings.length} finding(s):\n`)
      for (const f of findings) console.log(`seed=${f.seed} kind=${f.kind}${f.opt != null ? ` opt=${f.opt}` : ''}\n  jz=${f.got} js=${f.want}${f.err ? ` err=${f.err}` : ''}\n  ${f.src}\n`)
      process.exit(1)
    }
  } else if (process.argv.includes('--typed-map')) {
    // FUZZ-1: pure Float64Array element map (vectorizes), jz vs JS, element-wise.
    const t0 = performance.now()
    const findings = fuzzTypedMap(opts)
    console.log(`fuzzed ${opts.count} typed-map programs (seeds ${opts.seedStart}..${opts.seedStart + opts.count - 1}), opt {${optLevels}} — ${(performance.now() - t0).toFixed(0)}ms`)
    if (!findings.length) console.log('✓ no divergence — jz Float64Array map == JS for every program')
    else {
      console.log(`✗ ${findings.length} finding(s):\n`)
      for (const f of findings) console.log(`seed=${f.seed} kind=${f.kind}${f.opt != null ? ` opt=${f.opt}` : ''}${f.idx != null ? ` idx=${f.idx}` : ''}\n  jz=${f.got} js=${f.want}${f.err ? ` err=${f.err}` : ''}\n  ${f.src}\n`)
      process.exit(1)
    }
  } else if (process.argv.includes('--typed')) {
    // FUZZ-1: Float64Array element read/write/loop/reduce, jz vs JS.
    const t0 = performance.now()
    const findings = fuzzTyped(opts)
    console.log(`fuzzed ${opts.count} typed-array programs (seeds ${opts.seedStart}..${opts.seedStart + opts.count - 1}), opt {${optLevels}} — ${(performance.now() - t0).toFixed(0)}ms`)
    if (!findings.length) console.log('✓ no divergence — jz Float64Array == JS for every program')
    else {
      console.log(`✗ ${findings.length} finding(s):\n`)
      for (const f of findings) console.log(`seed=${f.seed} kind=${f.kind}${f.opt != null ? ` opt=${f.opt}` : ''}${f.idx != null ? ` idx=${f.idx}` : ''}\n  jz=${f.got} js=${f.want}${f.err ? ` err=${f.err}` : ''}\n  ${f.src}\n`)
      process.exit(1)
    }
  } else if (single != null) {
    const prog = genProgram(Number(single), opts.cfg)
    console.log(toSource(prog))
    const r = check(prog, opts)
    console.log(r ? `DIVERGENCE:\n${report({ seed: Number(single), ...r, prog }, opts)}` : 'ok — matches JS at all opt levels')
  } else {
    const t0 = performance.now()
    const findings = fuzz(opts)
    const ms = performance.now() - t0
    const st = findings.stats
    console.log(`fuzzed ${opts.count} programs (seeds ${opts.seedStart}..${opts.seedStart + opts.count - 1}), opt {${optLevels}}, ${opts.inputs} inputs each — ${ms.toFixed(0)}ms${findings.invalid ? `  (${findings.invalid} malformed — generator scope bug!)` : ''}`)
    console.log(`  inputs: ${st.compared} compared, ${st.skipped} skipped (i32 contract exceeded), ${st.nonNumeric} non-numeric`)
    if (!findings.length) console.log('✓ no divergence — jz wasm == JS for every program at every opt level')
    else {
      console.log(`✗ ${findings.length} finding(s):\n`)
      for (const f of findings) console.log(report(f, opts) + '\n')
      process.exit(1)
    }
  }
}
