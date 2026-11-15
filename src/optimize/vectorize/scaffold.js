
import { DBG_INVARIANTS } from '../../debug.js'
import { cloneNode, walkAst } from '../../ast.js'
import { dollar } from '../../ir.js'
import { assertBodyModelSound, buildBodyModel, collectReferencedNames, collectWrites, constNum, hasGlobalSet, hasImpureCall, hasSideEffect, isI32Const, isLocalGet, readExit, readStep, stepsByOneVia } from './addr-model.js'
import { isArr } from './node-utils.js'
import { helperKind } from '../effects.js'

// ---- Recognize a (block (loop)) pair --------------------------------------

/**
 * Match the canonical vectorizable loop SCAFFOLD shared by every inner-loop
 * recognizer:
 *   (block $blk [preamble…]
 *     (loop $loop
 *       (br_if $blk (i32.eqz (i32.lt_{s,u} $i BOUND)))   ; exit guard
 *       BODY…
 *       (local.set $i (i32.add $i 1))                     ; bottom increment
 *       (br $loop)))
 *
 * Returns the structural FACTS only — no policy — or null when the shape
 * doesn't match:
 *   { blockNode, blockLabel, loopNode, loopLabel, endIdx, incIdx, incVar,
 *     exitInfo, bound, boundLocal, body, preamble }
 *   - `blockNode` is the original block, embedded verbatim as the scalar tail by
 *     each lifter's wrapper (the never-miscompile remainder loop).
 *   - `body`       = loopNode.slice(3, incIdx) (between exit guard and increment)
 *   - `bound`      = the raw BOUND expr; `boundLocal` = its local name when it is
 *     `(local.get $L)`, else null. Bound shape is NOT rejected here — callers that
 *     require a local-or-const bound check it themselves (tryStrengthReduceIV is
 *     bound-shape-agnostic, so baking a rejection in would change its behavior).
 *
 * `opts.allowPreamble` (default false): when true, LICM-hoisted invariant
 *   `(local.set $__li* EXPR)` statements BEFORE the loop are collected into
 *   `preamble` (pure & loop-invariant by construction — safe to clone/re-run);
 *   a non-`$__li` preamble, an impure value, or any array content AFTER the loop
 *   bails. When false, ANY non-loop array content in the block bails.
 *
 * Four opt-ins below cover recognizers whose acceptance genuinely differs; see each for
 * its exact contract: `opts.multiInc` (tryRampMap), `opts.ivRun` (tryGeneralMap), `opts.envelope: 'loose'`
 * (tryBlurMultiPixel/tryChannelReduce1px), `opts.envelope: 'pixelIV'` (matchOuterPixelLoop).
 */
// A transparent block — no label (first child isn't a `$label` string) and no result — is
// pure statement grouping: wasm locals are function-scoped, and an unlabeled resultless block
// is neither a branch target nor a value producer, so it can ONLY appear in statement position
// (a resultless block in value position is a type error). jz emits one per source statement
// group; watr's mergeBlocks/vacuum flattens them post-hoc. The vectorizer is jz LOWERING
// (pre-watr), so it normalizes them itself IN PLACE — splicing each transparent block's
// children into its parent's statement list — so every recognizer (scaffold-consuming AND
// raw-node) reads the flat statement lists they were tuned against. Post-order: children are
// already flat when a block is spliced up. A labeled block (branch target) or result-carrying
// block (value producer) is kept — including the `(block $brk (loop …))` SIMD scaffold itself.

/** The counted SIMD loop every recognizer emits (see index.js): exit once `iv` reaches the
 *  `bound` local, run `body` (which advances `iv`), repeat. Labels are keyed by `id`.
 *  `dir` −1, a loop counting down: `body` is the strip lifted at its lowest iteration and
 *  ends in the step `iv += W` a strip of W iterations takes up. The strips run from `iv`
 *  down, each over the iterations b … b + W − 1 in address order: `iv` holds b, the lane
 *  base, from W − 1 below the counter on entry to W − 1 below where the loop as written
 *  resumes, stepping down by W while above `bound`, the limit simdBound gives in its terms. */
export const simdLoop = (id, iv, bound, body, dir = 1) => {
  const exit = (cmp) => ['br_if', `$__simd_brk${id}`, ['i32.eqz', [cmp, ['local.get', iv], ['local.get', bound]]]]
  if (dir > 0) return ['block', `$__simd_brk${id}`, ['loop', `$__simd_loop${id}`, exit('i32.lt_s'), ...body, ['br', `$__simd_loop${id}`]]]
  const last = body[body.length - 1], w = readStep(last)?.by
  if (!(w > 1) || last[2][0] !== 'i32.add') throw new Error('simdLoop: a strip counting down ends in its own step up')
  const by = (op, k) => ['local.set', iv, [op, ['local.get', iv], ['i32.const', k]]]
  return ['block', by('i32.sub', w - 1),
    ['block', `$__simd_brk${id}`, ['loop', `$__simd_loop${id}`, exit('i32.gt_s'), ...body.slice(0, -1), by('i32.sub', w), ['br', `$__simd_loop${id}`]]],
    by('i32.add', w - 1)]
}

/** Whether a strip of `w` iterations from `iv` toward the limit `bound` (simdBound) runs. */
export const stripOpen = (iv, bound, dir = 1, w = 1) => dir > 0 ? ['i32.lt_s', ['local.get', iv], ['local.get', bound]]
  : ['i32.gt_s', ['i32.sub', ['local.get', iv], ['i32.const', w - 1]], ['local.get', bound]]

/** The limit of the strip `at` (strips below) where none of it runs: the counter where the
 *  strips count up, the highest word, which no lane base passes, where they count down. */
export const shut = (at) => at.dir < 0 ? ['i32.const', 0x7fffffff] : ['local.get', at.iv]

// Align the span from its actual entry, preserving empty signed ranges.
// Rounding a bound near INT_MIN downward can wrap above the entry. An
// over-reading load also requires its complete span before subtracting it.
// (each bound remembers its strip: where a lift's entry closes, alias.js gateStrips)
export const strips = new WeakMap()
/** A lift's strip built as a statement beside its kept scalar loop, of `lanes` iterations of
 *  `iv` under `bound` (null past an integer counter): `gateStrips` wraps it whole. */
export const stripBlock = (node, iv, bound, lanes) => (strips.set(node, { iv, bound, lanes, block: true }), node)
export function simdBound(iv, bound, lanes, overread = 0, dir = 1) {
  const start = () => ['local.get', iv]
  if (dir < 0) {
    // Counting down to the low end `bound`, inclusive: a strip runs while its lane base, W − 1
    // below the counter (simdLoop), is at the low end or above it (an iteration above it with
    // an over-read of one), so the limit is one below that, a word the base's interval starts
    // past (optimize/word-ranges.js: an address at the base folds its array, const-bases.js).
    // The strips stop where the iterations left are fewer than W, in the loop's last ones. A
    // base steps W below the last strip's: a low end within W of the lowest word wraps it,
    // and a counter within W − 1 of it has no base, so no strip runs there (shut).
    if (overread > 1) throw new Error('simdBound: a strip counting down over-reads one iteration at most')
    const MIN = -0x80000000, never = shut({ dir })
    const based = ['i32.ge_s', start(), ['i32.const', MIN + lanes - 1]]
    let limit
    if (isI32Const(bound) && typeof bound[1] === 'number')
      limit = bound[1] + overread < MIN + lanes ? never : ['select', ['i32.const', bound[1] + overread - 1], never, based]
    else limit = ['select', overread ? cloneNode(bound) : ['i32.sub', cloneNode(bound), ['i32.const', 1]], never,
      ['i32.and', based, ['i32.ge_s', cloneNode(bound), ['i32.const', MIN + lanes - overread]]]]
    strips.set(limit, { iv, bound, lanes: lanes + overread, dir })
    return limit
  }
  const span = () => ['i32.sub', cloneNode(bound), start()]
  const end = ['i32.add', start(), ['i32.and',
    overread ? ['i32.sub', span(), ['i32.const', overread]] : span(), ['i32.const', -lanes]]]
  const entered = ['i32.lt_s', start(), cloneNode(bound)]
  const limit = isI32Const(bound) && typeof bound[1] === 'number' &&
      bound[1] >= -0x80000000 + lanes + overread - 1 && bound[1] <= 0x7fffffff ? end
    : ['select', end, start(), overread
      ? ['i32.and', entered, ['i32.ge_u', span(), ['i32.const', lanes + overread]]]
      : entered]
  strips.set(limit, { iv, bound, lanes: lanes + overread })
  return limit
}

export function normalizeTransparentBlocks(node) {
  if (!isArr(node)) return
  for (let i = 1; i < node.length; i++) normalizeTransparentBlocks(node[i])
  for (let i = node.length - 1; i >= 1; i--) {
    const c = node[i]
    if (!isArr(c)) continue
    // A statement's value block — `(block (result T) S… V)` dropped, jz's element store
    // with the assigned value, or set into a local, its staged element read — is the
    // statements S… followed by what consumes V: nothing for a dropped plain read.
    const b = c[0] === 'drop' || c[0] === 'local.set' ? c[c.length - 1] : c[0] === 'block' && node[i + 1] === 'drop' ? c : null
    if (isArr(b) && b[0] === 'block' && isArr(b[1]) && b[1][0] === 'result') {
      const body = b.slice(2), last = body[body.length - 1]
      const read = isArr(last) && (last[0] === 'local.get' || last[0] === 'global.get' || last[0].endsWith('.const'))
      const use = c[0] === 'local.set' ? [['local.set', c[1], last]] : read ? [] : [['drop', last]]
      node.splice(i, c === b ? 2 : 1, ...body.slice(0, -1), ...use)
    } else if (c[0] === 'block' && !(typeof c[1] === 'string' && c[1].startsWith('$')) && !(isArr(c[1]) && c[1][0] === 'result'))
      node.splice(i, 1, ...c.slice(1))
  }
}

// Fold the arithmetic identities watr's `identity` pass removes but jz emits raw — most
// importantly `i<<0` (a byte-stride address for a u8/i8 array: `base + (i << 0)`), which the
// vectorizer's address matchers, tuned on watr's folded IR, read as bare `i`. Also the trivial
// `x±0`, `x|0`, `x^0`, `x<<0/>>0`, `x*1`. In place, bottom-up; returns the (possibly folded)
// node so a parent can rebind. Pure syntactic identities — always sound, watr-equivalent.
export function foldVecIdentities(node) {
  if (!isArr(node)) return node
  for (let i = 1; i < node.length; i++) node[i] = foldVecIdentities(node[i])
  if (node.length !== 3) return node
  const op = node[0], a = node[1], b = node[2]
  const ci = (n) => isArr(n) && (n[0] === 'i32.const' || n[0] === 'i64.const') ? Number(n[1]) : NaN
  const rb = ci(b), ra = ci(a)
  switch (op) {
    case 'i32.shl': case 'i32.shr_s': case 'i32.shr_u':
    case 'i64.shl': case 'i64.shr_s': case 'i64.shr_u':
      return rb === 0 ? a : node                       // x << 0 = x (right-identity only)
    case 'i32.add': case 'i32.or': case 'i32.xor':
    case 'i64.add': case 'i64.or': case 'i64.xor':
      return rb === 0 ? a : (ra === 0 ? b : node)      // x±0, x|0, x^0 (either side)
    case 'i32.sub': case 'i64.sub':
      return rb === 0 ? a : node                       // x - 0 = x
    case 'i32.mul': case 'i64.mul':
      return rb === 1 ? a : (ra === 1 ? b : node)      // x*1
    default: return node
  }
}

// Canonicalize jz's `if COND (then (br L))` break-idiom to watr's `br_if L COND` — the shape the
// loop-scan recognizers (byte-scan, divergent-escape) match. watr's `brif` pass does this
// post-hoc; the pre-watr vectorizer needs it now. Only the statement-form (no result), no-else,
// single-`br`-then shape becomes a br_if — anything richer is left untouched for watr. In place,
// top-down (a converted br_if has no nested `if` to revisit).
export function canonicalizeIfBr(node) {
  walkAst(node, { enter: (c, parent, i) => {
    if (!parent) return
    if (c[0] === 'if' && c.length === 3 &&
        !(isArr(c[1]) && c[1][0] === 'result') &&
        isArr(c[2]) && c[2][0] === 'then' && c[2].length === 2 &&
        isArr(c[2][1]) && c[2][1][0] === 'br' && c[2][1].length === 2 && typeof c[2][1][1] === 'string') {
      // `(br L)` only — a value-carrying `(br L v)` would lose its operand under br_if's 2-arg form.
      parent[i] = ['br_if', c[2][1][1], c[1]]
      return false
    }
  } })
}

// Shared tail of every envelope below: the loop's own label (position 1) and its bottom
// `(br label)` back-edge. Returns { loopLabel, endIdx } or null.
function matchLoopBrEnd(loopNode) {
  const loopLabel = typeof loopNode[1] === 'string' && loopNode[1].startsWith('$') ? loopNode[1] : null
  if (!loopLabel) return null
  const endIdx = loopNode.length - 1
  if (!(isArr(loopNode[endIdx]) && loopNode[endIdx][0] === 'br' && loopNode[endIdx][1] === loopLabel)) return null
  return { loopLabel, endIdx }
}

// Per-loop-body facts every "classify each referenced local" recognizer re-derived
// from `body` before doing its own recognizer-specific classification: `writes` (names
// written anywhere in the body — loop-invariance/lane tests key off this),
// `referenced` (all names touched, get or set/tee — the classification domain),
// `hasGlobalSet` (a global write breaks the "global.get is invariant" splat, checked
// verbatim by tryVectorize/tryStencil/tryRampMap/tryToneMap), `hasImpureCall` (a non-pure
// call breaks per-lane epilogue re-evaluation — see hasImpureCall's own doc). Computed once
// here per LoopPlan; consumers read bl.writes/bl.referenced/bl.hasGlobalSet instead of
// re-walking.
//
// Also computes BodyModel (.work/evidence.md §BodyModel; consumed by tryReduceBitExact/
// tryRampMap): `addrTable`/`offsetTees`/`siteAccess`/`aliasClass`, spread in below. `offsetTees`
// is ONE construction — `buildBodyModel` derives it FROM `addrTable`, so it rides in with
// `...bm` instead of its own separate `deriveOffsetTees` call. JZ_DEBUG_INVARIANTS
// shadow-asserts the generalization against the private predicates it will eventually let
// recognizers retire.
function bodyFacts(body, ind) {
  const writes = new Set()
  for (const s of body) collectWrites(s, writes)
  const referenced = new Set()
  for (const s of body) collectReferencedNames(s, referenced)
  const bm = buildBodyModel(body, ind)
  if (DBG_INVARIANTS) assertBodyModelSound(body, ind, bm)
  return { writes, referenced, hasGlobalSet: body.some(hasGlobalSet), hasImpureCall: body.some(hasImpureCall), ...bm }
}

// ---- The one description of a counted loop ---------------------------------------
//
// Built once for each `(block (loop))` the vectorizer visits (index.js) and handed to every
// recognizer's scaffold (matchBlockLoop's envelopes, stripScaffold) and to the legality:
//   counter   the local the head test reads, which is the emitter's own counter (its
//             lowering link, ir/control.js, renamed with the block's locals) on every loop
//             the canonical scaffold takes, checked under JZ_DEBUG_INVARIANTS (index.js)
//   exit      that test as written (addr-model.js readExit): the relation, its signedness and
//             type, the counter's constant shift and the bound operand
//   steps     the run of steps before the back edge (readStep), the counter's own among them
//   dir, by   the counter's step: +1 up or −1 down, and its magnitude; the emitter's where
//             the link holds them, else the step's
//   facts     what the emitter proved of the loop (compile/loop-model.js loopFacts): the
//             counter's hull and its range at the test, the bound's range, the trips of an entry
// What keeps an emitter fact true to here: no pass between the emitter and the vectorizer
// rebuilds a loop's block (one that would leaves the new block unlinked: ir/control.js); the
// counter's name is renamed with the block's locals (emit/control-flow.js
// renameScalarBindings); the passes rewrite operands in place (a bound snapped into a local,
// a forwarded load, a hoisted operand), never a step's or a test's operator. An operand they
// rewrite may be the test's left side where the loop never writes it (LICM hoists it), and
// the emitter itself writes a nullable counter's test over its numeric shadow: the test then
// reads another local than the emitter's counter, and the link describes no value the test
// reads. So the bound operand is read here, from the WAT, the rest is the emitter's where
// the test reads its counter, checked against the WAT under JZ_DEBUG_INVARIANTS (linkHolds),
// and nothing of the link where it does not.
export function describeLoop(blockNode, link = null) {
  if (!isArr(blockNode) || blockNode[0] !== 'block') return null
  const blockLabel = typeof blockNode[1] === 'string' && blockNode[1].startsWith('$') ? blockNode[1] : null
  let loopNode = null
  for (let i = 1; i < blockNode.length; i++) {
    const c = blockNode[i]
    if (isArr(c) && c[0] === 'loop') { if (loopNode) return null; loopNode = c }
  }
  if (!loopNode || !blockLabel) return null
  const le = matchLoopBrEnd(loopNode)
  if (!le) return null
  const exit = readExit(loopNode[2], blockLabel)
  const steps = []
  for (let i = le.endIdx - 1; i >= 3; i--) {
    const s = readStep(loopNode[i])
    if (!s) break
    steps.unshift({ ...s, idx: i })
  }
  // The link describes this test where the test reads the emitter's counter. It may read
  // another local: a nullable counter's numeric shadow, which the emitter itself reads in
  // its place (compile/num-shadow.js), or a left side the loop never writes, which LICM
  // hoisted (no counter: nothing steps it). The description then takes nothing of the link.
  const own = link && link.lowering.ivName != null ? dollar(link.lowering.ivName) : null
  const plan = own != null && exit?.counter === own ? link.plan : null
  const counter = exit ? exit.counter : own
  let step = null
  for (const s of steps) if (s.name === counter) step = s
  const desc = {
    blockNode, blockLabel, loopNode, loopLabel: le.loopLabel, endIdx: le.endIdx, exit, steps, counter, step,
    dir: plan?.dir ?? (step?.by ? Math.sign(step.by) : null), by: plan?.by ?? (step?.by ? Math.abs(step.by) : null),
    facts: plan, own,
  }
  if (DBG_INVARIANTS && plan) linkHolds(desc, link)
  return desc
}

// The emitter's facts of a loop against its WAT, where both read its counter: a
// disagreement is a fact the passes between them did not keep (describeLoop's header), a
// defect, never a loop to lift.
function linkHolds(desc, { plan, lowering }) {
  const { exit, step, loopNode } = desc
  const fail = (what) => { throw new Error(`loop ${loopNode[1]} ${what} diverges from WAT: link ${lowering.ivName} ${plan.cmp} shift ${plan.shift} step ${plan.dir}·${plan.by} bound ${plan.boundConst}, WAT ${exit ? `${exit.counter} ${exit.rel} shift ${exit.shift}` : 'no test'}, step ${step ? `${step.name} by ${step.by}` : 'none'}`) }
  if (exit && plan.cmp != null && (exit.rel !== plan.cmp || exit.shift !== plan.shift)) fail('exit test')
  if (exit && plan.boundConst != null && isI32Const(exit.bound) && constNum(exit.bound) !== plan.boundConst) fail('bound')
  if (step && plan.dir != null && step.by != null && (Math.sign(step.by) !== plan.dir || Math.abs(step.by) !== plan.by)) fail('step')
}

// A call a preamble may hold, cloned ahead of the strips and run again by the loop as written:
// one the effects summary's table calls pure or a reader of header words (optimize/effects.js).
const READS = { has: (name) => { const k = helperKind(name); return k === 'pure' || k === 'header' } }

// The statements a block holds ahead of its one loop, as the default envelope admits them:
// pure `local.set`s (an invariant LICM or a peephole hoisted, `$__li*`, or any local under
// `allowInlinedLi`), nothing after the loop. null where the block holds anything else.
function preambleOf(desc, opts) {
  const { blockNode, loopNode } = desc
  const preamble = []
  let past = false
  for (let i = 2; i < blockNode.length; i++) {
    const c = blockNode[i]
    if (c === loopNode) { past = true; continue }
    if (!isArr(c)) continue
    // A LICM-hoisted invariant is `$__liN`; INLINING renames it (e.g. `$__inl7___li0`). Default
    // accepts only un-inlined `$__li*` (keeps the existing recognizers byte-identical);
    // `allowInlinedLi` (gated callers only) also accepts the `__liN` marker anywhere — both are
    // pure & loop-invariant by construction (belt-and-suspenders: hasSideEffect guard).
    // Under allowInlinedLi a block preamble is loop-invariant by construction (jz hoists only
    // invariants before the loop; IV-dependent work lives in the body), so any PURE local.set is
    // safe to clone ahead of the SIMD — covers $__inl*__li* (schrodinger) AND $_pg0-style
    // peephole-hoisted bounds (slime). The hasSideEffect guard rejects impure setups.
    const liOk = typeof c[1] === 'string' && (opts.allowInlinedLi ? true : c[1].startsWith('$__li'))
    if (!opts.allowPreamble || past || c[0] !== 'local.set' || !liOk || hasSideEffect(c[2], READS)) return null
    preamble.push(c)
  }
  return preamble
}

// The longest run of `steps` ending at the back edge whose every step `ok` takes.
export const runOf = (desc, ok) => {
  const { steps, endIdx } = desc
  let k = steps.length
  while (k > 0 && steps[k - 1].idx === endIdx - (steps.length - k) - 1 && ok(steps[k - 1])) k--
  return steps.slice(k)
}

export function matchBlockLoop(blockNode, opts = {}, desc = describeLoop(blockNode)) {
  if (!desc) return null
  const { blockLabel, loopNode, loopLabel, endIdx, exit } = desc

  // envelope: 'pixelIV' — matchOuterPixelLoop's scaffold (see its own header doc): any
  // `local.set` ahead of the loop, nothing else in the block; the pixel counters' steps and
  // the exit test are its own view of the description.
  if (opts.envelope === 'pixelIV') {
    const preamble = []
    for (let i = 2; i < blockNode.length; i++) {
      const c = blockNode[i]
      if (!isArr(c)) return null
      if (c === loopNode) { if (i !== blockNode.length - 1) return null; continue }
      if (c[0] !== 'local.set') return null
      preamble.push(c)
    }
    return { blockNode, blockLabel, loopNode, loopLabel, endIdx, preamble }
  }

  // envelope: 'loose' (tryBlurMultiPixel/tryChannelReduce1px) tolerates ANY non-loop content
  // anywhere — before or after the loop — with no validation at all.
  if (opts.envelope === 'loose') return { blockNode, blockLabel, loopNode, loopLabel, endIdx }

  const preamble = preambleOf(desc, opts)
  if (!preamble) return null
  // the exit test the canonical scaffold reads: `i < bound`, the counter unshifted, an i32
  const exitInfo = exit && exit.type === 'i32' && exit.rel === '<' && !exit.shift ? { ind: exit.counter, bound: exit.bound } : null

  // multiInc (tryRampMap) — trailing RUN of `x += C`; the exit IV must be in the run
  // stepping by exactly 1. Other constraints on the run are tryRampMap's residual.
  if (opts.multiInc) {
    if (!exitInfo) return null
    const run = runOf(desc, s => s.op === 'i32.add' && s.by != null)
    if (!run.length) return null
    const ivInc = run.find(x => x.name === exitInfo.ind)
    if (!ivInc || ivInc.by !== 1) return null
    const incVar = exitInfo.ind
    const bound = exitInfo.bound
    const boundLocal = isLocalGet(bound) && typeof bound[1] === 'string' ? bound[1] : null
    const body = loopNode.slice(3, run[0].idx)
    const increments = run.map(s => ({ name: s.name, c: s.by }))
    return { blockNode, blockLabel, loopNode, loopLabel, endIdx, incVar, exit, exitInfo, bound, boundLocal, body, preamble, increments, ...bodyFacts(body, incVar) }
  }

  // ivRun (tryGeneralMap): the loop ends in a run of counter steps, `j++, k += step`:
  // the exit counter by 1, every other counter by a constant or a local the loop never
  // writes. `ivs` lists those secondary counters as { name, step }; the body stops before
  // the run, and `writes` counts them, so a recognizer that ignores `ivs` never reads one
  // as loop-invariant.
  if (opts.ivRun) {
    if (!exitInfo) return null
    const run = runOf(desc, s => s.op === 'i32.add')
    const runStart = run.length ? run[0].idx : endIdx
    const incVar = exitInfo.ind
    const exitSteps = run.filter(x => x.name === incVar)
    if (exitSteps.length !== 1 || exitSteps[0].by !== 1 || new Set(run.map(x => x.name)).size !== run.length) return null
    const body = loopNode.slice(3, runStart)
    const facts = bodyFacts(body, incVar)
    const ivs = run.filter(x => x.name !== incVar).map(x => ({ name: x.name, step: x.amount }))
    for (const { name, step } of ivs) {
      if (isLocalGet(step) && (facts.writes.has(step[1]) || run.some(x => x.name === step[1]))) return null
      facts.writes.add(name)
    }
    const bound = exitInfo.bound
    const boundLocal = isLocalGet(bound) && typeof bound[1] === 'string' ? bound[1] : null
    return { blockNode, blockLabel, loopNode, loopLabel, endIdx, incIdx: runStart, incVar, exit, exitInfo, bound, boundLocal, body, preamble, ivs, ...facts }
  }

  const incIdx = endIdx - 1
  const last = desc.steps.length && desc.steps[desc.steps.length - 1].idx === incIdx ? desc.steps[desc.steps.length - 1] : null
  let incVar = last && last.op === 'i32.add' && last.by === 1 ? last.name : null
  // CSE'd increment (gated): O3 may fold `x+1` into a body tee (the `xe = x+1` wrap) and write the
  // increment as `x = $t` reusing it. Recover the IV when `$t` is `(tee/set $t (i32.add x 1))` in body.
  if (!incVar && opts.allowInlinedLi) {
    const inc = loopNode[incIdx]
    if (isArr(inc) && inc[0] === 'local.set' && inc.length === 3 && isLocalGet(inc[2]) && stepsByOneVia(loopNode.slice(3, incIdx), inc[1], inc[2][1])) incVar = inc[1]
  }
  if (!incVar) return null
  if (!exitInfo || exitInfo.ind !== incVar || incVar !== desc.counter) return null

  const bound = exitInfo.bound
  const boundLocal = isLocalGet(bound) && typeof bound[1] === 'string' ? bound[1] : null
  const body = loopNode.slice(3, incIdx)
  return { blockNode, blockLabel, loopNode, loopLabel, endIdx, incIdx, incVar, exit, exitInfo, bound, boundLocal, body, preamble, ...bodyFacts(body, incVar) }
}

// ---- The strips of a counted loop the canonical scaffold refuses -----------------

const I32_MIN = -0x80000000, I32_MAX = 0x7fffffff

/**
 * The scaffold the strips of a counted loop read where the canonical one above refuses its
 * test or its direction, or null. The loop is the description's: an i32 counter stepped by
 * one at the back edge, tested signed at the head against a bound that is a constant or a
 * local, under the default envelope:
 *   - up, its test `<=` or shifted (`i + K < n`): the strips run below E, where the test
 *     reads as `i < E` (E = n − K, + 1 for `<=`);
 *   - down (`dir` −1), its test `>=` or `>`: the strips run from the counter down to the low
 *     end L, inclusive, where the test reads as `i >= L` (L = n − K, + 1 for `>`).
 * E or L leaves the word only where no strip may run past it (E above the word: none runs to
 * it; L below: none reaches it), so it is clamped into the word there, and `exact` says
 * whether it is the loop's own exit (no clamp, by a constant bound or the emitter's range of
 * the bound). A shift that may take the counter past the word on a strip (`i − 1 < n` near
 * −2^31, `i + 1 >= n` near 2^31) needs the emitter's range of the counter at the test to show
 * it cannot; `i + K < n` up from a positive K cannot (the strips stay below n − K).
 * E or L, when not the bound itself, is set ahead of the strips into a local of its own
 * (`setup`, `decls`); the loop as written runs whatever the strips leave.
 */
export function stripScaffold(desc, opts, freshIdRef) {
  if (!desc?.exit || !desc.step) return null
  const { blockNode, blockLabel, loopNode, loopLabel, endIdx, exit, step, counter, facts } = desc
  const incIdx = endIdx - 1
  // (the way the counter runs, the emitter's where the loop is linked: its one step, the last)
  const dir = desc.dir
  if (exit.type !== 'i32' || !exit.signed || exit.counter !== counter || step.idx !== incIdx || step.type !== 'i32' || (dir !== 1 && dir !== -1) || step.by !== dir) return null
  const { rel, shift, bound } = exit
  if (dir > 0 ? !(rel === '<=' || (rel === '<' && shift)) : !(rel === '>=' || rel === '>')) return null
  if (!isI32Const(bound) && !(isLocalGet(bound) && typeof bound[1] === 'string')) return null
  // (the end is read once, ahead of the strips: a bound the loop writes moves under them)
  if (isLocalGet(bound)) { const w = new Set(); collectWrites(loopNode, w); if (w.has(bound[1])) return null }
  const preamble = preambleOf(desc, opts)
  if (!preamble) return null
  const t = facts?.test
  if (shift && !(t && t.lo + shift >= I32_MIN && t.hi + shift <= I32_MAX) && !(dir > 0 && shift > 0)) return null
  // the end as the test reads it: bound − k
  const k = shift - (rel === '<=' || rel === '>' ? 1 : 0)
  const setup = [], decls = []
  let end, exact
  if (isI32Const(bound)) {
    const v = constNum(bound) - k
    exact = v >= I32_MIN && v <= I32_MAX
    end = ['i32.const', Math.min(I32_MAX, Math.max(I32_MIN, v))]
  } else if (!k) { end = bound; exact = true }
  else {
    const r = facts?.boundRange
    exact = !!r && r[0] - k >= I32_MIN && r[1] - k <= I32_MAX
    const name = `$__vend${freshIdRef.next++}`
    const v = ['i32.sub', cloneNode(bound), ['i32.const', k]]
    setup.push(['local.set', name, exact ? v
      : k > 0 ? ['select', v, ['i32.const', I32_MIN], ['i32.ge_s', cloneNode(bound), ['i32.const', I32_MIN + k]]]
      : ['select', v, ['i32.const', I32_MAX], ['i32.le_s', cloneNode(bound), ['i32.const', I32_MAX + k]]]])
    decls.push(['local', name, 'i32'])
    end = ['local.get', name]
  }
  const boundLocal = isLocalGet(end) ? end[1] : null
  const body = loopNode.slice(3, incIdx)
  return { blockNode, blockLabel, loopNode, loopLabel, endIdx, incIdx, incVar: counter, exit, exitInfo: { ind: counter, bound: end },
    bound: end, boundLocal, body, preamble, dir, setup, decls, exact, ...bodyFacts(body, counter) }
}
