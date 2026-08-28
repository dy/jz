/**
 * Correctly-rounded pow: two-phase Ziv dd/td kernel ($math.pow_transcend).
 * Pure move from module/math.js (pipeline-minimality) — the entire crPow-only
 * codegen subsystem (EFT/Builder primitives, log2/exp2 table generators,
 * breakpoint data tables, genPowTranscend itself) that math.js's `if (crPow)`
 * gate wraps. Every name here is grep-verified used ONLY within this range in
 * the original file — zero coupling to math.js's `f`/`fn`/`canon`/`emit`/
 * `typed` emit-dispatch layer; this is pure WAT-text generation from its own
 * Builder abstraction. See the algorithm/rationale comment below (moved
 * verbatim) and math.js's own `if (crPow) { registerPowTranscend() }` call
 * site for why the whole section is gated behind `optimize.crPow`.
 *
 * @module math/pow-transcend
 */
import { wat } from '../../src/bridge.js'
import { ctx } from '../../src/ctx.js'

export const registerPowTranscend = () => {
  // ============================================
  // Correctly-rounded pow: two-phase Ziv dd/td kernel
  // ============================================
  // $math.pow_transcend(x,y) — x>0 finite, y finite nonzero (the transcendental tail both
  // $math.pow_core (runtime y) and $math.pow_fold (compile-time-constant y) delegate to, once
  // their own special-case ladders rule out NaN/±Inf/±0/x<0/y==0/±1/integer-in-i32-range/y==
  // ±0.5). Ported from a from-scratch double-double/triple-double design (NOT fdlibm's e_pow.c
  // — that algorithm targets ~1ulp, not correct rounding, and the earlier fdlibm-ported
  // $math.pow_core missed 8.2% of the CR vector gate; see test/pow-cr.js), using a Ziv rounding
  // test to promote from cheap double-double (phase 1) to triple-double (phase 2) only when
  // phase 1's own error bound can't certify the final rounding. Design + derivation fully
  // worked out and differentially validated (5152/5152 gate vectors + 26k targeted adversarial
  // + 150k general-random cases, 0 misrounds) in scratchpad/pow/ before this port — see
  // pow_dd.mjs (the reference prototype every WAT line here mirrors 1:1) and its measurement
  // scripts (measure_log2_abs.py, measure_exp2_unscaled.py) for the error-bound derivations
  // cited below.
  //
  // ALGORITHM (both phases share this shape, at k=2 (dd) or k=3 (td) limbs):
  //   1. log2(x) to k-limb precision: bit-extract x=m·2^kexp (m∈[1,2)), look up the table
  //      breakpoint m0_j nearest m (top-8-mantissa-bit index j, LOG2_TABLE — 256 entries ×
  //      k-limb log2(1+j/256), injected as a linear-memory data table, see injectTable in
  //      src/wat/assemble.js — same mechanism as module/number.js's Eisel-Lemire/Ryū tables),
  //      then log2(x) = kexp + log2(m0_j) + log2(1+r) where r=(m-m0_j)/m0_j (|r|<2^-8, so a
  //      short Horner series converges fast — LOG_SERIES, Mercator ln(1+r) coefficients).
  //      CANCELLATION FIX: when m>=1.5 (j>=128), regroup as (kexp+1)+(log2(m0_j)-1)+log2(1+r)
  //      instead of kexp+log2(m0_j)+log2(1+r) — both are the same value (subtracting the exact
  //      integer 1 from a k-limb value is lossless), but the regrouped form never lets two O(1)
  //      quantities nearly cancel down to a near-zero log2(x) (x close to a power of 2): the
  //      naive form loses up to ~50 bits there since the k-limb fold's error is bounded
  //      relative to the DISCARDED O(1) input magnitude, not the tiny post-cancellation output.
  //   2. Multiply by y (exact-ish via twoProd, which Dekker-splits BOTH operands — no manual
  //      y1/y2 pre-split needed, unlike fdlibm/the old $math.pow_fold's c1/c2 params).
  //   3. 2^L via the same shape: round to nearest integer n (f64.nearest — IEEE round-ties-to-
  //      even, spliced back in via $math.pow_scalbn), then a 256-point sub-table (EXP2_TABLE,
  //      2^(idx/256) for idx∈[-128,127]) plus a short Horner series (EXP_SERIES, e^u
  //      coefficients with ln2 powers folded in) on the doubly-reduced fraction.
  //   4. ROUNDING TEST: eps = |y|·LOG2_ABS_ERR[k]·ln2 + EXP2_REL_ERR[k], applied as
  //      |result_hi|·eps to the k-limb result. LOG2_ABS_ERR is an ABSOLUTE bound on step 1's
  //      error (measured empirically, ~uniform over x — dd 2^-77.15, td 2^-148.2, before an
  //      8+ bit margin), scaled by |y| because step 2 turns a fixed absolute log2(x) error
  //      into an absolute error in L=y·log2(x) that GROWS WITH |y| — this is the term a naive
  //      "eps=|result|*E" misses: when x is adversarially close to a power of 2 (log2(x) tiny)
  //      and y is huge, |L| can stay modest even as |y|→huge, so bounding eps off the RESULT's
  //      own magnitude alone silently understates the true uncertainty by a factor of
  //      |y|·log2(x)/L. (Confirmed the hard way: x=1-2^-53, y=1e18 missed by 8 ulps under the
  //      naive formula; 0 misses with this one, across every stress set above.) EXP2_REL_ERR
  //      is step 3's own relative error (dd 2^-72.55, td 2^-156.9, unscaled — the final ·2^n
  //      splice via $math.pow_scalbn is a separate, already-exact staged multiply, musl
  //      scalbn.c, adding none). d(2^L)/dL = 2^L·ln2 converts L's absolute error to the
  //      result's relative error, hence the ln2 factor. PHASE-1 COST: the dd Horner series
  //      (steps 1 and 3) uses a CHEAP HYBRID — the dominant correction term is kept at full dd
  //      precision (one extra mulExt) but the rest of the series runs in plain f64 on the
  //      leading limb, since a fully-plain series measured only ~2^-69 (too loose for
  //      colorpq's own PQ exponents — ~47% phase-2 escalation there) while a fully-rigorous
  //      dd Horner chain (every term compensated) made phase 1 ~28x slower than the fdlibm
  //      kernel it replaced. This hybrid is the measured middle ground — see powLog1pCheapGen's
  //      and the exp2 P-series' own comments below.
  //   5. If phase 1 (dd) can't certify: recompute at phase 2 (td). Phase 2 is expected to
  //      ALWAYS certify (0 uncertain-after-phase-2 cases across every validation set) — if it
  //      doesn't, this returns its best-effort value rather than nothing (see the mission
  //      note: an uncertain result here would mean the gate found a case beyond what
  //      scratchpad/pow/ discovered, worth its own report, not a silent wrong answer).
  //
  // |y| > 1e20 short-circuits BEFORE any of the above: the smallest possible |log2(x)| for
  // finite x>0,x!=1 is ~1.6e-16 (x adjacent to 1), so |y|>1100/1.6e-16~=6.9e18 already forces
  // definite overflow/underflow — 1e20 keeps ~15x margin above that while staying far under
  // ~1.34e300, where twoProd's internal Veltkamp split (SPLITTER·y) would itself overflow to
  // Infinity and corrupt the multiply. x==1 is handled explicitly there too (pow_fold has no
  // x==1 pre-check of its own — it relies on log2(1)=0 exactly zeroing the product for ANY y,
  // which the main kernel already gives it, but the |y|>1e20 short-circuit bypasses the main
  // kernel entirely so needs its own x==1 case).
  const POW_LOG2_T = 8, POW_EXP2_T = 8
  const POW_LOG_N_DD = 9, POW_LOG_N_TD = 18, POW_EXP_N_DD = 8, POW_EXP_N_TD = 15
  // dd (k=2) bounds measured for the CHEAP-HYBRID phase-1 Horner below (leading correction
  // term at DD precision via one extra mulExt, tail terms plain-f64): worst dd log2 abs err
  // 2^-77.15, dd exp2 rel err 2^-72.55 over a 15k+-point sweep incl. subnormals/adversarial
  // near-power-of-2 x (scratchpad/pow/measure_log2_abs.py, measure_exp2_unscaled.py) — ~9
  // bits margin below each. An all-plain-tail version (no DD leading-correction term) measured
  // only 2^-68.97 / 2^-71.27 — too loose for colorpq's own PQ exponents (~47% phase-2
  // escalation measured there, worse than the expensive full-rigor path it replaced); this
  // hybrid recovers the needed precision for one extra mulExt (~35 ops) instead of the full
  // ~(N-1)-deep dd Horner chain (~300+ ops) it replaces. td (k=3) unchanged: phase 2 still
  // uses the fully-rigorous Horner (powHornerExt).
  const POW_LOG2_ABS_ERR = { 2: 2 ** -68, 3: 2 ** -138 }
  const POW_EXP2_REL_ERR = { 2: 2 ** -64, 3: 2 ** -146 }
  // Mercator ln(1+r) coefficients (r^1..r^18), each a 3-limb (hi,mid,lo) f64 expansion —
  // uniform 3-limb treatment (not just enough for dd) avoids per-coefficient precision
  // bookkeeping: a plain-f64 a2..a4 would itself cap the td rounding-test budget at ~2^-114
  // (worked by hand: a coefficient's contribution to total relative error is
  // a_i·r^(i-1)·(coefficient's own rel. error), and for i=2..4 with |r|<=2^-8 that leaves only
  // ~50-70 bits of slack from a plain double) — 3-limb coefficients remove that risk entirely
  // at zero extra runtime cost (dd just reads the hi limb). Generated by
  // scratchpad/pow/gen_tables.py (mpmath, 400-bit) — verified against the CR vector gate, not
  // hand-derived.
  const POW_LOG_SERIES = [
    [1, 0, 0],
    [-0.5, 0, 0],
    [0.3333333333333333, 1.850371707708594e-17, 1.0271626370065257e-33],
    [-0.25, 0, 0],
    [0.2, -1.1102230246251566e-17, 6.162975822039155e-34],
    [-0.16666666666666666, -9.25185853854297e-18, -5.135813185032629e-34],
    [0.14285714285714285, 7.93016446160826e-18, 4.4021255871708246e-34],
    [-0.125, 0, 0],
    [0.1111111111111111, 6.1679056923619804e-18, 3.423875456688419e-34],
    [-0.1, 5.551115123125783e-18, -3.0814879110195775e-34],
    [0.09090909090909091, -2.523234146875356e-18, 7.003381615953585e-35],
    [-0.08333333333333333, -4.625929269271485e-18, -2.5679065925163143e-34],
    [0.07692307692307693, -4.270088556250602e-18, 2.370375316168906e-34],
    [-0.07142857142857142, -3.96508223080413e-18, -2.2010627935854123e-34],
    [0.06666666666666667, 9.251858538542971e-19, 1.2839532962581572e-35],
    [-0.0625, 0, 0],
    [0.058823529411764705, 8.163404592832033e-19, 1.1328999672866093e-35],
    [-0.05555555555555555, -3.0839528461809902e-18, -1.7119377283442096e-34]]
  // 2^r2 coefficients (r2^0..r2^15): b_k = ln2^k/k!, so the series is directly in the reduced
  // fraction r2 (no separate u=r2·ln2 extended multiply needed). Same uniform-3-limb rigor.
  const POW_EXP_SERIES = [
    [1, 0, 0],
    [0.6931471805599453, 2.3190468138462996e-17, 5.707708438416212e-34],
    [0.24022650695910072, -9.493931253182876e-18, -2.4105486965696903e-34],
    [0.05550410866482158, -3.1658222903912804e-18, 1.1357423645400287e-34],
    [0.009618129107628477, 2.8324606784381e-19, 1.85284146980722e-35],
    [0.0013333558146428443, 1.3928059563172586e-20, -7.148318211080472e-37],
    [0.0001540353039338161, 1.1783618439907562e-20, 4.5910849836706486e-38],
    [0.000015252733804059841, -8.027446755055875e-22, -3.3547393057817446e-38],
    [0.000001321548679014431, -2.0162732323629023e-24, 1.2689094913973184e-40],
    [1.01780860092397e-7, -1.949520713756723e-24, 9.914912572246126e-41],
    [7.054911620801123e-9, -2.9110453965609406e-26, 1.2702853147779823e-42],
    [4.4455382718708116e-10, -1.2731051485060954e-26, 4.420326254448758e-43],
    [2.5678435993488206e-11, -3.6970912098302563e-28, 1.7132265077294294e-44],
    [1.3691488853904128e-12, 7.770795328665668e-29, 4.5200006429723875e-45],
    [6.778726354822545e-14, 5.7164033621144854e-30, 2.4988036368119357e-47],
    [3.1324367070884287e-15, -3.9318558140598756e-32, -2.0482463830537468e-48],
    [1.3570247948755148e-16, -1.057117616368963e-32, -1.512313747717571e-49]]
  const POW_LOG2E = [1.4426950408889634, 2.0355273740931033e-17, -1.0614659956117258e-33]   // 1/ln2, 3-limb

  // ---- WAT codegen: EFT (error-free transform) primitives, no FMA (Dekker splits) ----
  // A Builder accumulates a statement list (nested — if/then/else bodies build with
  // sub-scopes, `B.sub()`, and splice into the parent as `(then ${sub.stmts.join(' ')})`).
  //
  // REGISTER POOL (not one fresh local per intermediate value): `tmp()` used to mint a
  // brand-new WASM local for every single EFT micro-step — twoSum alone burns 3, twoProd 7,
  // and a k-limb Horner chains dozens of these per term. For $math.pow_transcend that summed
  // to ~7000 locals, and both the wasm engine's own compiler and jz's THIS ADD MADE
  // codegen/optimize passes pay for it: colorpq measured ~15x the old fdlibm kernel's time,
  // and a pow-using program's OWN compile time went ~0.1s -> ~4.1s. WASM locals are
  // function-scoped, not block-scoped, so distinct intermediates can share one physical slot
  // once the earlier one's last use has passed — a classic linear-scan register allocation,
  // done here as a two-pass token scheme instead of hand-tracking free lists at every call
  // site (that would be exactly as error-prone as the bug it's fixing):
  //   PASS 1 (this Builder): `tmp()` does NOT pick a real local name. It mints a UNIQUE ID,
  //   emits `(local.set \x01ID\x02 expr)` into the statement stream, and returns
  //   `(local.get \x01ID\x02)` for the caller to embed in later expressions — U+0001/U+0002
  //   control chars so a token can never collide with real WAT text or another token's digits.
  //   Text order here IS execution order (statements append in the order they run; the one
  //   place order gets locally inverted — a `(local.set TARGET expr)` prints TARGET before
  //   expr's own operand reads, though expr evaluates first at runtime — only costs a missed
  //   same-statement reuse opportunity, e.g. `x = a+a` not sharing a's slot with x; it never
  //   causes an early free, because freeing is keyed off each id's PRECOMPUTED true last-use
  //   position, not scan position — see powResolvePool).
  //   PASS 2 (`powResolvePool`, called once on the fully-assembled function body): scan for
  //   every token, resolve each id's real last use, walk the text again allocating a small
  //   per-type register file (separate pools for f64/i32/i64 — a value can only reuse a
  //   same-typed slot), freeing a register the instant its id's last use is seen. Mutable
  //   locals (below) are NOT pooled — they're few, and their whole point is surviving across
  //   sub-scopes, so they keep stable dedicated names exactly as before.
  const POW_TOK_1 = '\x01', POW_TOK_2 = '\x02'
  const powMkBuilder = (prefix, shared) => {
    // type is an ARRAY, not a numeric-keyed object: the self-compile kernel's
    // computed member access obj[numVar] misreads against OBJECTS (returns
    // undefined; the resolveOptimize LEVEL_PRESETS comment records the same
    // gap) — ids are dense and monotone, so an array is the natural shape.
    shared ??= { n: 0, type: [], mutDecls: [] }
    const stmts = []
    const tmp = (expr, type = 'f64') => {
      const id = shared.n++
      shared.type[id] = type
      const tok = `${POW_TOK_1}${id}${POW_TOK_2}`
      stmts.push(`(local.set ${tok} ${expr})`)
      return `(local.get ${tok})`
    }
    // .set returns the STATEMENT STRING (does not push itself) — a mutable local is
    // typically declared in one scope but assigned from several (if/then/else sub-scopes),
    // so the caller must explicitly `.raw()` the result onto whichever scope is active.
    const mutable = (base, type = 'f64') => {
      const name = `$${prefix}_${base}${shared.n++}`
      shared.mutDecls.push(`(local ${name} ${type})`)
      return { name, get: `(local.get ${name})`, set: (expr) => `(local.set ${name} ${expr})` }
    }
    const raw = (s) => stmts.push(s)
    const sub = (p) => powMkBuilder(p ?? prefix, shared)
    return { tmp, mutable, raw, sub, stmts, mutDecls: shared.mutDecls, type: shared.type }
  }
  // Pass 2 of the register pool (see the Builder comment above): resolve every \x01id\x02
  // token in `text` to a real, REUSED local name. Returns the extra `(local ...)` decls the
  // pool needs (concat with the mutable-local decls already collected) and the resolved text.
  const powResolvePool = (text, typeOf) => {
    // Manual \x01…\x02 token scan, NOT regex: the self-compile kernel's regex
    // engine errs on control-char escapes in patterns, so the two regex
    // passes here made EVERY crPow compile trap in-kernel (pow-fold /
    // fifthroot kernel-leg OOBs). indexOf/slice reproduce the exact same
    // event stream and replacement — byte-identical output, and no regex.
    const events = []
    for (let i = 0; (i = text.indexOf('\x01', i)) !== -1; ) {
      const end = text.indexOf('\x02', i)
      // slice-compare, not startsWith(s, pos): the positional arg is a
      // recorded string-method gap under self-compile (classified every event
      // as neither set nor get → empty pool → $pt_undefined_undefined).
      const prefix = i >= 10 ? text.slice(i - 10, i) : ''
      const isSet = prefix === 'local.set '
      const isGet = prefix === 'local.get '
      if (isSet || isGet) events.push({ isSet, id: +text.slice(i + 1, end), at: i })
      i = end
    }
    // lastUse/regOf are ARRAYS (dense numeric ids), same reason as shared.type:
    // the kernel's obj[numVar] object read is a context-dependent miscompile.
    const lastUse = []
    for (const e of events) if (!e.isSet) lastUse[e.id] = e.at   // last (highest-index) 'get' wins
    const free = { f64: [], i32: [], i64: [] }, next = { f64: 0, i32: 0, i64: 0 }, regOf = []
    for (const e of events) {
      const type = typeOf[e.id]
      if (e.isSet) regOf[e.id] = free[type].length ? free[type].pop() : next[type]++
      else if (e.at === lastUse[e.id]) free[type].push(regOf[e.id])
    }
    const parts = []
    let p = 0
    for (let i = 0; (i = text.indexOf('\x01', p)) !== -1; ) {
      const end = text.indexOf('\x02', i)
      const id = +text.slice(i + 1, end)
      parts.push(text.slice(p, i), `$pt_${typeOf[id]}_${regOf[id]}`)
      p = end + 1
    }
    parts.push(text.slice(p))
    const resolved = parts.join('')
    const decls = []
    for (const type of ['f64', 'i32', 'i64']) for (let i = 0; i < next[type]; i++) decls.push(`(local $pt_${type}_${i} ${type})`)
    return { decls, resolved }
  }
  const POW_SPLITTER = '134217729' // 2^27+1, Veltkamp split constant for f64's 53-bit mantissa
  const powSplit = (B, a) => {
    const c = B.tmp(`(f64.mul (f64.const ${POW_SPLITTER}) ${a})`)
    const hi = B.tmp(`(f64.sub ${c} (f64.sub ${c} ${a}))`)
    const lo = B.tmp(`(f64.sub ${a} ${hi})`)
    return [hi, lo]
  }
  const powTwoSum = (B, a, b) => {
    const s = B.tmp(`(f64.add ${a} ${b})`)
    const bb = B.tmp(`(f64.sub ${s} ${a})`)
    const e = B.tmp(`(f64.add (f64.sub ${a} (f64.sub ${s} ${bb})) (f64.sub ${b} ${bb}))`)
    return [s, e]
  }
  const powTwoProd = (B, a, b) => {
    const p = B.tmp(`(f64.mul ${a} ${b})`)
    const [ah, al] = powSplit(B, a), [bh, bl] = powSplit(B, b)
    const t1 = B.tmp(`(f64.sub (f64.mul ${ah} ${bh}) ${p})`)
    const t2 = B.tmp(`(f64.add ${t1} (f64.mul ${ah} ${bl}))`)
    const t3 = B.tmp(`(f64.add ${t2} (f64.mul ${al} ${bh}))`)
    const e = B.tmp(`(f64.add ${t3} (f64.mul ${al} ${bl}))`)
    return [p, e]
  }
  // absorb: ripple `term` top-down into a k-limb accumulator (array of k expr-refs) via
  // twoSum; the final carry-out (dropped) is ~2^-53k relative to the LARGEST term folded so
  // far, so a chain of these absorptions gives a k-limb-equivalent (~53k-bit) result.
  const powAbsorb = (B, acc, term) => {
    const next = []
    let carry = term
    for (let j = 0; j < acc.length; j++) { const [s, e] = powTwoSum(B, acc[j], carry); next.push(s); carry = e }
    return next
  }
  const powFoldK = (B, terms, k) => { let acc = new Array(k).fill('(f64.const 0)'); for (const t of terms) acc = powAbsorb(B, acc, t); return acc }
  const powMulExtDouble = (B, A, y, k) => {
    const terms = []
    for (let i = 0; i < k; i++) {
      if (i === k - 1) terms.push(`(f64.mul ${A[i]} ${y})`)
      else { const [p, e] = powTwoProd(B, A[i], y); terms.push(p, e) }
    }
    return powFoldK(B, terms, k)
  }
  // k-limb * k-limb, triangular (drop cross terms below k-limb precision — the standard
  // QD-library dd_mul generalizes cleanly to k limbs this way).
  const powMulExt = (B, A, Bv, k) => {
    const terms = []
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
      if (i + j >= k) continue
      if (i + j === k - 1) terms.push(`(f64.mul ${A[i]} ${Bv[j]})`)
      else { const [p, e] = powTwoProd(B, A[i], Bv[j]); terms.push(p, e) }
    }
    return powFoldK(B, terms, k)
  }
  const powAddExt = (B, A, Bv, k) => powFoldK(B, [...A, ...Bv], k)
  // u/v (plain doubles, u,v exact by construction at every call site — Sterbenz subtraction
  // against a bit-truncated table breakpoint) to k-limb precision via iterative refinement:
  // each pass forms the EXACT residual u-s·v (twoProd+twoSum) and divides it again, recovering
  // ~53 more bits per pass.
  const powDivExt = (B, u, v, k) => {
    const terms = []
    let rHi = u, rLo = '(f64.const 0)'
    for (let pass = 0; pass < k; pass++) {
      const s = B.tmp(`(f64.div ${rHi} ${v})`)
      const [p, e] = powTwoProd(B, s, v)
      const [t1, t1e] = powTwoSum(B, rHi, `(f64.neg ${p})`)
      const [t2, t2e] = powTwoSum(B, rLo, `(f64.neg ${e})`)
      rHi = B.tmp(`(f64.add ${t1} ${t2})`); rLo = B.tmp(`(f64.add ${t1e} ${t2e})`)
      terms.push(s)
    }
    return powFoldK(B, terms, k)
  }
  // Horner (highest degree first) over a k-limb variable, coefficients as 3-limb JS rows
  // (only the first k limbs of each are used).
  const powHornerExt = (B, coefRows, k, xLimbs) => {
    const N = coefRows.length
    let acc = coefRows[N - 1].slice(0, k).map(v => `(f64.const ${v})`)
    for (let i = N - 2; i >= 0; i--) {
      acc = powMulExt(B, acc, xLimbs, k)
      acc = powAddExt(B, acc, coefRows[i].slice(0, k).map(v => `(f64.const ${v})`), k)
    }
    return acc
  }

  // frexp: x>0 finite, in mutable local xLoc (rescaled in-place for subnormals). Returns
  // {kexp (mutable i32), m (f64 expr, in [1,2)), mHi (i32 expr, high word of m's bit pattern)}.
  const powFrexpGen = (B, xLoc) => {
    const bits0 = B.tmp(`(i64.reinterpret_f64 ${xLoc.get})`, 'i64')
    const hi0 = B.tmp(`(i32.wrap_i64 (i64.shr_u ${bits0} (i64.const 32)))`, 'i32')
    const kexp = B.mutable('kexp', 'i32')
    B.raw(kexp.set('(i32.const 0)'))
    const subB = B.sub('frs')
    subB.raw(xLoc.set(`(f64.mul ${xLoc.get} (f64.const ${2 ** 54}))`))
    subB.raw(kexp.set('(i32.const -54)'))
    B.raw(`(if (i32.eqz (i32.shr_u ${hi0} (i32.const 20))) (then ${subB.stmts.join(' ')}))`)
    const bits = B.tmp(`(i64.reinterpret_f64 ${xLoc.get})`, 'i64')
    const hi = B.tmp(`(i32.wrap_i64 (i64.shr_u ${bits} (i64.const 32)))`, 'i32')
    const lo = B.tmp(`(i32.wrap_i64 ${bits})`, 'i32')
    B.raw(kexp.set(`(i32.add ${kexp.get} (i32.sub (i32.shr_u ${hi} (i32.const 20)) (i32.const 1023)))`))
    const mHi = B.tmp(`(i32.or (i32.and ${hi} (i32.const 0x800fffff)) (i32.const 0x3ff00000))`, 'i32')
    const m = B.tmp(`(f64.reinterpret_i64 (i64.or (i64.shl (i64.extend_i32_u ${mHi}) (i64.const 32)) (i64.extend_i32_u ${lo})))`)
    return { kexp, m, mHi }
  }

  // CHEAP-HYBRID phase-1 (dd only) series evaluation: ln(1+r) = r + a2 r^2 + a3 r^3 + ... .
  // Mercator's series has ALL integer powers of r (unlike atanh's odd-power-only series, the
  // shape exp2's series shares — see below), so a plain-Horner tail's reduction variable is r
  // itself, NOT r^2 (an earlier version mistakenly reused the odd-series r^2 pattern here;
  // confirmed wrong against the mpmath oracle — it silently dropped odd-power siblings of the
  // r^2 term, landing ~2^-16 absolute error instead of the intended ~2^-69). a2 r^2 is kept at
  // DD precision (one mulExt for r^2 + one mulExtDouble by the constant) since it's the
  // dominant correction: a fully-plain series (a2 onward all plain f64, ~2 ops/term) measured
  // only ~2^-69 dd precision — too loose for colorpq's own PQ exponents (~47% phase-2
  // escalation measured, worse than the fully-rigorous dd Horner it was meant to replace,
  // which itself made phase 1 ~28x slower than the fdlibm kernel it replaced). This hybrid —
  // one extra dd multiply for a2 r^2, plain Horner for a3 r^3 onward (truly O(r^3), tiny) —
  // measured 2^-77.15 dd absolute error (scratchpad/pow/measure_log2_abs.py), recovering the
  // needed precision for a fraction of full rigor's ~(logNTerms-1)-deep dd Horner chain cost.
  const powLog1pCheapGen = (B, r, logNTerms) => {
    const r0 = r[0]
    const rSq = powMulExt(B, r, r, 2)
    const a2Term = powMulExtDouble(B, rSq, `(f64.const ${POW_LOG_SERIES[1][0]})`, 2)
    let Qtail = `(f64.const ${POW_LOG_SERIES[logNTerms - 1][0]})`
    for (let i = logNTerms - 2; i >= 2; i--) Qtail = B.tmp(`(f64.add (f64.mul ${Qtail} ${r0}) (f64.const ${POW_LOG_SERIES[i][0]}))`)
    const tail = B.tmp(`(f64.mul (f64.mul (f64.mul ${r0} ${r0}) ${r0}) ${Qtail})`)
    return powFoldK(B, [...r, ...a2Term, tail], 2)
  }

  // log2(x) to k-limb precision — see the header comment for the algorithm and the
  // cancellation-fix rationale. tblBase: WAT expr for LOG2_TABLE's injected base address.
  const powLog2ExtGen = (B, xLoc, k, tblBase, logNTerms) => {
    const { kexp, m, mHi } = powFrexpGen(B, xLoc)
    const T = POW_LOG2_T
    const j = B.tmp(`(i32.and (i32.shr_u ${mHi} (i32.const ${20 - T})) (i32.const ${(1 << T) - 1}))`, 'i32')
    const maskHi = (0xfff00000 | (((1 << T) - 1) << (20 - T))) >>> 0
    const m0Hi = B.tmp(`(i32.and ${mHi} (i32.const ${maskHi | 0}))`, 'i32')
    const m0 = B.tmp(`(f64.reinterpret_i64 (i64.shl (i64.extend_i32_u ${m0Hi}) (i64.const 32)))`)
    const u = B.tmp(`(f64.sub ${m} ${m0})`)
    const r = powDivExt(B, u, m0, k)
    const lnP = k === 2 ? powLog1pCheapGen(B, r, logNTerms) : powMulExt(B, powHornerExt(B, POW_LOG_SERIES.slice(0, logNTerms), k, r), r, k)
    const log2P = powMulExt(B, lnP, POW_LOG2E.slice(0, k).map(v => `(f64.const ${v})`), k)
    const addr = B.tmp(`(i32.add ${tblBase} (i32.mul ${j} (i32.const 24)))`, 'i32')
    const tHi = B.tmp(`(f64.load offset=0 ${addr})`)
    const tMid = k >= 2 ? B.tmp(`(f64.load offset=8 ${addr})`) : null
    const tLo = k >= 3 ? B.tmp(`(f64.load offset=16 ${addr})`) : null
    const tableEntryRaw = [tHi, tMid, tLo].slice(0, k)
    const kexpAdj = B.mutable('kexpadj', 'i32')
    const teAdj = tableEntryRaw.map((_, i) => B.mutable('te' + i))
    const elseB = B.sub('lelse')
    elseB.raw(kexpAdj.set(kexp.get))
    teAdj.forEach((h, i) => elseB.raw(h.set(tableEntryRaw[i])))
    const thenB = B.sub('lthen')
    thenB.raw(kexpAdj.set(`(i32.add ${kexp.get} (i32.const 1))`))
    const shifted = powFoldK(thenB, [...tableEntryRaw, '(f64.const -1)'], k)
    shifted.forEach((h, i) => thenB.raw(teAdj[i].set(h)))
    B.raw(`(if (i32.ge_s ${j} (i32.const ${(1 << T) / 2})) (then ${thenB.stmts.join(' ')}) (else ${elseB.stmts.join(' ')}))`)
    const kexpF = B.tmp(`(f64.convert_i32_s ${kexpAdj.get})`)
    return powFoldK(B, [kexpF, ...teAdj.map(h => h.get), ...log2P], k)
  }

  // 2^L to k-limb precision — Llimbs is a k-limb array. Returns {limbs: k-limb array of the
  // UNSCALED fractional-part result, n: i32 expr, the exponent $math.pow_scalbn splices in}.
  const powExp2ExtGen = (B, Llimbs, k, tblBase, expNTerms) => {
    const n0 = B.tmp(`(f64.nearest ${Llimbs[0]})`)   // ties-to-even, IEEE roundTiesToEven
    const n = B.tmp(`(i32.trunc_f64_s ${n0})`, 'i32')
    const nF = B.tmp(`(f64.convert_i32_s ${n})`)
    const negNF = B.tmp(`(f64.neg ${nF})`)
    const rExp = powFoldK(B, [...Llimbs, negNF], k)
    const idxF0 = B.tmp(`(f64.nearest (f64.mul ${rExp[0]} (f64.const 256)))`)
    const idxI0 = B.tmp(`(i32.trunc_f64_s ${idxF0})`, 'i32')
    const idxLo = B.tmp(`(select (i32.const -128) ${idxI0} (i32.lt_s ${idxI0} (i32.const -128)))`, 'i32')
    const idx = B.tmp(`(select (i32.const 127) ${idxLo} (i32.gt_s ${idxLo} (i32.const 127)))`, 'i32')
    const idxF = B.tmp(`(f64.convert_i32_s ${idx})`)
    const negIdxOver256 = B.tmp(`(f64.neg (f64.div ${idxF} (f64.const 256)))`)
    const r2 = powFoldK(B, [...rExp, negIdxOver256], k)
    const addr = B.tmp(`(i32.add ${tblBase} (i32.mul (i32.add ${idx} (i32.const 128)) (i32.const 24)))`, 'i32')
    const eHi = B.tmp(`(f64.load offset=0 ${addr})`)
    const eMid = k >= 2 ? B.tmp(`(f64.load offset=8 ${addr})`) : null
    const eLo = k >= 3 ? B.tmp(`(f64.load offset=16 ${addr})`) : null
    const tableEntry = [eHi, eMid, eLo].slice(0, k)
    // CHEAP phase-1 (dd only): 2^r2 = 1 + b1*r2 + b2*r2^2+... . Unlike log's series (odd
    // powers of r only, naturally a series in r^2), exp2's has BOTH parities of r2, so a
    // plain tail Horner runs IN r2 (not r2^2). b1*r2 and b2*r2^2 are kept at DD precision
    // (b1*r2: one mulExt; b2*r2^2: one mulExt for r2^2 + one mulExtDouble by b2) — b1 is the
    // dominant correction (ln2, not O(r2) small) and b2's term needed the same DD treatment
    // log2's a2 did (see powLog1pCheapGen's comment: a plain-double b2 alone measured only
    // ~2^-71 dd precision, too loose for colorpq's own PQ exponents). b3 onward (O(r2^3),
    // truly small) stay a cheap plain Horner on r2's leading limb. Phase 2 (td) keeps the
    // fully-rigorous Horner.
    const P = k === 2 ? (() => {
      const r2_0 = r2[0]
      const term1 = powMulExt(B, r2, POW_EXP_SERIES[1].slice(0, 2).map(v => `(f64.const ${v})`), 2)
      const r2Sq = powMulExt(B, r2, r2, 2)
      const term2 = powMulExtDouble(B, r2Sq, `(f64.const ${POW_EXP_SERIES[2][0]})`, 2)
      let Qtail = `(f64.const ${POW_EXP_SERIES[expNTerms - 1][0]})`
      for (let i = expNTerms - 2; i >= 3; i--) Qtail = B.tmp(`(f64.add (f64.mul ${Qtail} ${r2_0}) (f64.const ${POW_EXP_SERIES[i][0]}))`)
      const tail = B.tmp(`(f64.mul (f64.mul (f64.mul ${r2_0} ${r2_0}) ${r2_0}) ${Qtail})`)
      return powFoldK(B, ['(f64.const 1)', ...term1, ...term2, tail], 2)
    })() : powHornerExt(B, POW_EXP_SERIES.slice(0, expNTerms), k, r2)
    const result = powMulExt(B, tableEntry, P, k)
    return { limbs: result, n }
  }

  // Assemble $math.pow_transcend's full body — see the header comment for the algorithm.
  const genPowTranscend = () => {
    const B = powMkBuilder('pt')
    const xLoc = { get: '(local.get $x)', set: (e) => `(local.set $x ${e})` }
    const yLoc = { get: '(local.get $y)' }
    const logTbl = '(global.get $math.pow_log2_tbl)', expTbl = '(global.get $math.pow_exp2_tbl)'
    B.raw(`(if (f64.gt (f64.abs ${yLoc.get}) (f64.const 1e20))
      (then
        (if (f64.eq ${xLoc.get} (f64.const 1.0)) (then (return (f64.const 1.0))))
        (if (i32.eq (f64.gt ${xLoc.get} (f64.const 1.0)) (f64.gt ${yLoc.get} (f64.const 0.0)))
          (then (return (f64.const inf)))
          (else (return (f64.const 0.0))))))`)
    const epsExpr = (k) => `(f64.add (f64.mul (f64.abs ${yLoc.get}) (f64.const ${POW_LOG2_ABS_ERR[k] * Math.LN2})) (f64.const ${POW_EXP2_REL_ERR[k]}))`
    const emitPhase = (k, logN, expN, isLast) => {
      const Bp = B.sub(`p${k}`)
      const logx = powLog2ExtGen(Bp, xLoc, k, logTbl, logN)
      const L = powMulExtDouble(Bp, logx, yLoc.get, k)
      Bp.raw(`(if (f64.gt ${L[0]} (f64.const 1100)) (then (return (f64.const inf))))`)
      Bp.raw(`(if (f64.lt ${L[0]} (f64.const -1100)) (then (return (f64.const 0.0))))`)
      const { limbs, n } = powExp2ExtGen(Bp, L, k, expTbl, expN)
      const hi = limbs[0]
      const loSum = limbs.length === 2 ? limbs[1] : Bp.tmp(`(f64.add ${limbs[1]} ${limbs[2]})`)
      const eps = Bp.tmp(`(f64.mul (f64.abs ${hi}) ${epsExpr(k)})`)
      const lowerU = Bp.tmp(`(f64.add ${hi} (f64.sub ${loSum} ${eps}))`)
      const upperU = Bp.tmp(`(f64.add ${hi} (f64.add ${loSum} ${eps}))`)
      const lower = Bp.tmp(`(call $math.pow_scalbn ${lowerU} ${n})`)
      const upper = Bp.tmp(`(call $math.pow_scalbn ${upperU} ${n})`)
      if (isLast) {
        // Phase 2: return best-effort if STILL uncertain rather than nothing — validated 0
        // occurrences (see header comment), so this is a documented safety net, not a live path.
        Bp.raw(`(if (f64.eq ${lower} ${upper}) (then (return ${lower})))`)
        Bp.raw(`(return (call $math.pow_scalbn (f64.add ${hi} ${loSum}) ${n}))`)
      } else {
        Bp.raw(`(if (f64.eq ${lower} ${upper}) (then (return ${lower})))`)
      }
      B.raw(Bp.stmts.join(' '))
    }
    emitPhase(2, POW_LOG_N_DD, POW_EXP_N_DD, false)   // phase 1 (dd) — cheap common path
    emitPhase(3, POW_LOG_N_TD, POW_EXP_N_TD, true)    // phase 2 (td) — rare, always returns
    // Pool resolution runs ONCE over the whole (both-phases) body — phase 2's pool reuses
    // phase 1's already-declared registers for free (phase 1 has unconditionally returned or
    // finished by the time phase 2's code runs, so none of its values are still live).
    const { decls: poolDecls, resolved } = powResolvePool(B.stmts.join(' '), B.type)
    return `(func $math.pow_transcend (param $x f64) (param $y f64) (result f64)
      ${B.mutDecls.join(' ')} ${poolDecls.join(' ')}
      ${resolved})`
  }

  // LOG2_TABLE / EXP2_TABLE: 256 entries x 24 bytes (3 little-endian f64 limbs each) —
  // log2(1+j/256) for j=0..255, and 2^(j/256) for j=-128..127 respectively, computed at
  // 400-bit precision (scratchpad/pow/gen_table_bytes.py) and decomposed into a 3-limb
  // (hi,mid,lo) expansion. Injected as linear-memory data tables only when
  // $math.pow_transcend survives reachability pruning — same lazy-table mechanism as
  // module/number.js's Eisel-Lemire/Ryū tables (src/wat/assemble.js's injectTable).
  // Char-array + one join, not `s += chr` — the concat form allocates ~n²/2 bytes
  // of dead strings PER COMPILE (see module/number.js hexToBytes; these two 6 KB
  // tables alone cost ~38 MB per compile inside the warm self-compile kernel).
  const powHexToBytes = (hex) => { const chars = []; for (let i = 0; i < hex.length; i += 2) chars.push(String.fromCharCode(parseInt(hex.slice(i, i + 2), 16))); return chars.join('') }
  ctx.runtime.powLog2Table = powHexToBytes('00000000000000000000000000000000000000000000000077ac7a6dc409773f11be24496fb6123c3b347080dd8794b85108efb650fe863f545e00ec8de32f3c1b6e1364c677b7b80c7ba9173136913f5244249b06ed323c2a1c23cc79b1b1382ad2c28596e7963fbd9f7b0776643dbc240d89569f6bd0b8860f85ba63939c3f4fd3c53da09b393c4625f31f589fceb8133413d5d11ca13fb96c05fbba7e22bc4c51f7bfdabcc438265a689430eda33f94c41fb8a513303c793aa68b0ca5de3887fd8e75d3baa63fe15b4b78039b383c47694326e7dbdeb8945149c3bf85a93f84de43ed3828483cf3f7d42fc9c7d5385fab0ab9fa4dac3ff088332c0f0e16bcabfd82b1d22bb438a05332838913af3f941a1251be8c47bcbd52d1caebcbde389b9fa29f38ebb03fb89951d1220c53bcc8f350916b06f7383d5a137e5b4bb23f6982ba324c975dbc5a236e632449ffb8c3f127dd2faab33fcf5af27697fd43bcf1f84223b5a9dd38b73b0336b807b53f962e4b42968645bcc3a726e5b1a7d0381613c9faf663b63f165198e014335f3caa60f0b586a7e4b881a2b896eebeb73ffaa11a19d7204e3cc6f7e155cfe6e4385b33466ea118b93f1793ac6d736354bc7864eca6dc37d7b8948434df1171ba3f2c3dc4e1a7bb34bcc015918a7db6d3b8baabad4042c8bb3f5f46b969b1ec583ceff73abe6978f4b8da825be3341ebd3ff9f2c83cce42533c5c0a5ab00caff838b2a57f11ec72be3ff229dcd9b5bd3c3c269c2dee50a99338a5000b0f6ac6bf3fc8bd1ae7b2ec5bbc650e64f59a00f9b8e479da8c588cc03fabd60be410766abcf915400c2b5407b92e0689b4e134c13fa5990dfe7d4bf9bb7d2ad8d3216153b87b2b5597d1dcc13f580e1e0c15a9673cb48ad47da875053940a6074b2984c23f75f7d6545da26cbcfa5e49a32e63d9381aae78e2e92ac33f4ca775c0f2514f3cce4e3bb09a6ce6b8648a9a6d14d1c33fd6b8a9e091e93fbc75ebf8dbb645deb84df783f9a976c43fb61fb2a0749c583ce9c4c7b3adeec3388a5c7a90ab1bc53ffffd1626022c623ca7ad823d61350ab988d6fb391ac0c53f5d7e7d3bfd1768bc175706c3b68be4b81613c9faf663c63f165198e014336f3caa60f0b586a7f4b87f02efd44207c73f3ebf6b7d0ee0543c8fb96547d9baf2b8df5dd0c7fea9c73f73e823be64033dbce83e96073d3dd2b8b3032fd02b4cc83fb5e2c488db6e11bc056a892605e1b1b86c2b35e8caedc83f93d99a79af8c62bcc54f06e9bdd5fb38df707e07dd8ec93f5cb9486574d6173cacc5ecec97067ab86bb82023632fca3ff0426d6cbde35abce5070ddc7ac5ed3894ecb42d5ecfca3fcae73f34e11e40bc0a755f41905ada38e9955f17cf6ecb3f1fed8b3363fb6a3cd85d40b152cdbfb8ee4dd9cdb60dcc3ffc7326669b38603c4b467ddb2794f7b8c90d773c16accc3f72b8d369cd4e6abc806de7e032de02397059324cee49cd3ffde27e4da5855bbcaa9696fa807cf7b80f48b1e33fe7cd3fbee1328cbd414ebcbcc95491b201bdb84d6a4ee70b84ce3f1e087115061b5cbc60b030556103efb8278f20395320cf3f3b63cc994add613c102efc634c070bb90a6802b916bccf3f78c253cc6cd4513ca5245261b641f9b864064da2ab2bd03f080bd6a4173a71bc2da3b9354c8316390930b0db0a79d03f1755679ac6c07b3ce15b7bbc9e99f4b88f2a547529c6d03f80f4f91638c176bcd26695fc04a30e39760bd3da0713d13fd952c3d2477b6abcfa87cdb933f80339ff08bb76a65fd13f19074f118e5f763c18de3de5e230e03870f091b205acd13f28e3b7e11ca3743c2d27cdb11d061a39138ed8f625f8d13feae6fb6934f4653c90705860f1fc0db93a070eab0744d23fffec16ad916e7fbc9d5879e10b11f0b88326b335ab8fd23fe68b905ae8c0783cee68dcd263041fb9af9a4dfc10dbd23fcf1b638fdec47b3c8c0b388be38e0b3936286b633926d33f84aac40f074779bcbfab01bd18770cb9edcda4ce2471d33f09fcb449663763bc61f47613e486f138fbdca1a0d3bbd33f2e67c98b3c9f7abc0a3c205ca8401d3949041b3b4606d43fcd4809d1bc6c7d3c2a8a0790f35e1239c44fddfe7c50d43f47ce00d897ca7abcd53ea5dd0d110eb98b1bcd4b789ad43f02250b90406d1bbc2107a84e9accb2b86afbe88038e4d43f7e15e9f4380a31bcdcfc34744a96c738b3964cfcbd2dd53f6df28739d8737f3c963cbcdfbdcb1239cb78331b0977d53f1dfbc4941fbe73bcc16aed90a11a173988d6fb391ac0d53f5d7e7d3bfd1778bc175706c3b68bf4b8ae4829b4f108d63f90e6b762fc437abc229eb942275c0139a77b67e48f51d63f6761371287dd5abc3aa3d2812e2dfeb8b8d48c24f599d63fbf2d0d1552317a3cf76c79d8b07900b9de0c9dcd21e2d63fc13dd18254e3753c9b5fdf0e6cdeedb883c1cb37162ad73ffe57d79ac9f27abc298095e3a6b60ab93cfb7ebad271d73f58dbed2a13905bbc7c586bcf6d78acb8c4aa51ac57b9d73f1973fbf4dbd8753c9ba604e122a91c39541c1663a500d83fbd6ffa045b57693c92fc8dbdb01109398e61d833bc47d83f50788d88b51f6cbcdb586a5764280e3926b2e0729c8ed83f59c9cdd666d276bc0d389238c13bf5b872c3b57346d5d83f029394b6bd3075bcace6ccd843b3eb3809171f89ba1bd93f591ea5be52d372bcbabea8db8561f5389c402705f961d93fcae648a198c27cbcd8d85468593e15392f231e3902a8d93f61ca2187b65d6a3cae856f613cdcf5b8e0259b75d6edd93f4d548ec138c97dbc6e4615f85919fab851607f0a7633da3f4f181acaefa078bcce5307c0dc1f1b39f4bef746e178da3f12255c6a81a0743cd9092cebb25310b9491f7f7918beda3f433aa7aa8d5b5ebccfaf2a3d6e78fc383464e0ef1b03db3fbbc3aeb00598793c01fb7d4ab51aef38a18238f7eb47db3f769dc041e4fa76bc1ca17fb58e54fcb87a86f8db888cdb3ffcdad1a788327abc185ec9d84c6917b93190e7e9f2d0db3fa5fb37c7f42e75bcccb6f58b4853e438e6ca246c2a15dc3fdd6b5ada1aed6fbc6cd3c85eb27dfd38565b29ad2f59dc3fccbcbb52b99f7f3c8f98615681a70839b447caf6029ddc3fefc12b2e1c4066bca759ba2e38380db97d583a92a4e0dc3fd32f8ce87a516bbc3256b5de8fea0bb97df20bc81424dd3fd2532ab56f85743cf6de402f466a19390fea32e05367dd3fadaafa661e141cbc41b70b733ebfb638b94f062262aadd3fb7115671a574123cfb166c7b12c998b84c3642d43feddd3f417c4558c6ae733cb148e84eb38906b99872093ded2fde3fab4274ae4ae44b3c4eb0ef05d239e738d254e7a16a72de3f26e2e8253ca3483cead4eb46d1abe938ce5bd147b8b4de3fedf5807972f9743c67dcd35f8f3c1db920e22873d6f6de3f05410e6a80477f3c052b89cc18e01bb941c5bc67c538df3f95a09716e48067bc6c9170aaa87df0b8cf06cb68857adf3f85d7fd3f67f368bcfeab6d06a572f3b80a6802b916bcdf3f78c253cc6cd4613ca5245261b64109b99bff839a79fddf3f1e1df432e08c71bc9c7b522da1d31db9e0647227571fe03fb3d35c08819a5bbc22e19f1dfab4f5387f99978bda3fe03fd7b302321aca793c965b13a96a1a1cb9b24ef2194760e03fe1bf9c8f8f4c7f3c7774560493da00393d707ff29c80e03ffb604507cf96843c14119e661e3d2cb9fce1f834dca0e03f7d89a14939f97fbc8c408a347a691ab9a63ad60005c1e03f97d8a6d49520863cbbd3507e50152e39117c4d7517e1e03f25fd24caabae633c59dbf2681135f9b8eac853b11301e13f39eb9b6b37c78e3c9aab6d4d3bad273907189ed3f920e13fa3e922b068a5763c11edb582d0dcf6b844e5a1fac940e13feda773b5967a88bc144f94a8b57b2ab906e095448460e13fbb9cf58f372b4e3ce14b4924263defb86a9772cf2880e13fcd14455f3aae833c64118711066328392124f3b8b79fe13f560d30d570588c3c1cdd0facd6ea23390ed0951e31bfe13f79322356ec4a6cbca4a92aa782e3efb8a6bb9c1d95dee13ff71dc7864c7a683c06826616e9c1053926810ed3e3fde13f3c11ce515790803c66b2444f756321399ad5b65b1d1de23ffe5085167aa8783c1ce5b612371907b9c82727d4413ce23f271053c3981d503ce95ac3f97f91fd38043db758515be23fd3234640a3a1853ca1ab3dd3bdddcf38f8cb85054c7ae23f7dba8e833be1453cbedcc5d20357c4b8601579f63199e23fcce24577f67c843c172f390d4111e738d17a3f4703b8e23f5d7e7d3bfd1758bc175706c3b68bd4b880135013c0d6e23f00152f8a532a893c1fdc538c184f18b9263feb7568f5e23f129369d18c27643cb276d8e56f160db9f2361b8afc13e33f5ba380201df97c3cd64c3f7a65591639a79cb46a7c32e33ff0de02fd36ca7bbc0c06dc6e9e93f038d9075732e850e33fad9c236c369367bc7f05fdde145dd13862916dfb3f6fe33f367354a8dc11803cde84334f45d82c39095d2fe0838de33f74c573e1f00d743c609be325b09519396721a0fab3abe33f837d8bdfa69a79bcc0d5ca39c6bd12b912ae9064d0c9e33f037548d90a66713c395785b1a416e5b816709f37d9e7e33fb25469eba9b88a3c2480d0cf4fca22b9bcf4388dce05e43f3155354ed01264bcdee718dd34b4e038a96a987eb023e43f13ab5274d8c1893cfdb1b510c36428396521c8247f41e43fba5e598d949384bc7b14b14bad8625b93907a2983a5fe43f4563f60700ca86bc1fec8214717c25b98725d0f2e27ce43f765b20176fbc6cbc592f4b2d8401cfb88b1bcd4b789ae43f02250b90406d2bbc2107a84e9accc2b89597e4bbfab7e43ffc88584319168f3c96bfee6e01c826b9c4ce335b6ad5e43ffd1c66fe7b9b823cc0eb11bc6f3c2a393ef3a941c7f2e43f2a41e0c21fd48d3c4aeb6c47e4ca2439f9a808871110e53fcb6e3a645b0b71bc96b1cdc5ea3a1cb90979e442492de53f872a21e126bd833c0fe501f3ef482c398e43a58c6e4ae53f2f511567cd9383bc4e72080bce8407b92cb0867b8167e53f2e0ceeafe9c58e3cb79888f79702f438349d98268284e53f524bb9163a397ebcf31c237aa74408395c8dbfa470a1e53f128e3e7941e3753cce6c6e1b142201b93514b50c4dbee53f6a77b73f304585bcf8b9740a80fc2c393c41087517dbe53fd1bddaea9170823c246ab064e3a12e39af091ef4cff7e53fa8cce84f39cd81bc3421d8c8d74e133909b131a07614e63f757150e4468c89bc39d6d6a7fea41c394830558f0b31e63f0079c785961a803c93dc40242a991939f09b71d78e4de63f5b7ae1bf03e189bc162fc6fad21e2539cc88478e006ae63f688d375e926879bc951ea4e7f0880a39876f6fc96086e63f0863be0edcc57b3cab6f8436246a02b90a0f5a9eafa2e63fcd17e4e52a13503c63d242f484abe7b8aecd5022edbee63f44d085404f15573ccaeda1d38b17fcb84a19766a19dbe63fed4ae5c0074173bc907c7c6d7869e83818c6c58b34f7e63ff11a37c3035e86bceff8b79f00162a397c6c159b3e13e73f8eec374280e96abca590e5638bf30a39b0c514ad372fe73f6b58d0c874317abc5e8018b59c37fab854074ed61f4be73f9b5717e0438d7cbc6410c80351581cb9ee3d262bf766e73fe3445acca40e79bcb2b3cc56aad4183957a6ddbfbd82e73fa9aa97841ff28e3c6a61907b62d30739200690a8739ee73f359d5b12b6997dbc9627f17d649010b9e40235f918bae73ffe3843fe6ed5533c9fcab70049eaf7b8a478a0c5add5e73f2b94a6ec8e10803c6cb1db0274ad0e3916cf822132f1e73f0aca0044996877bcc710352dacc002b9f94d6920a60ce83fcfe408da2e777bbc69d61732359a1cb97370bed50928e83fc61e9eecfd1172bc579fdd769b4b08397437ca545d43e83f3c9ef37c620c82bcbd53ce5e01582e39267bb2b0a05ee83ff6a164e8fc86603c2d47bb03261b0ab9713b7bfcd379e83fe437c2d7fd6680bc5558ec831c1104398bef064bf794e83fab46f6b1a81b803cec5de7ffc5170239a9d416af0ab0e83f66bc3a4772936ebc67c36537994b04b9be3b4b3b0ecbe83f9139815edd2583bc662c2a03fe40fab861d6230202e6e83fe7fffaf34f058ebce5c2d57efdde2ab9cd020016e600e93fd7e7827bafc02bbcf027ceedad06ceb809171f89ba1be93f591ea5be52d382bcbabea8db856105392faba06d7f36e93f91bc0893e6cd88bccbfceb62785015b9e3e284d53451e93fbdf7d66e1ed3893c9d0c9c36425429b9f6b5acd2da6be93f21b9ceeab61360bccb7764f9653bb7382f38da767186e93f2888c1bea6ac8ebc406dd1df2375283950e0b0d3f8a0e93f1a68a15a46b570bc8d6ba4053bc6ec384dceb5fa70bbe93fcd12e6cdd8f48ebc7e24784e1d692439b31050fdd9d5e93f9f201d485699893c20951ae31ca1163956e9c8ec33f0e93f8c0022383473843cf72a91eb42b429392d114cda7e0aea3fad307e44d1ce69bc702c58ab6e9ffcb877fbe7d6ba24ea3f755665fb7d4685bcd385e0ef5e3e0f391f188ef3e73eea3fb6f4ae7239c377bcac2756dcc9840539641513410659ea3f615ec42b3ff3723c050953d2b0ad0539c8202fd01573ea3fdb7d04707daa80bc5efe989afe291a3945277eb1168dea3f5fbc1e68cd5183bc2702d97631cd2039d31480f508a7ea3f83c81af28d378f3cb388bd7d6b3324393b1399acecc0ea3fa83c6a749e1e743cdf8cb825035f103933c811e7c1daea3f0446284fe95477bc3e1518d1a3add5b8d69217b588f4ea3f40053c5a9c2285bc6a3c4f1b236f16b96cc8bc26410eeb3f657bf258892c74bc9be263b24582f8b88af0f84beb27eb3fe039978dacb5813c39717c469ac9f1388c00a9348741eb3f04094138a34373bc8c5eb6705eb3183966968ff0145beb3f8af0e29f617969bca36a7364a6910bb9da32558f9474eb3f328ecd50dcd2823c24674ff4c13121b909738820068eeb3f2207b1253b3a6d3c7783398bc47a013964499eb369a7eb3f195d29bcfdf05d3c91da8d264765f0380636f257bfc0eb3fc2663452b28a8bbc0b619135c20016b96e7ec61c07daeb3f4b26fb7d48ba82bc99bb8e64fe4c15b9a764441141f3eb3f98120d122ec880bc12d26ec7b7621c39d35d7c446d0cec3f181d57696ab6883ca9fa0f5fd12323b9294866c58b25ec3fe421be5f902085bc5cfda2344d0aecb855a0e1a29c3eec3fd8db24a7c5b4793c6404f112870ff83858b6b5eb9f57ec3f21885cbb346b77bc2c8dd898b28b0839c7e191ae9570ec3f321123c6262f883ca757ad98fd1813398eb50dfa7d89ec3f45b4b56827338ebcc59293d5a4cd05b91633a9dc58a2ec3f845560c871ff7a3ceaed46e7a7e707b9f6fccc6426bbec3f650beb3ea14c84bc8c4b723d8263d1380789caa0e6d3ec3fa99d75b745de7ebc38536df498741d390352dc9e99ecec3fc21d1c8244ea34bcf1276543cc97c2389608266d3f05ed3fea3970d725c68c3c397d4a1509362639f1c3b419d81ded3f618abf846e6c7bbc52967f81e85dd1b8d5317fb26336ed3fc756dad61bbc743cbed589c694ae02392bc66545e24eed3f95b6ab8a134983bc4472bd382730d8380fea32e05367ed3fadaafa661e142cbc41b70b733ebfc6386c2a9b90b87fed3f3e7a5e000ae4813c6816c627539bdd3815663d641098ed3ff4dd5c8afc1d7ebc37fbf11ca96b16b965fba2685bb0ed3f4157db0f051086bc56bfa336022415b96cf53fab99c8ed3fc610b5aece99873c4a43f49e7ece1839a4387339cbe0ed3f076449764fa1893ce078ad79fc952b392caf8620f0f8ed3ff42a1a0fd2fb823c12457dae837b25399674af6d0811ee3f1127236d46f6743c6ad25a250dd512b940010e2e1429ee3f53bce367aaba6f3c365de723eef605393d55ae6e1341ee3f526182b3fbe46a3c726973fdd2e1f3b8ce22883c0659ee3f9bb16e6a4486853c8418f66d2bd0fb386ff87ea4ec70ee3fdbac353308d469bcbb876170a7fc0c39736a62b3c688ee3f22f8030e977785bc4ac7071b50511c393a3cee7594a0ee3fb0136e2f2ac661bc74a9d9e5ec5808b9fb88caf855b8ee3f1e6177ceb8965a3ca19ca5358cfff2b823ec8b480bd0ee3fedcfc0d5f1c3853c77915b9723432eb950a9b371b4e7ee3f22bd9f7c705b8f3c5681bfee5c86fbb8e4d3af8051ffee3ff028ad2566d87cbc75f354baab9716b93076db81e216ef3fb6af1046c9907d3c180dd176e53df5b845b87e81672eef3f944297b35d84553cad04dc0df604f6385506cf8be045ef3f08c13df95693833c866b8ceab3e007b9be36efac4d5def3f50b2c2cc7743873c26d77b68f1bc2039aeafeff0ae74ef3f7c394ed0242f74bca5acdbec3b0b0f39698cce63048cef3f333da705926b8cbc6e234642e55f2bb933c277114ea3ef3f9fd3b5e7a2a4883c99d69a522bdc26b9df44c5058cbaef3f85142fff53d77f3c37b8092cdfbef438f92a7f4cbed1ef3f0d44837388ac803cbadcada742ae0339a0d15bf1e4e8ef3fb42d1722f1ec723c88907f3167a61eb9')
  ctx.runtime.powExp2Table = powHexToBytes('cd3b7f669ea0e63f5664b21334dd8bbc75c1de3a3e7d25393e1775fa52b0e63f0e9d9a2cf5386a3c186d6259ba6bf938bfda0b7512c0e63f0d0bff67568962bc196c76585cefff384576d4dddccfe63f0973f1b6a97a8c3c9e7de927cb80f8b82f1a653cb2dfe63fab883c683abe5bbc78e7bb8af859ba38e53a599892efe63fb2c81a9e74b980bc90d12acab38d0ab9849451f97dffe63ff60e86250f3c78bc6e954a3f920100b9872ef466740fe73f5fa65ad444d6493ca1a2478fa89cddb8745fece8751fe73f997a8886476e71bcc3a45369796912b98ad0ea86822fe73f722cd62ca00a82bc87af0b7efb8d18b97481a5489a3fe73f3cd5656cd9a880bc68a7f317e22a2839fdcbd735bd4fe73f1c6e8a61fd47803c04b9ad3f03422b39c9674256eb5fe73fd36d3157592480bce8e519fae7f828b9096eabb12470e73ff847911677788b3c93b1e7d1c5b9eeb83f5dde4f6980e73f2d16020ab866883cf7327930424d24b9f61cac38b990e73f3eddaa62a849833c5fbd4fd609b100b98701eb7314a1e73f2f9904ee771574bcd4102d937a21d4b8dbcf76097bb1e73f88dc6884b5eb8bbc6dc00b4b750313b932c13001edc1e73fd64d16d14c128f3c03bbc26c234d2db9f086ff626ad2e73fb4b872fbdbbd813c8c6f94b65eda29b9624ecf36f3e2e73f7e7915ba025d603cdffcf827140ae73891c4918487f3e73fae1193cf117f70bcffb785360b9f1139121a3e542704e83f2b976d62867c82bc6eb1c9710d4e1d39d906d1add214e83f4d1d150d3764843c77d261654d692c3913ce4c998925e83fd83215d41d4c8dbcc1bacb65adf6e038f741b91e4c36e83fd52bdf319a9b893c8b2005ab00511e39adc723461a47e83ffbcd41a384d678bcd1ef165ce19115b9215b9f17f457e83fd016b2f848a74bbc90ee2ee7e658ea38ed92449bd968e83fbaf6d49bf8c68fbc21d98151f6161fb936a431d9ca79e83fbd47dbd2d7d2753c1fa99ec1799607b999668ad9c78ae83f3ab57cf3c294893cde85f33e28612d390f5878a4d09be83f2b20754495538d3cf40038928efd2fb9dba02a42e5ace83f274b8656f1e9863c336383a7440603b97817d6ba05bee83f6e4443fc5ecb8e3c607ef4b4f14e2e398c44b51632cfe83faae3e9325ed560bcd69d83dbb3daf3b8d966085e6ae0e83fe6b2c96f4a1187bca37c34ae62d1213936771599aef1e83f6c97e3a213cc753c6351b8d226bfc3388a2c28d0fe02e93fd23ffe85ca92853c7a400aa6ecaa2939c6ff910b5b14e93f2425582e79d68dbc4a53045285031c39e22faa53c325e93f7fdb39a65f4573bc430b22ab9a041ab9e5c5cdb03737e93fbc7eb581c75f57bcb20dac57e297f638e5985f2bb848e93f992d7d79d6c37dbc0b7e50ed82a614b90f52c8cb445ae93f39f0a5967c4b66bcbb8ba9c95370d0b8b370769add6be93f96c8197f96a54bbc2911a0e23348ec38504ede9f827de93fd1851b7c5b188dbc6f4b14d7b9ed2739a2227ae4338fe93fed784ca2daab6c3c12c377c8c22e0fb9ba07ca70f1a0e93f32e6ce91bd7381bc5f965478985300b90dfe534dbbb2e93f18d5f64d4ed88dbc314b18fee4670f3990f0a38291c4e93fbef271b0467c6c3c5c0843796b370639d5b84b1974d6e93f3382dda3be1685bc98c691ebba1905b92323e31963e8e93f6e4ce678ca24683ce0ba2b082cf9a0389ef2078d5efae93fcefaf1aacea974bc5d7888fce6f0143965e55d7b660cea3f33d51c5d495983bcfbb4514508541339bbb88eed7a1eea3f0ee78bee18668c3cc0782db72f7f2b39332d4aec9b30ea3fab36dc7d5c30863c176dc222fa472539d80a4680c942ea3f20b19f5880a78abc8391d8419e6e2db95d253eb20355ea3fe1418ddb6e2f8dbc483fd6df7afdfbb85260f48a4a67ea3f66036730560f553c750452ee9686eb3858b330139e79ea3fc763c5ca7ecb8b3c51f77631697826b9592ec153fe8bea3fa915bab267f884bc76a16b560d1f2039bffd79556b9eea3f31fdf70ec9fa803cb98c9ee36ab11839ba6e3521e5b0ea3f4545e9da319c783c71d9f0903bf40ab97af3d3bf6bc3ea3fd06ce7ca34927fbcf89676fcdb60fcb874273c3affd5ea3fe5b8b1b63bef873c842b2fd1551a23b9add35a999fe8ea3f81cc5d34cda1873cea75e63abc7f2a39fff222e64cfbea3fcd5e310ffcb284bc302f93a6d252223966b68d29070eeb3f25e4804cf5de8bbc0056c595bb1c143952899a6cce20eb3fcc56074a02dd843c9e8c92f6da8328b9fb154fb8a233eb3f08d784305e8052bcd9a4dd0ebcbaf238b149b7158446eb3f907cdfe93d766fbc6ff5f31c40e5f3b83a59e58d7259eb3fe36dbabbdf718cbcdff71d087074fcb82ac5f1296e6ceb3f6e3f8852f3a8823c6298a998eea11739475efbf2767feb3f3bac547e4f5865bc72abe18144a6fa38e44927f28c92eb3fc665cb5416728bbc672431d91e1115394a06a130b0a5eb3f2e29540ed3fc8ebc673c5091bfd1dab81f6f9ab7e0b8eb3f056269c9d1522fbc882005b899b4b1b8d2c14b901ecceb3f849e2d7ad03d723c58120e0564a1193907a2f3c369dfeb3f525bea6023262cbcff8465c2b82acbb8091ed75bc2f2eb3f739c6b3fcafd8ebcda59cdce817e02393db341612806ec3f34cafba15a8a7dbc9546df0f5dfd06b99c5285dd9b19ec3fdd4850896510713cda285912519e09392c65fad91c2dec3fd7a5c81716e586bcdee5ea370eaf05b97ad0ff5fab40ec3f0ac683e037458b3cf8f470facda6143922fbfa784754ec3fafb59324072f813cac83f5444e6317394bd1572ef167ec3fad3c48ff4d88823cb25c9d324cc41fb933c98889a87bec3f595525bebb767ebc00b57558843902b9b5e706946d8fec3f445c8048bcac613cfab800c1aaedf638dbc4515740a3ec3ff5080dd1bef277bc5a5894cc3352c4386990efdc20b7ec3fdb49e9d1cb03653c2e036b5665870d3975166d2e0fcbec3f939000860f226dbcb3b373e724040e39fac35d550bdfec3f729d82533bd87dbc4920743a07eaeab874ab5b5b15f3ec3f57ff6db8e9088abcf76dba56fe4307b97c89074a2d07ed3f9c7a794337bc8cbcf6a09d0344702eb968c9082b531bed3fee369a213656853c73cd11c6e66c29b9f2890d08872fed3f78859d717b488dbce7faa9b262daf238d6a1caeac843ed3f14165abf53db833cf7567a10bd20243987a4fbdc1858ed3f07375bd702ed723cfc3155b053b0fab8d3e662e8766ced3fa065814a7ae84f3cff759cf50117cb389883c916e380ed3fe8dfed8bc11e81bc5a76c87a4ed00eb97560ff715d95ed3fbef69abb2d058a3c14204926c50d23398532db03e6a9ed3f32b56d6900238c3c15c60e6f24f6273915833ad67cbeed3fe48b6b92f1768bbc2d61e6118f8320b960b401f321d3ed3fc318f07857da823cf31c66adde6c2cb958061c64d5e7ed3f8fba798e52a58cbce15e2b82fdf914395f9b7b3397fced3f5c4b184fcda581bcd6ef44a925722b39177d196b6711ee3f447f5cbd29b562bc2a07a59c3086033929a1f5144626ee3f96147a8127b687bc9a408c8018982bb912ee163b333bee3f8bc6fd31a4f489bc84c79e916db82839f63f8be72e50ee3f8fcca980899e733c78d2c2b32ce91139766d67243965ee3f35b72275f83f76bc18a7b58dfcbd0139834cc7fb517aee3fe28d0cca22d5823ccba9b6b057a728b940b7cd77798fee3fb154b080940881bccbb70358ae061339da90a4a2afa4ee3f93289c17239c8ebcdef3bb42f2c01fb96eca7c86f4b9ee3ff2e493222f83843ce8cb5102c40f29b9f1678e2d48cfee3f8cad11b4f3938cbc3bb444efdfb920b9108518a2aae4ee3f8d5687a48dc6813c247e07b58d1c0339275a61ee1bfaee3fb0b6a486f4c78d3c69ff29d2d56d2f392a41b61c9c0fef3f451d1865002283bc5bb0934211f823b997ba6b372b25ef3f438e0dbfa5a1833c16b57654adc624397472dd48c93aef3fde37d83e5a5a69bc10cce43f180ae43840456e5b7650ef3f8ba1d82de1d3893cf30ec8ff9b0104b9f84488793266ef3f3e3439357ba38f3c139e4c5aa426173914be9cadfd7bef3f0a3506d012bb8dbc4dfa8072cec52539893c2402d891ef3f89f679a7a82e51bc57efc3bf2493f8b8d8909e81c1a7ef3f1e93a5f35348773c51766fc360c0ed3814d59236babdef3fb68e0915736769bc329a8ad2d40c0b39f1718f2bc2d3ef3fe779659674eb523c6cc54e9396f0f238d9232a6bd9e9ef3fe3fd427403a6643cf30a13e885afeb38000000000000f03f00000000000000000000000000000000bfbc5afa1a0bf03f719f60a7b2f684bc083c3f52dd550bb93533fba93d16f03fb7cdb89a29619b3c8709d80780f42b3981023b146821f03fb64ec50f31bf82bc0bff27a73e9529396180773e9a2cf03f5d085b53839071bcd5743d0a5b0819b9ccbb112ed437f03f1ae1adee1168653ce977bd5a3d310139857f6ee81543f03f6ec977191ca390bc40404bf4fb12f9b8b154f6725f4ef03f8dd0a03a79c3843ce2af722b139c2fb9748515d3b059f03f65b475a4e2738d3c7e258d4ff95f1039891f3c0e0a65f03f97c399577bcb95bc984c6cfeade03339def6dd296b70f03f273cb1e2df918cbcab242c2e1fb41f3936a8722bd47bf03f008745543423833c6e3699508d2b09b9c89b75184587f03fff84b24bbe86613c4f416bd920580139e00766f6bd92f03fd13f0a80638096bcf83ed6f89f18043983f3c6ca3e9ef03f366131187848913c59c2fdd1458b34b919391f9bc7a9f03f381d3d876cd1853cdd230277d9f82cb90f89f96c58b5f03f0b61dc4a2ea6983c4cf7ebd69b7c36b9856ce445f1c0f03fef1cd20689f9943c8e3712c4719d0339f747722b92ccf03f714fe216dc1e903ce36f4e56ac8a3e39ec5d39233bd8f03f6a313fe44dc19bbc9c382ec1be9616b9a2d1d332ece3f03f537bc527173a403cdb9d4e9976aae5b8c5a9df5fa5eff03f1b0254bcb99d94bcfcf10371d54a3db91bd3feaf66fbf03f7bbd4ec4ed9b6bbc5942d8491febfab83e23d7283007f13fd5fd9216eb468d3ca875485b01571f39515b12d00113f13f3a9b443910c596bc2d568f988bd52939b62a5eabdb1ef13f72fb03f754a49cbc8825b0214b45f338cc316cc0bd2af13fc7a56cb314b551bc203108428f8df0b8ab04f214a836f13ff0dc48ba8f1067bcaa1ce9344e9a0c39e02da9ae9a42f13f9e36f19abf2f93bc1664c7b47bfe32b92e314f93954ef13fab44bf39e8918bbc327293d6fedd27b9518ea5c8985af13f0aabeeb96a40823c74c47952571b10b9c2c37154a466f13f321aea823bf2583c80f4f9656fecfc387b517d3cb872f13f768ad7b9419081bcf03fa16a40f22439c0bb9586d47ef13f645aace23f9e703c10929cec4cf90039ea8d8c38f98af13f6c0f97d1231091bcc5970b04f02517392f5d37582697f13f087ef185ddaa943c99a3308a6729263975cb6feb5ba3f13fe468497b4c5b8e3ce86a928361d30a391c8a13f899aff13f8092b6a485bf973cd07bbf23c4c215b9d45c0484e0bbf13f07f62e35865399bc8e710395a60c24b96b1c28952fc8f13fc9f810807709903c674ec981b87518b9aab9683187d4f13f3c64a2006e019e3c18b981082da61e392740b45ee7e0f13fdeb68c08d8fd96bc068766819f4530b91dd9fc2250edf13f8cb77b0298df91bc7574c4364d503e394dce3884c1f9f13f5caf97a024f59bbc1c06837fd78627b9d68c62883b06f23f95844a8175c78d3ca41e6fc1db8107b919a87835be12f23fc9aafc2c2d59933caac80902b46416b996dc7d91491ff23feea594947ea9823c6b10b7b3c29326b9d11279a2dd2bf23f9fd67755fb348d3c7830845221871bb93862756e7a38f23f7305c7b67eb0993ce032f59a9fd824b90a1482fb1f45f23f96a91c91cccf8a3c00703c513b4618393fa6b24fce51f23fa4f4f4be55c18a3c97f7dcafc8a9f13875ce1e71855ef23f2c1bc34aa2e1933ccd8b08766eba3539dd7ce265456bf23fd9e9409933bd823c771b463a3977123929df1d340e78f23f6ce7f9057c069e3c8b53e4ceb7d43bb98163f5e1df84f23f7e0d3f8c3a4c9abc7d2de5a2da7f363970bb9175ba91f23fbd1c402872cc82bcc4e4462d90a3d738e1de1ff59d9ef23f5512adafe812863c9046608544e50d39130fd1668aabf23fa7901619435799bcf6b7737e6dde2db990d9dad07fb8f23fa41a38d6dc0a41bcbd6d79b85f88e0382f1b77397ec5f23f2451eba6450195bcd4bf5c425c243eb90b03e4a685d2f23fd541db544702903c0793cbf8d8e91eb98915641f96dff23f98e1bcfbcf169d3c80f75c7ac6ad2a39562f3ea9afecf23f8323d5450fca713c2ad1e6de087b0d396b88bd4ad2f9f23f93da2b53553c65bc9820749c0886023915b7310afe06f33fe48231d26af4863cd9d09cf0b2b71739fdb2eeed3214f33fd1fcf3f3a359893cb5811b07eb1c29b931d84cfc7021f33f7c04188ee79c8a3ce8852b888c771b3932eaa83bb82ef33f18f3b43ce8459cbcb998083ac7783bb9ff1664b2083cf33fa65936842127933c6bfc6ceaa20634b92dfae3666249f33fa4810893755a83bcc96c7b6aaf7504b9f19f925fc556f33f28464e5cee5c8bbcf2d520e524e528b93b88dea23164f33f5eb86ca044318cbc96802341b08b2f39cba93a37a771f33fe2ea42bfea3a96bcfa6b51123e7e38394a751e23267ff33f3cb2ce9ecaf599bcf8127eed6974053966d8056dae8cf33fbd04993c8d959ebc214f40617aa72039ef40711b409af33f34298efca5a999bc7a0b91aef88f31b9f79fe534dba7f33fe3f561d636e475bc96c217ffb1b00939f46cecbf7fb5f33f18ff6fe2664c953c80bee3b2f8683d39e5a813c32dc3f33fc3295d37f8ff9ebc5a39932a3f1421b973e1ed44e5d0f33f714c288cd0e87f3c1559a64e16bac1382234124ca6def33fbc9ef01109da8a3cb78ffa68ba0828b975511cdf70ecf33fca9b8c7b63f68abc26ba49f3debc09b91c80ac0445faf33ff3f956f923d097bc0d2024373e4730b924a067c32208f43f48d0f4b6f8dd8b3ccf9544751c8b22392a2ef7210a16f43f7892301c69f35ebc1865fcea432bd3b88a460927fb23f43fdd14b3c02d4698bc80feff78d9ca31b997a850d9f531f43f99795fe3ddc781bcef5f1996c4032939d4b9843ffa3ff43f03c00497be80883cdf5849ca664929b92d896160084ef43fd080ef047a9b483c22d9e32d31acd0b832d2a742205cf43f8e1ffb82196468bcc85a5ae4395af8b857001ded416af43f768a64d14b949c3c3a1ff24f40df373937328b666d78f43f335744edf0209cbc083b3da2afb61cb9d03cc1b5a286f43ff06290b6a3c1733cc03a74aeeb1e0e39d2ae92e1e194f43fa09e495e89b283bca67223bb055c2f39ded3d7f02aa3f43f56bed1f362cb993cc7e261c776181939d7b76dea7db1f43ff097287fb82581bc2dee116a40241839272a36d5dabff43fe242ecaf97437d3c392b5c74c706ec3814c117b841cef43f5dbd0a69295e903c6778872174972bb90dddfd99b2dcf43f33786abcdbec983c439b5569c9121239ffabd8812debf43f527a5d2e7d2595bc22db115a0e772eb9a72c9d76b2f9f43fe35759d209b394bccd85b6d71faaf1b8ee31457f4108f53f5f46b7499b247a3cf8110a5f6d420fb94266cfa2da16f53fef93bd6985768fbc7d172682710ef938ef4e3fe87d25f53f71efef438d997cbce8d175164a9710b9824f9d562b34f53fad3cb11dbe7a80bc4c211f9533a70f3927adf6f4e242f53f7e5f2d196d92873caa6ba02e782611b90f925dcaa451f53f9be5edef9c688dbc93041b7791c91939d210e9dd7060f53ff0eb8e166efb90bc715c57ae29113939da27b536476ff53fad931d012cbb993cff13a65268f80fb9cfc4e2db277ef53fc4b9578a8cb990bc20aa4f1f89393db9fdc797d4128df53fe81d9a5be195823cc6e4d12ad9262ab9cc07ff27089cf53f0fe667e4cee297bc25bc1b2f770c2d39295448dd07abf53fad4746054c32963cfeda6f50ee4427b9037aa8fb11baf53f1a3e234ca1779bbc004288b1df763439b746598a26c9f53fa28669811b4b3c3c8c97545273c28e38938b999045d8f53f4356b4a8a7d69cbcfbb7d1eccf6d32394821ad156fe7f53f5ee68030f9a69b3cd6a75fb79a5f39b971ebdc20a3f6f53f92cfcde3ddea89bc7974c7fba6e1203909dc76b9e105f63f47de569b42e293bc88252eb9542c13b9f4f6cde62a15f63f274cb84a3e4b9e3cc85a3264caa305b985553ab07e24f63f97b4407ec18393bc91b9cf57e7d80539fd29191ddd33f63fe564b9be1047983cb6dd0b51212e373920c3cc344643f63f33899d753c488cbc0fc4c10040901339b78fbcfeb952f63f093ea7c9d5e39abc1a3c878aa6fd3339252255823862f63f341c598709b69bbc3b0adcf437a33439f63308c7c171f63f34616c5832878ebc25da440de8592f3973a94cd45581f63f653ef744ae38603cff043b630328efb838959eb1f490f63f5d44eb9abd04883caaebbcc8eaf828b9')

  wat('math.pow_transcend', genPowTranscend(), ['math.pow_scalbn'])
}
