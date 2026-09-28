import { ctx } from '../ctx.js'
import { EQUALITY_OPS, MUTATE_OPS, RELATIONAL_OPS, T, walkAst } from '../ast.js'
import { typedCtorRawOf } from '../static.js'
import { VAL } from '../reps.js'
import { K, tagOf, paramOf, hasTag, core } from '../summary/kind.js'
import { frameNode } from '../function.js'
import { TYPED_ELEM_BIGINT_FLAG } from '../../layout.js'

// A receiver the program holds as a typed array: its declaring constructor, or
// the summary's kind (`let a = mk(); a[i]`, a view, a parameter every caller
// proves). `bigint` says whether the elements are BigInt.
const typedRecv = (name) => {
  const raw = typedCtorRawOf(name)
  if (raw != null) return { bigint: /^new\.Big/.test(raw) }
  const k = ctx.summary?.at(ctx.func.current)?.kindOfExpr(name)
  if (k == null || tagOf(k) !== K.TYPED) return null
  return { bigint: (paramOf(k) & TYPED_ELEM_BIGINT_FLAG) !== 0 }
}
// `recv[i] = v` into a numeric typed array: SetValueInBuffer ToNumbers the value,
// so the store slot is a ToNumber-forcing use like `*`. BigInt arrays ToBigInt.
const numericTypedStore = (node) => node[0] === '=' && node.length === 3
  && Array.isArray(node[1]) && node[1][0] === '[]' && typeof node[1][1] === 'string'
  && typedRecv(node[1][1])?.bigint === false
// `recv[i]` on a typed array: the index is numeric-COMPATIBLE, not proving (a
// canonical numeric string indexes the same element; jz coerces indices to i32,
// README "what differs"). An untyped receiver keeps its dynamic-key possibility.
const typedIndex = (node) => node[0] === '[]' && node.length === 3
  && typeof node[1] === 'string' && typedRecv(node[1]) != null

// ── Loop-invariant exported-param coercion hoist ────────────────────────────
//
// An exported numeric param arrives as a NaN-box (jz's value ABI), so each use
// in an arithmetic context emits `__to_num(p)`. When the param is never
// reassigned and *every* use is an unconditional-ToNumber arithmetic operand,
// the coercion is loop-invariant: do it once at entry and let every use read the
// already-unboxed f64. This flips a serial recurrence like the de Jong attractor
// (4 `__to_num`/iter × millions) from ~parity to a clear win over V8.
//
// Self-gating: the rewrite only fires when the emitted body ALREADY contains
// `__to_num(p)` calls — meaning the helper is loaded for other reasons (global
// typed-array assigns, strings, …). A provably-numeric program (`(a,b)=>a*b`)
// never loads the helper, has no pattern to match, and is left byte-for-byte
// alone, preserving the minimal-bundle / golden-size guarantee.

// Reassigning the param breaks the coerce-once premise (any write op).
// Binary ops that unconditionally ToNumber BOTH operands, so a bare param operand
// is a pure numeric use. `+` is excluded (may concatenate); `===`/`==` are excluded
// (they branch on type, never coerce a string operand to number).
const NUM_BIN_OPS = new Set(['*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>'])
// Relational ops: jz has no lexicographic compare for an untyped operand — `<`
// lowers to `f64.lt`, taking the string path only when a *known-string* operand
// is present (emit.js cmpOp). So a bare param compared against a non-string is a
// pure numeric use, same as NUM_BIN_OPS. A string-literal counterpart (`x < "m"`)
// signals string intent and is rejected (handled in the walk below).
// A string literal/template operand poisons relational numeric inference.
const isStrLiteral = (n) => Array.isArray(n) && (n[0] === 'str' || n[0] === 'template')

// The names (of `names`) a condition proves numbers when it is `when`: `x !== x`
// holds for NaN alone, `x === 0.0` (a strict test against a number: a literal, or
// an operand the summary knows as a number) for a number alone; a call of a
// top-level predicate whose body is such a test of its parameter (`isnan( x )`,
// `isInfinite( x )`) proves its argument; `&&`, `||` and `!` combine them (each
// arm of a true `||` must prove a name). A `return` of a name so proven gives
// back a number, never the parameter's own value: libm's
// `if ( isnan( x ) ) { return x; }` keeps the export's f64 contract.
const NO_NAMES = new Set()
const numLit = (e) => typeof e === 'number' || e === 'Infinity' || e === 'NaN' ||
  (Array.isArray(e) && ((e[0] == null && typeof e[1] === 'number') || e[0] === 'nan' || ((e[0] === 'u-' || e[0] === '-') && e.length === 2 && numLit(e[1]))))
const flatArgs = (a) => Array.isArray(a) && a[0] === ',' ? a.slice(1).flatMap(flatArgs) : [a]
// A name the summary knows as a number in `scope`: not one that may be undefined (`undefined === undefined` holds).
const numberIn = (scope) => {
  const view = ctx.summary?.at(scope)
  return view ? (e) => { const k = view.kindOfExpr(e); return k != null && tagOf(core(k)) === K.NUMBER && !hasTag(k, K.NULLISH) && !hasTag(k, K.ABSENT) } : () => false
}
export function numericGuard(c, when, names, isNum, depth = 0) {
  if (!Array.isArray(c) || depth > 3) return NO_NAMES
  const op = c[0]
  if (op === '!') return numericGuard(c[1], !when, names, isNum, depth)
  if (op === '()' && c.length === 2) return numericGuard(c[1], when, names, isNum, depth)
  if (op === '&&' || op === '||' || op === '__eager&&' || op === '__eager||') {   // prepare's eager forms are the same tests
    const a = numericGuard(c[1], when, names, isNum, depth), b = numericGuard(c[2], when, names, isNum, depth)
    if ((op === '&&' || op === '__eager&&') === when) return !a.size ? b : !b.size ? a : new Set([...a, ...b])
    return a.size && b.size ? new Set([...a].filter(n => b.has(n))) : NO_NAMES
  }
  if (!when) return NO_NAMES
  const number = (e) => numLit(e) || (typeof e === 'string' && !names.has(e) && isNum(e))
  if (op === '!==' && names.has(c[1]) && c[1] === c[2]) return new Set([c[1]])
  if (op === '===') {
    if (names.has(c[1]) && number(c[2])) return new Set([c[1]])
    if (names.has(c[2]) && number(c[1])) return new Set([c[2]])
    return NO_NAMES
  }
  if (op === '()' && typeof c[1] === 'string') {
    const fn = ctx.funcs.map.get(c[1])
    if (!fn?.body || fn.raw || fn.defaults) return NO_NAMES
    const params = fn.sig.params.map(p => p.name)
    let body = fn.body
    if (Array.isArray(body) && body[0] === '{}') body = body[1]
    if (Array.isArray(body) && body[0] === ';') body = body.length === 2 ? body[1] : null
    if (Array.isArray(body) && body[0] === 'return') body = body[1]
    const proven = numericGuard(body, true, new Set(params), numberIn(fn.name), depth + 1)
    if (!proven.size) return NO_NAMES
    const args = c.slice(2).flatMap(flatArgs), out = new Set()
    params.forEach((p, i) => { if (proven.has(p) && names.has(args[i])) out.add(args[i]) })
    return out
  }
  return NO_NAMES
}
const assignsAny = (n, names) => { let hit = false; walkAst(n, { enter: (m) => { if (MUTATE_OPS.has(m[0]) && names.has(m[1])) hit = true } }); return hit }

/** True iff every use of param `name` in `body` is numeric-COMPATIBLE *and* at
 *  least one use is numeric-PROVING — so coercing it to a number once at entry is
 *  observationally exact. Two verdict levels guard against a polymorphic slot
 *  passing on absence of evidence:
 *   - PROVING (`proven=true`): arithmetic / relational / bitwise / unary operand —
 *     JS ToNumbers these, and a string/array value would have shown a disqualifying
 *     use elsewhere.
 *   - COMPATIBLE-ONLY: the length slot of `new TypedArray(x)` / `new ArrayBuffer(x)`.
 *     A number sizes the buffer, but an array is COPIED and a buffer VIEWED — so a
 *     bare param here proves nothing. A param used *solely* as `new Float64Array(arr)`
 *     stays unproven and keeps the polymorphic ctor dispatch (else array-copy is lost).
 *  Any other appearance (member/call-arg/return/concat/`===`/reassignment) rejects.
 *  Two transparencies:
 *   - copy aliases: `let x = name` makes `x` carry the same value, so `x`'s uses
 *     must be numeric too (fixpoint-collected). Catches `let T = t` then `…T…`.
 *   - captured closures: a non-shadowing inner arrow captures the binding by
 *     reference, so its body's uses count — we recurse instead of rejecting.
 *     Catches floatbeat helpers `let s=(f)=>…t…` that read the param numerically. */
// requireProof=true (default): the param has a ToNumber-FORCING use (PROVES numeric).
// requireProof=false: the param merely has NO string-requiring use (numeric-COMPATIBLE).
// Forwarding recursions use the latter — a callee receiving the param need only be
// string-free (e.g. fbm's `ph`, used additively inside Math.sin), since the OUTER
// param earns its own proof from its own uses; requiring the callee be self-proven
// wrongly rejected forwards into additive-only params.
export function paramAllUsesNumeric(body, name, _seen = new Set(), requireProof = true) {
  if (body == null) return false
  // Local closure defs (`let f = (p,…) => …`) so a call `f(name)` can be judged by
  // f's own param numericity (see the call-arg handler in the walk).
  const closures = new Map()  // name → { params:[string], body }
  // Fixpoint-collect copy aliases: `let/const x = <name-or-alias>`.
  const names = new Set([name])
  for (let grew = true; grew;) {
    grew = false
    const collect = (node) => {
      if (!Array.isArray(node)) return
      if ((node[0] === 'let' || node[0] === 'const') && node.length === 2
          && Array.isArray(node[1]) && node[1][0] === '=' && typeof node[1][1] === 'string') {
        const init = node[1][2]
        if (typeof init === 'string' && names.has(init) && !names.has(node[1][1])) { names.add(node[1][1]); grew = true }
        else if (Array.isArray(init) && init[0] === '=>' && !closures.has(node[1][1])) {
          const ps = Array.isArray(init[1]) ? init[1].slice(1) : [init[1]]   // ['()', p0, p1] → [p0,p1]
          if (ps.every(p => typeof p === 'string')) closures.set(node[1][1], { params: ps, body: init[2] })
        }
      }
      for (let i = 1; i < node.length; i++) collect(node[i])
    }
    collect(body)
  }
  // Locals with a provably-numeric init (`let x = 0`, `let k = -r`): a
  // relational compare against one of these forces its partner numeric.
  const numericLocals = new Set()
  const numericInit = (e) => typeof e === 'number' ||
    (Array.isArray(e) && (e[0] == null ? typeof e[1] === 'number' :
      NUM_BIN_OPS.has(e[0]) || e[0] === 'u-' || e[0] === 'u+'))
  ;(function collectNum(node) {
    if (!Array.isArray(node)) return
    if (node[0] === 'let' || node[0] === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' && numericInit(d[2]))
          numericLocals.add(d[1])
      }
    }
    for (let i = 1; i < node.length; i++) collectNum(node[i])
  })(body)
  let ok = true, proven = false
  let guarded = null   // the names a numeric guard proves on the current path (numericGuard)
  const isNum = numberIn(ctx.func.current)
  const guardedWalk = (cond, when, arm) => {
    const names_ = numericGuard(cond, when, names, isNum)
    if (!names_.size || assignsAny(arm, names_)) { walk(arm); return }
    const prior = guarded
    guarded = new Set([...(prior ?? []), ...names_])
    walk(arm)
    guarded = prior
  }
  // A param in a numeric-operand slot is a PROVING use; recurse into a non-param sub-expr.
  const numOperand = (n) => { if (names.has(n)) proven = true; else walk(n) }
  // Positional call args, flattening the `(, a b c)` node multi-arg calls parse to —
  // without this a forward like `fbm(x, y, t, …)` never matched its param positions.
  const flat1 = (a) => Array.isArray(a) && a[0] === ',' ? a.slice(1).flatMap(flat1) : [a]
  const callArgList = (n) => n.slice(2).flatMap(flat1)
  const walk = (node) => {
    if (!ok) return
    if (typeof node === 'string') { if (names.has(node)) ok = false; return }  // bare use → reject
    if (!Array.isArray(node)) return
    const op = node[0]
    // single `let/const x = init`: x is a binding (not a use). A pure copy of an
    // alias is consumed (already in `names`); otherwise the init must be numeric.
    if ((op === 'let' || op === 'const') && node.length === 2
        && Array.isArray(node[1]) && node[1][0] === '=' && typeof node[1][1] === 'string') {
      const init = node[1][2]
      if (typeof init === 'string' && names.has(init)) return
      walk(init)
      return
    }
    if (op === '=>') {                                  // closure capture: recurse unless shadowed
      const ps = node[1]
      const shadowed = Array.isArray(ps)
        ? ps.some(p => names.has(p) || (Array.isArray(p) && names.has(p[1])))
        : names.has(ps)
      if (!shadowed) { walk(node[1]); walk(node[2]) }   // defaults + body; param names aren't in `names`
      return
    }
    if (MUTATE_OPS.has(op) && names.has(node[1])) { ok = false; return }
    // A return, or a conditional's arm, of a name a numeric guard proves: a
    // number leaves, not the parameter's value (neither a proof nor a reject).
    if (op === 'return' && node.length === 2 && names.has(node[1]) && guarded?.has(node[1])) return
    if (op === '=' && typeof node[1] === 'string' && !names.has(node[1]) && names.has(node[2]) && guarded?.has(node[2])) return   // the lowering of a guarded early return
    if ((op === 'if' || op === 'while') && node.length >= 3) { walk(node[1]); guardedWalk(node[1], true, node[2]); if (node.length > 3) guardedWalk(node[1], false, node[3]); return }
    if (op === '?:' && node.length === 4 && (names.has(node[2]) || names.has(node[3]))) {
      walk(node[1])
      const yes = numericGuard(node[1], true, names, isNum), no = numericGuard(node[1], false, names, isNum)
      if (!(names.has(node[2]) && yes.has(node[2]))) walk(node[2])
      if (!(names.has(node[3]) && no.has(node[3]))) walk(node[3])
      return
    }
    // Compound assignment: `-=`/`*=`/… ToNumber the value; `+=` does so when the
    // target is a numeric local (`let s = 0; s += a[i]`, the accumulator idiom).
    if (typeof op === 'string' && op.length >= 2 && op.endsWith('=') && op !== '==' && op !== '===' && op !== '!=' && op !== '!==' && op !== '<=' && op !== '>=' && op !== '=' && node.length === 3 && typeof node[1] === 'string') {
      if (op !== '+=' || numericLocals.has(node[1])) { numOperand(node[2]); return }
    }
    if (numericTypedStore(node)) { if (!names.has(node[1][2])) walk(node[1][2]); numOperand(node[2]); return }
    if (typedIndex(node)) { if (!names.has(node[2])) walk(node[2]); return }
    if (NUM_BIN_OPS.has(op) && node.length === 3) {     // numeric binary: operands are ToNumber'd
      numOperand(node[1]); numOperand(node[2])
      return
    }
    // An equality against a number (`x !== x`, `x === PINF`) reads the param as
    // compatible, neither proving nor rejecting; against anything else it tells
    // the value's own type apart, so the param stays as it is.
    if (EQUALITY_OPS.has(op) && node.length === 3 && (names.has(node[1]) || names.has(node[2]))) {
      const other = names.has(node[1]) ? node[2] : node[1]
      if (!names.has(other) && !numLit(other) && !(typeof other === 'string' && isNum(other))) { ok = false; return }
      if (!names.has(other)) walk(other)
      return
    }
    // min/max ternary (`x < y ? x : y` — clampPeel synthesizes `__pks = min(r,w)`
    // peel bounds INTO the body before this proof runs): pass-through — the value
    // flows to the ternary's consumer; neither a numeric proof nor a reject.
    // Without this the proof rejected the peel's OWN output as a bare use and
    // un-proved the very params the peel had just relied on.
    if (op === '?:' && Array.isArray(node[1]) && RELATIONAL_OPS.has(node[1][0]) &&
        ((node[2] === node[1][1] && node[3] === node[1][2]) ||
         (node[2] === node[1][2] && node[3] === node[1][1]))) {
      walk(node[1]); return
    }
    if (RELATIONAL_OPS.has(op) && node.length === 3) {
      // Relational proof requires a PROVABLY-NUMERIC PARTNER: `x < 0` or
      // `k <= r` (k init `-r`) force ToNumber on the other side, but JS
      // compares two strings lexicographically — `(p, q) => p < q` proves
      // NOTHING about either param's kind. The old unconditional proof
      // stamped watr's hex-string i64 comparators NUMBER and their compares
      // took the raw-f64 path (NaN-boxed pointers compare as NaN → always
      // false), folding i64.lt_s(-1, 0) to 0 in-kernel — the -1n<0n row and
      // the shaped-parser family. Unproven params stay boxed and take
      // cmpOp's runtime string/number dispatch.
      if (isStrLiteral(node[1]) || isStrLiteral(node[2])) { ok = false; return }
      const numericPartner = (e) => typeof e === 'number' ||
        (typeof e === 'string' && numericLocals.has(e)) ||
        (Array.isArray(e) && (e[0] == null ? typeof e[1] === 'number' :
          NUM_BIN_OPS.has(e[0]) || e[0] === 'u-' || e[0] === 'u+' ||
          (e[0] === '.' && e[2] === 'length')))
      const side = (self, other) => {
        if (names.has(self)) { if (numericPartner(other)) proven = true }
        else walk(self)
      }
      side(node[1], node[2]); side(node[2], node[1])
      return
    }
    // `new TypedArray(x)` / `new ArrayBuffer(x)`: the length argument is ToNumber'd
    // on the alloc path, but a pointer arg is copied (array) or viewed (buffer).
    // A bare param in the length slot is numeric-COMPATIBLE but not PROVING — skip it
    // (no reject, no proof); other args walk normally. A param used *solely* as
    // `new Float64Array(param)` thus stays unproven → keeps the polymorphic ctor (so
    // `f(arr)` copies the array instead of mis-sizing a zero buffer).
    if (op === '()' && typeof node[1] === 'string' && node[1].startsWith('new.')
        && (node[1].endsWith('Array') || node[1] === 'new.ArrayBuffer')) {
      for (let i = 2; i < node.length; i++) if (!names.has(node[i])) walk(node[i])
      return
    }
    // Call of a LOCAL closure `f(…name…)`: forwarding the param flows its value into
    // f's positional param. If that param is itself all-numeric (recursively, with a
    // cycle guard), `name` in that slot is numeric-COMPATIBLE — neither rejected nor
    // proving (so a param used *only* as a forwarded arg stays unproven, like the ctor
    // length slot). Unknown / non-numeric callees fall through and reject (a string
    // could flow in). Covers heapsort's `heapify(n)` and crc32's `crc32(buf)`.
    if (op === '()' && typeof node[1] === 'string' && closures.has(node[1]) && !_seen.has(node[1])) {
      const cl = closures.get(node[1])
      const args = callArgList(node)
      for (let i = 0; i < args.length; i++) {
        if (!names.has(args[i])) { walk(args[i]); continue }
        const param = cl.params[i]
        if (param == null || !paramAllUsesNumeric(cl.body, param, new Set([..._seen, node[1]]), false)) { ok = false; return }
      }
      return
    }
    // Same forwarding judgement for a call to a MODULE-LEVEL user function (sibling,
    // not a body-local closure): `frame` passing its param into a helper `fbm(x,y,t,…)`.
    // Without this the bare arg fell through and rejected, leaving an exported numeric
    // param (plasma/raymarcher's `t`) unproven → per-pixel `__to_num` + polymorphic-`+`
    // string forks. Judge by the callee param's own numericity (recursive, cycle-guarded).
    if (op === '()' && typeof node[1] === 'string' && !_seen.has(node[1])) {
      const fn = ctx.funcs.map?.get(node[1])
      if (fn && fn.body && !fn.raw && Array.isArray(fn.sig?.params) && !fn.rest) {
        const args = callArgList(node)
        for (let i = 0; i < args.length; i++) {
          if (!names.has(args[i])) { walk(args[i]); continue }
          const p = fn.sig.params[i]
          if (!p || !paramAllUsesNumeric(fn.body, p.name, new Set([..._seen, node[1]]), false)) { ok = false; return }
        }
        return
      }
    }
    // `Math.f(...)` ToNumbers every argument (Math operates on numbers), so a bare
    // param in any arg slot is a PROVING numeric use — same contract as `*`/`-`.
    // Without this, `Math.sin(t)` rejected the param via the generic-call fallthrough,
    // so a numeric kernel like `Math.sin(tick) + …` lost its NUMBER proof and paid a
    // per-use `__to_num` + a polymorphic-`+` string-concat fork (interference example).
    // The callee is the lowered `math.sin` string at emit time (post-autoload), or the
    // raw `(. Math sin)` member pre-lowering — match both. `Math.sumPrecise` takes an
    // iterable, so its argument is a pointer, never a numeric proof.
    const mathMethod = op !== '()' ? null
      : (typeof node[1] === 'string' && node[1].startsWith('math.')) ? node[1].slice(5)
      : (Array.isArray(node[1]) && node[1][0] === '.' && node[1][1] === 'Math') ? node[1][2] : null
    const isMathCall = mathMethod != null && mathMethod !== 'sumPrecise'
    if (isMathCall) {
      const numArg = (a) => { if (Array.isArray(a) && a[0] === ',') { numArg(a[1]); numArg(a[2]) } else numOperand(a) }
      for (let i = 2; i < node.length; i++) numArg(node[i])
      return
    }
    // Binary `+` is overloaded (numeric add | string concat). A string-literal
    // operand means concat intent → reject. Otherwise it is numeric-COMPATIBLE but
    // not self-PROVING (a string param would concat) — recurse the non-param operand
    // and treat a bare param as compatible (neither prove nor reject), exactly like
    // paramNeverString. The numeric proof must still come from a ToNumber-forcing use
    // (`*`, `Math.*`, …); a param used ONLY in `+` stays unproven (sound).
    if (op === '+' && node.length === 3) {
      if (isStrLiteral(node[1]) || isStrLiteral(node[2])) { ok = false; return }
      if (!names.has(node[1])) walk(node[1])
      if (!names.has(node[2])) walk(node[2])
      return
    }
    if (op === '-' && node.length === 3) { numOperand(node[1]); numOperand(node[2]); return }
    // `u-`/`u+` are the normalized unary minus/plus (prepare rewrites `-x`/`+x`); both ToNumber.
    if ((op === 'u-' || op === 'u+') && node.length === 2) { numOperand(node[1]); return }
    if (op === '~' && node.length === 2) { numOperand(node[1]); return }
    for (let i = 1; i < node.length; i++) walk(node[i])  // bare param reaching here → rejected above
  }
  walk(body)
  return requireProof ? (ok && proven) : ok
}

// String methods whose receiver MUST be a string — their presence proves the
// param is (sometimes) string and disqualifies the boundary-numeric trust.
const STRING_RECV_METHODS = new Set([
  'charCodeAt', 'charAt', 'codePointAt', 'startsWith', 'endsWith', 'toUpperCase',
  'toLowerCase', 'normalize', 'localeCompare', 'padStart', 'padEnd', 'repeat',
  'trim', 'trimStart', 'trimEnd', 'split', 'match', 'matchAll', 'replace',
  'replaceAll', 'substring', 'substr', 'concat', 'indexOf', 'lastIndexOf',
  'includes', 'slice',
])

/** True iff no use of exported f64 param `name` REQUIRES it to be a string — so
 *  the interop boundary contract (`wrapVal` passes a JS number straight to an f64
 *  param; a string arg is a type misuse already unsupported, returning NaN) makes
 *  it provably numeric. Weaker than `paramAllUsesNumeric`: that PROVES numericity
 *  from ToNumber-forcing ops, this DISPROVES stringness so binary `+` (the common
 *  `accumulator + cre` shape) no longer pessimistically pulls the string-concat
 *  fork into a pure float kernel. Only sound under the export boundary — never use
 *  for locals/closures, whose values can genuinely be strings.
 *
 *  Disqualifying (string-requiring) uses:
 *   - `+` with a string-literal/template operand (`"px" + name`) — concat intent
 *   - a string-receiver method call (`name.charCodeAt(…)`, `name.split(…)`)
 *   - `name[k]` / `name.length` is NOT disqualifying (works on arrays/typed too,
 *     but an f64 param is neither — so a member access means the caller passed a
 *     pointer, out of the f64-number contract; conservatively we reject it)
 *   - passing `name` to a call / returning it / storing into an aggregate: the
 *     value escapes where it could be ToString'd; reject conservatively. */
export function paramNeverString(body, name, _seen = new Set()) {
  if (body == null) return false
  let ok = true
  const names = new Set([name]), isNum = numberIn(ctx.func.current)
  let guarded = false   // a numeric guard proves the name on the current path (numericGuard)
  const guardedWalk = (cond, when, arm) => {
    if (!numericGuard(cond, when, names, isNum).size || assignsAny(arm, names)) { walk(arm); return }
    const prior = guarded
    guarded = true
    walk(arm)
    guarded = prior
  }
  const walk = (node) => {
    if (!ok || node == null) return
    if (typeof node === 'string') { if (node === name) ok = false; return }  // bare escape → reject
    if (!Array.isArray(node)) return
    const op = node[0]
    // A return, or a conditional's arm, of the name under a numeric guard gives
    // back a number, never the value itself (no ToString can reach it).
    if (op === 'return' && node.length === 2 && node[1] === name && guarded) return
    if (op === '=' && typeof node[1] === 'string' && node[1] !== name && node[2] === name && guarded) return   // the lowering of a guarded early return
    if ((op === 'if' || op === 'while') && node.length >= 3) { walk(node[1]); guardedWalk(node[1], true, node[2]); if (node.length > 3) guardedWalk(node[1], false, node[3]); return }
    if (op === '?:' && node.length === 4 && (node[2] === name || node[3] === name)) {
      walk(node[1])
      if (!(node[2] === name && numericGuard(node[1], true, names, isNum).size)) walk(node[2])
      if (!(node[3] === name && numericGuard(node[1], false, names, isNum).size)) walk(node[3])
      return
    }
    // Closure capture: recurse into the arrow (params — default-value exprs
    // may reference `name` — and body) unless the arrow's OWN param list
    // shadows `name`, exactly mirroring paramAllUsesNumeric's arrow arm just
    // above in this file. Previously this bailed unconditionally ("handled
    // conservatively (escape)" per the stale comment it replaces) WITHOUT
    // setting `ok = false` — the opposite of conservative: a param used only
    // inside a nested arrow (`{...s, [k]: v}`'s prepare-time computed-key
    // desugaring is exactly this — `((t) => (t[k]=v, t))({...s})`, k free
    // in the arrow) went completely unseen, so `k[…]`/string-concat/method-
    // call uses of it inside the closure never tripped the reject at the
    // `.`/`?.`/`[]`-receiver check or the generic bare-name fallback below.
    // paramNeverString then wrongly returned true, and the exported-param
    // trust optimization (`if (func.exported) …`, above this function's own
    // caller) stamped the param VAL.NUMBER — corrupting every dynamic-key
    // write through it (root-caused via `emitElementAssign`'s idxNumericName
    // trusting that stamp to skip the runtime `__is_str_key` fork).
    if (op === '=>') {
      const ps = node[1]
      const shadowed = Array.isArray(ps)
        ? ps.some(p => p === name || (Array.isArray(p) && p[1] === name))
        : ps === name
      if (!shadowed) { walk(node[1]); walk(node[2]) }
      return
    }
    // `+` (binary): a string-literal/template operand makes it concat → reject.
    // Otherwise the param is in an arithmetic add; recurse the non-name operand.
    if (op === '+' && node.length === 3) {
      if (isStrLiteral(node[1]) || isStrLiteral(node[2])) { ok = false; return }
      for (let i = 1; i <= 2; i++) if (node[i] !== name) walk(node[i])
      return
    }
    if (numericTypedStore(node)) { if (node[1][2] !== name) walk(node[1][2]); if (node[2] !== name) walk(node[2]); return }
    if (typedIndex(node)) { if (node[2] !== name) walk(node[2]); return }
    // Numeric/relational/bitwise binary + unary: param operand is fine, recurse rest.
    // A relational compare against a string literal (`x >= "9"`) is string intent,
    // same as concat: JS compares two strings lexicographically, so the param must
    // keep its runtime string/number dispatch.
    if ((NUM_BIN_OPS.has(op) || RELATIONAL_OPS.has(op)) && node.length === 3) {
      if (RELATIONAL_OPS.has(op) && (isStrLiteral(node[1]) || isStrLiteral(node[2]))) { ok = false; return }
      for (let i = 1; i <= 2; i++) if (node[i] !== name) walk(node[i])
      return
    }
    // An equality against a number (`x !== x`, `x === 0.0`, `x === PINF`: libm's
    // guards) reads the param as a number would be read; against anything else
    // (`x === true`, `x == null`) it tells the value's own type apart, which
    // the boundary's number would not.
    if (EQUALITY_OPS.has(op) && node.length === 3 && (node[1] === name || node[2] === name)) {
      const other = node[1] === name ? node[2] : node[1]
      if (other !== name && !numLit(other) && !(typeof other === 'string' && isNum(other))) { ok = false; return }
      if (other !== name) walk(other)
      return
    }
    if ((op === 'u-' || op === 'u+' || op === '~') && node.length === 2) {
      if (node[1] !== name) walk(node[1]); return
    }
    if (op === '-' && (node.length === 2 || node.length === 3)) {
      for (let i = 1; i < node.length; i++) if (node[i] !== name) walk(node[i])
      return
    }
    // min/max ternary — same pass-through as paramAllUsesNumeric (clampPeel's
    // synthesized `__pks = min(r,w)` bounds must not read as a string escape).
    if (op === '?:' && Array.isArray(node[1]) && RELATIONAL_OPS.has(node[1][0]) &&
        ((node[2] === node[1][1] && node[3] === node[1][2]) ||
         (node[2] === node[1][2] && node[3] === node[1][1]))) {
      walk(node[1]); return
    }
    // Member access / method call on the param → it's a pointer, not an f64 number:
    // reject (out of contract). `.`/`?.`/`[]` with the name as receiver.
    if ((op === '.' || op === '?.' || op === '[]') && node[1] === name) { ok = false; return }
    // Passed to a module-level function: the value is that function's own
    // parameter, judged by its body (cycle-guarded), as paramAllUsesNumeric
    // forwards. stdlib's `export let f = (x) => fn(x)` and every helper call.
    if (op === '()' && typeof node[1] === 'string' && !_seen.has(node[1])) {
      const fn = ctx.funcs.map?.get(node[1])
      if (fn && fn.body && !fn.raw && Array.isArray(fn.sig?.params) && !fn.rest) {
        const args = flatArgs(node.length > 2 ? (node.length === 3 ? node[2] : [',', ...node.slice(2)]) : null).filter(a => a != null)
        for (let i = 0; i < args.length; i++) {
          if (args[i] !== name) { walk(args[i]); continue }
          const param = fn.sig.params[i]
          if (param == null || !paramNeverString(frameNode(fn), param.name, new Set([..._seen, node[1]]))) { ok = false; return }   // the frame: a default's use counts
        }
        return
      }
    }
    // `=`/compound reassignment of the param to a non-numeric value: reject if it
    // could become a string. A reassignment makes the param mutable — conservatively
    // require the RHS to be string-free too (recurse), and the target isn't a use.
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body)
  return ok
}

// ── Host value slot (jz:hostabi `val`) ─────────────────────────────────────
//
// The host's i64 lane carries one BigInt type for two things: a jz-minted
// handle (the box bits memory.String/Array/BigInt return, passed back raw) and
// a plain BigInt value, told apart by the NaN-box prefix in the bits. A value
// whose bits carry that prefix (0x7FF8000000000000n, the largest positive i64)
// crosses as a handle and reaches the program as NaN, an atom or an object. A
// `val` slot declares that its function reads the parameter only as a scalar
// value, so interop boxes EVERY BigInt there as a value: no handle can be
// passed, and a colliding value crosses as itself. The contract is proved from
// the body, never guessed from the magnitude of the argument.
const VALUE_CTORS = new Set(['BigInt', 'Number', 'String', 'Boolean'])

/** True iff every use of param `name` in `body` (a function's frame,
 *  `frameNode`: its parameter defaults run inside it) reads it as a scalar
 *  value. `let/const x = name` makes `x` carry the same value (fixpoint-
 *  collected) and `x`'s uses are judged the same way; a non-shadowing inner
 *  arrow that captures the name is scanned by the same rule.
 *  Scalar reads: the operand of `typeof`, arithmetic, bitwise, comparison or
 *  unary (`!`, `~`, `u-`, `u+`); the argument of `BigInt()`, `Number()`,
 *  `String()` or `Boolean()`; a template piece (`strcat`); the condition of
 *  `if`/`while`/`for`/`?:` (through `&&`/`||`, whose result is only
 *  ToBoolean'd there); the target of an assignment or update.
 *  Everything else rejects: a receiver of `.`/`?.`/`[]`, a callee, an argument
 *  to any other call (a user function included), an element of an array or
 *  object literal, an assigned value, a `return`, an `&&`/`||`/`??` value, a
 *  `?:` arm, a sequence element: the value would leave as itself, and a host
 *  handle passed there would still mean something. */
export function paramValueOnly(body, name) {
  if (body == null) return false
  const declarators = (n) => (n[0] === 'let' || n[0] === 'const')
    ? n.slice(1).filter(d => Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') : []
  const names = new Set([name])
  for (let grew = true; grew;) {
    grew = false
    walkAst(body, { enter: (n) => {
      for (const d of declarators(n))
        if (typeof d[2] === 'string' && names.has(d[2]) && !names.has(d[1])) { names.add(d[1]); grew = true }
    } })
  }
  let ok = true
  // A slot that reads its operand as a scalar: a bare name is fine, anything else scans.
  const read = (n) => { if (!names.has(n)) walk(n) }
  // A condition: `&&`/`||` there only feed ToBoolean, so their operands are scalar reads too.
  const test = (n) => {
    if (Array.isArray(n) && (n[0] === '&&' || n[0] === '||') && n.length === 3) { test(n[1]); test(n[2]) }
    else read(n)
  }
  const walk = (node) => {
    if (!ok) return
    if (typeof node === 'string') { if (names.has(node)) ok = false; return }   // the value leaves as itself
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op == null || op === 'str' || op === 'bigint') return
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < node.length; i++) {
        const d = node[i]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') read(d[2])   // a copy is an alias, judged by its own uses
        else walk(d)
      }
      return
    }
    if (op === '=>') {
      const ps = Array.isArray(node[1]) ? node[1].slice(1) : [node[1]]
      if (ps.some(p => names.has(p) || (Array.isArray(p) && names.has(p[1])))) return   // shadowed
      for (const p of ps) walk(p)   // default initializers
      walk(node[2])
      return
    }
    if (op === 'typeof' && node.length === 2) { read(node[1]); return }
    if ((NUM_BIN_OPS.has(op) || RELATIONAL_OPS.has(op) || EQUALITY_OPS.has(op) || op === '+' || op === '-') && node.length === 3) { read(node[1]); read(node[2]); return }
    if ((op === 'u-' || op === 'u+' || op === '~' || op === '!') && node.length === 2) { read(node[1]); return }
    if (op === '()' && VALUE_CTORS.has(node[1]) && node.length === 3) { read(node[2]); return }
    if (op === 'strcat') { for (let i = 1; i < node.length; i++) read(node[i]); return }
    if (op === '?:' && node.length === 4) { test(node[1]); walk(node[2]); walk(node[3]); return }
    if (op === 'if' || op === 'while') { test(node[1]); for (let i = 2; i < node.length; i++) walk(node[i]); return }
    if (op === 'for' && node.length === 5) { walk(node[1]); test(node[2]); walk(node[3]); walk(node[4]); return }
    // A write to the name reads the old value as an operand at most; the assigned value scans.
    if (MUTATE_OPS.has(op) && typeof node[1] === 'string') { for (let i = 2; i < node.length; i++) walk(node[i]); return }
    if ((op === '.' || op === '?.') && node.length === 3) { walk(node[1]); return }   // the property name is not a use
    for (let i = 1; i < node.length; i++) walk(node[i])   // a bare name anywhere else leaves as itself
  }
  walk(body)
  return ok
}

/** Names of `body` that only count: a parameter of `params`, or a local, whose
 *  every definition is a number built from such names and whose every use is an
 *  operand of arithmetic, a comparison, a step, a copy into another counting
 *  name, or an index. Counting is evidence, not absence of it: a name enters
 *  the result only when arithmetic, a step or a relational compare reads it
 *  (or a copy of it), so the lone key of `o[k]` stays a key. The strided
 *  signature `(N, x, strideX, offsetX)` walks a cursor seeded from one
 *  parameter and stepped by another; both count. */
const countingCache = new WeakMap()
const STEP_OPS = new Set(['+=', '-=', '*=', '++', '--'])
export function countingNames(body, params) {
  if (!Array.isArray(body) || !params?.length) return EMPTY_NAMES
  const cached = countingCache.get(body)
  if (cached) return cached
  const cands = new Set(params), defs = new Map(), copies = [], evidence = new Set()
  const define = (name, init) => {
    if (typeof name !== 'string') return
    if (!defs.has(name)) defs.set(name, [])
    if (init !== undefined) defs.get(name).push(init)
  }
  walkAst(body, { enter: (n) => {
    const op = n[0]
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (typeof d === 'string') { cands.add(d); define(d) }
        else if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string') { cands.add(d[1]); define(d[1], d[2]) }
      }
    } else if (op === '=' && typeof n[1] === 'string') define(n[1], n[2])
  } })
  const isMath = (callee) => (typeof callee === 'string' && callee.startsWith('math.')) || (Array.isArray(callee) && callee[0] === '.' && callee[1] === 'Math')
  const num = (e) => {
    if (typeof e === 'number') return true
    if (typeof e === 'string') return cands.has(e)
    if (!Array.isArray(e)) return false
    const op = e[0]
    if (op == null) return typeof e[1] === 'number'
    if (op === 'u-' || op === 'u+' || op === '~' || (op === '-' && e.length === 2)) return num(e[1])
    if ((NUM_BIN_OPS.has(op) || op === '+' || op === '-') && e.length === 3) return num(e[1]) && num(e[2])
    if (op === '?:') return num(e[2]) && num(e[3])
    if (op === '.' && e[2] === 'length') return true
    if (op === '()' && isMath(e[1])) return true
    return false
  }
  let changed = true
  const reject = (name) => { if (cands.delete(name)) changed = true }
  const operand = (n) => { if (typeof n === 'string') { if (cands.has(n)) evidence.add(n) } else visit(n, true) }
  // `numeric`: the position takes a number as a number
  const visit = (n, numeric) => {
    if (typeof n === 'string') { if (!numeric) reject(n); return }
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op == null || op === 'str') return
    if (op === '=>') { walkAst(n, { enter: (m) => { for (let i = 1; i < m.length; i++) if (typeof m[i] === 'string') reject(m[i]) } }); return }
    if (op === 'let' || op === 'const') {
      for (let i = 1; i < n.length; i++) { const d = n[i]; if (Array.isArray(d) && d[0] === '=') { if (typeof d[1] === 'string') visit(d[2], cands.has(d[1])); else visit(d, false) } }
      return
    }
    if (MUTATE_OPS.has(op)) {
      const t = n[1]
      if (typeof t === 'string') {
        if (STEP_OPS.has(op)) { if (cands.has(t)) evidence.add(t); if (n[2] != null) operand(n[2]) }
        else if (op === '=') visit(n[2], cands.has(t))
        else { reject(t); visit(n[2], false) }
        return
      }
      visit(t, false)
      for (let i = 2; i < n.length; i++) visit(n[i], false)
      return
    }
    if (op === '[]' && n.length === 3) { visit(n[1], false); visit(n[2], true); return }
    if (op === '.' || op === '?.') { visit(n[1], false); return }
    if (op === '+' && n.length === 3 && (isStrLiteral(n[1]) || isStrLiteral(n[2]))) { visit(n[1], false); visit(n[2], false); return }
    if ((NUM_BIN_OPS.has(op) || RELATIONAL_OPS.has(op) || op === '+' || op === '-') && n.length === 3) { operand(n[1]); operand(n[2]); return }
    if (EQUALITY_OPS.has(op) && n.length === 3) { visit(n[1], true); visit(n[2], true); return }
    if ((op === 'u-' || op === 'u+' || op === '~' || op === '-' || op === '!') && n.length === 2) { visit(n[1], true); return }
    if (op === '?:' && n.length === 4) { visit(n[1], true); visit(n[2], numeric); visit(n[3], numeric); return }
    if (op === '&&' || op === '||') { for (let i = 1; i < n.length; i++) visit(n[i], true); return }
    if (op === 'if' || op === 'while') { visit(n[1], true); for (let i = 2; i < n.length; i++) visit(n[i], false); return }
    if (op === 'for' && n.length === 5) { visit(n[1], false); visit(n[2], true); visit(n[3], false); visit(n[4], false); return }
    if (op === 'return') { visit(n[1], true); return }
    if (op === '()' && isMath(n[1])) { for (let i = 2; i < n.length; i++) visit(n[i], true); return }
    if (op === ',') { for (let i = 1; i < n.length; i++) visit(n[i], numeric && i === n.length - 1); return }
    for (let i = 1; i < n.length; i++) visit(n[i], false)
  }
  while (changed) {
    changed = false
    for (const [name, inits] of defs) if (cands.has(name) && !inits.every(num)) reject(name)
    evidence.clear()
    visit(body, false)
  }
  // a copy counts for its source: `ix = offsetX; ix += strideX`
  for (const [name, inits] of defs) for (const init of inits) if (typeof init === 'string') copies.push([name, init])
  for (let grew = true; grew;) {
    grew = false
    for (const [to, from] of copies) if (evidence.has(to) && cands.has(from) && !evidence.has(from)) { evidence.add(from); grew = true }
  }
  const out = new Set()
  for (const name of evidence) if (cands.has(name)) out.add(name)
  countingCache.set(body, out)
  return out
}
const EMPTY_NAMES = new Set()

/** Exported-param `name` used only as a numeric array-like: every use is an
 *  element read `name[i]`, an element write `name[i] = v` (or compound/update),
 *  `name.length`, or a forward into a user function whose parameter is itself
 *  numeric array-like (recursive, cycle guarded), and at least one such use
 *  exists, plus `return name` (the storage is returned; identity is not
 *  preserved). No reassignment, no other escape. Returns null when not, else
 *  `{ writes }`. Under the export contract the host value is normalized to a
 *  Float64Array at entry and, when written, copied back on return (interop,
 *  `jz:i64exp` `t`), so the body reads and writes typed storage: no receiver
 *  fork, no ToNumber runtime. An element is a number wherever it flows, which
 *  is JS for the numeric arrays such a parameter is written for. */
const TYPED_RECEIVER_METHODS = new Set(['subarray', 'slice', 'set', 'fill', 'copyWithin', 'indexOf', 'lastIndexOf', 'includes', 'at'])
const TYPED_WRITE_METHODS = new Set(['set', 'fill', 'copyWithin'])
export function paramNumericArrayLike(body, name, _seen = new Set(), params = null) {
  if (body == null) return null
  const counting = countingNames(body, params)
  let ok = true, used = false, writes = false, numericUse = false
  let numericStores = null
  const summary = ctx.summary?.at(body)
  const flat1 = (a) => Array.isArray(a) && a[0] === ',' ? a.slice(1).flatMap(flat1) : [a]
  const closures = new Map()
  // Views and copies of the receiver (`let h = data.subarray(a, b)`, `.slice`)
  // are the same storage kind: their uses count as the receiver's.
  const names = new Set([name])
  for (let grew = true; grew;) {
    grew = false
    walkAst(body, { enter: (n) => {
      if ((n[0] === 'let' || n[0] === 'const') && n.length === 2 && Array.isArray(n[1]) && n[1][0] === '=' && typeof n[1][1] === 'string') {
        const init = n[1][2]
        if (Array.isArray(init) && init[0] === '()' && Array.isArray(init[1]) && init[1][0] === '.' && names.has(init[1][1])
            && (init[1][2] === 'subarray' || init[1][2] === 'slice') && !names.has(n[1][1])) { names.add(n[1][1]); grew = true }
      }
    } })
  }
  // Locals with a numeric initializer (loop counters, `let j = i * 2`): an
  // index that is one of these, a literal, arithmetic over them, `.length`, a
  // bitwise result or a Math call is a numeric index. An unproven key (`o[k]`
  // with `k` a parameter) is the dictionary idiom and disqualifies the receiver.
  const numericLocals = new Set()
  walkAst(body, { enter: (n) => {
    if ((n[0] === 'let' || n[0] === 'const') && n.length === 2 && Array.isArray(n[1]) && n[1][0] === '=' && typeof n[1][1] === 'string') {
      const init = n[1][2]
      if (Array.isArray(init) && init[0] === '=>' && !closures.has(n[1][1])) {
        const ps = Array.isArray(init[1]) ? init[1].slice(1) : [init[1]]
        if (ps.every(p => typeof p === 'string')) closures.set(n[1][1], { params: ps, body: init[2] })
      }
    }
    if (n[0] === 'let' || n[0] === 'const')
      for (let i = 1; i < n.length; i++) {
        const d = n[i]
        if (Array.isArray(d) && d[0] === '=' && typeof d[1] === 'string' && numericIndex(d[2])) numericLocals.add(d[1])
      }
  } })
  function numericIndex(e) {
    if (typeof e === 'number') return true
    if (typeof e === 'string') return numericLocals.has(e) || counting.has(e)
    if (!Array.isArray(e)) return false
    const op = e[0]
    if (op == null) return typeof e[1] === 'number'
    if (op === 'u-' || op === 'u+' || op === '~') return numericIndex(e[1])
    if ((NUM_BIN_OPS.has(op) || op === '+' || op === '-') && e.length === 3) return numericIndex(e[1]) && numericIndex(e[2])
    if (op === '.' && e[2] === 'length') return true
    if (op === '()' && ((typeof e[1] === 'string' && e[1].startsWith('math.')) || (Array.isArray(e[1]) && e[1][0] === '.' && e[1][1] === 'Math'))) return true
    if (op === '?:') return numericIndex(e[2]) && numericIndex(e[3])
    if (op === '[]' && e.length === 3) return numericIndex(e[2])   // an element of a numeric array
    return false
  }
  const walk = (node) => {
    if (!ok) return
    if (typeof node === 'string') { if (names.has(node)) ok = false; return }
    if (!Array.isArray(node)) return
    const op = node[0]
    if (op == null || op === 'str' || op === 'template') return
    // The alias declaration itself: the view/copy call is a use, its args walk.
    if ((op === 'let' || op === 'const') && node.length === 2 && Array.isArray(node[1]) && node[1][0] === '=' && names.has(node[1][1]) && node[1][1] !== name) {
      const init = node[1][2]
      used = true
      for (let i = 2; i < init.length; i++) walk(init[i])
      return
    }
    if (op === '=>') {
      const ps = node[1]
      const shadowed = Array.isArray(ps) ? ps.some(p => names.has(p) || (Array.isArray(p) && names.has(p[1]))) : names.has(ps)
      if (!shadowed) { walk(node[1]); walk(node[2]) }
      return
    }
    if (MUTATE_OPS.has(op)) {
      const t = node[1]
      if (names.has(t) || (Array.isArray(t) && t[0] === '.' && names.has(t[1]))) { ok = false; return }
      if (Array.isArray(t) && t[0] === '[]' && names.has(t[1])) {
        const v = node[2]
        if (!numericIndex(t[2]) || (Array.isArray(v) && (v[0] === 'str' || v[0] === 'template' || (v[0] === '+' && v.length === 3 && (isStrLiteral(v[1]) || isStrLiteral(v[2])))))) { ok = false; return }
        writes = true; used = true
        // A numeric output buffer may have no element reads to supply the
        // proof below. Its stores give the same evidence as numeric fill.
        numericStores = numericStores !== false && op === '=' && summary?.valOfExpr(v) === VAL.NUMBER
        // `y[i] += n` adds to the element: a number beside it is no string being built.
        if (op === '+=' && summary?.valOfExpr(v) === VAL.NUMBER) numericUse = true
        walk(t[2]); for (let i = 2; i < node.length; i++) walk(node[i])
        return
      }
    }
    if (op === 'delete') { if (Array.isArray(node[1]) && names.has(node[1][1])) { ok = false; return } }
    if (op === '[]' && node.length === 3 && names.has(node[1])) {
      if (!numericIndex(node[2])) { ok = false; return }
      used = true; walk(node[2]); return
    }
    // `y[i] + n`, n a proven number: the same evidence as the `+=` store above.
    if (op === '+' && node.length === 3) {
      const elemRead = (e) => Array.isArray(e) && e[0] === '[]' && e.length === 3 && names.has(e[1])
      if ((elemRead(node[1]) && summary?.valOfExpr(node[2]) === VAL.NUMBER) || (elemRead(node[2]) && summary?.valOfExpr(node[1]) === VAL.NUMBER)) numericUse = true
    }
    // Typed-array methods on the receiver keep it typed (`data.subarray(a, b)`,
    // `out.set(src)`); the writing ones mark the storage for copy-back, and a
    // `fill` with a numeric value proves the elements numeric.
    if (op === '()' && Array.isArray(node[1]) && node[1][0] === '.' && names.has(node[1][1]) && TYPED_RECEIVER_METHODS.has(node[1][2])) {
      used = true
      if (TYPED_WRITE_METHODS.has(node[1][2])) writes = true
      if (node[1][2] === 'fill' && numericIndex(node[2])) numericUse = true
      for (let i = 2; i < node.length; i++) walk(node[i])
      return
    }
    // `return data` on an in-place kernel returns the storage itself (the host
    // sees a typed array with the same contents; identity is not preserved).
    if (op === 'return' && names.has(node[1])) { used = true; return }
    if ((op === '.' || op === '?.') && names.has(node[1])) { if (node[2] !== 'length') ok = false; else used = true; return }
    if (op === '()' && typeof node[1] === 'string') {
      const args = node.slice(2).flatMap(flat1)
      const cl = closures.get(node[1])
      const fn = cl ? null : ctx.funcs.map?.get(node[1])
      for (let i = 0; i < args.length; i++) {
        if (!names.has(args[i])) { walk(args[i]); continue }
        const target = cl ? cl.params[i] : (fn && fn.body && !fn.raw && !fn.rest && fn.sig?.params?.[i]?.name)
        const targetBody = cl ? cl.body : fn?.body
        const targetParams = cl ? cl.params : fn?.sig?.params?.map(q => q.name)
        const inner = target && !_seen.has(node[1] + '#' + i) && paramNumericArrayLike(targetBody, target, new Set([..._seen, node[1] + '#' + i]), targetParams)
        if (!inner) { ok = false; return }
        used = true; numericUse = true
        if (inner.writes) writes = true
      }
      return
    }
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body)
  if (!ok || !used) return null
  // The elements must be numbers wherever they flow: substitute every read
  // `name[i]` with one pseudo binding and require it numeric-compatible (the
  // same judgement a numeric parameter gets, `+` allowed, keys, unknown
  // callees, returns and escapes rejected). A string indexed by a loop counter
  // whose characters become dictionary keys fails here.
  const elem = `${T}elem`
  const isElemRead = (n) => Array.isArray(n) && n[0] === '[]' && n.length === 3 && names.has(n[1]) && numericIndex(n[2])
  const subst = (n) => {
    if (!Array.isArray(n)) return n
    if (isElemRead(n)) return elem
    // A write through the receiver was validated above; keep only the value it
    // stores, in the numeric context the store gives it (`a[i] *= k` reads as
    // `elem * k`, `a[i] = v` as `v`, `a[i]++` as `+elem`).
    if (MUTATE_OPS.has(n[0]) && isElemRead(n[1])) {
      const op = n[0]
      if (op === '=') return subst(n[2])
      if (op === '++' || op === '--') return ['u+', elem]
      return [op.slice(0, -1), elem, subst(n[2])]
    }
    return n.map(subst)
  }
  // Proof, not mere compatibility: `buf + s[i]` over a string local never
  // forces a number, so a string parameter indexed into a concat stays a string.
  // Numeric writes or a proven forwarded receiver supply the same evidence.
  if (!paramAllUsesNumeric(subst(body), elem, new Set(), !(numericUse || numericStores === true))) return null
  return { writes }
}
