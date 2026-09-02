import { ctx } from '../ctx.js'
import { MUTATE_OPS } from '../ast.js'
import { typedCtorRawOf } from '../static.js'

// `recv[i] = v` into a numeric typed array: SetValueInBuffer ToNumbers the value,
// so the store slot is a ToNumber-forcing use like `*`. BigInt arrays ToBigInt.
const numericTypedStore = (node) => node[0] === '=' && node.length === 3
  && Array.isArray(node[1]) && node[1][0] === '[]' && typeof node[1][1] === 'string'
  && /^new\.(?!Big)\w+Array$/.test(typedCtorRawOf(node[1][1]) ?? '')
// `recv[i]` on a typed array: the index is numeric-COMPATIBLE, not proving (a
// canonical numeric string indexes the same element; jz coerces indices to i32,
// README "what differs"). An untyped receiver keeps its dynamic-key possibility.
const typedIndex = (node) => node[0] === '[]' && node.length === 3
  && typeof node[1] === 'string' && typedCtorRawOf(node[1]) != null

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
const REL_OPS = new Set(['<', '<=', '>', '>='])
// A string literal/template operand poisons relational numeric inference.
const isStrLiteral = (n) => Array.isArray(n) && (n[0] === 'str' || n[0] === 'template')

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
    if (numericTypedStore(node)) { if (!names.has(node[1][2])) walk(node[1][2]); numOperand(node[2]); return }
    if (typedIndex(node)) { if (!names.has(node[2])) walk(node[2]); return }
    if (NUM_BIN_OPS.has(op) && node.length === 3) {     // numeric binary: operands are ToNumber'd
      numOperand(node[1]); numOperand(node[2])
      return
    }
    // min/max ternary (`x < y ? x : y` — clampPeel synthesizes `__pks = min(r,w)`
    // peel bounds INTO the body before this proof runs): pass-through — the value
    // flows to the ternary's consumer; neither a numeric proof nor a reject.
    // Without this the proof rejected the peel's OWN output as a bare use and
    // un-proved the very params the peel had just relied on.
    if (op === '?:' && Array.isArray(node[1]) && REL_OPS.has(node[1][0]) &&
        ((node[2] === node[1][1] && node[3] === node[1][2]) ||
         (node[2] === node[1][2] && node[3] === node[1][1]))) {
      walk(node[1]); return
    }
    if (REL_OPS.has(op) && node.length === 3) {
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
    if (op === '-' && node.length === 2) { numOperand(node[1]); return }  // unary negate
    if (op === '-' && node.length === 3) { numOperand(node[1]); numOperand(node[2]); return }
    // `u-`/`u+` are the normalized unary minus/plus (prepare rewrites `-x`/`+x`); both ToNumber.
    if ((op === 'u-' || op === 'u+') && node.length === 2) { numOperand(node[1]); return }
    if (op === '+' && node.length === 2) { numOperand(node[1]); return }  // unary + = ToNumber
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
export function paramNeverString(body, name) {
  if (body == null) return false
  let ok = true
  const walk = (node) => {
    if (!ok || node == null) return
    if (typeof node === 'string') { if (node === name) ok = false; return }  // bare escape → reject
    if (!Array.isArray(node)) return
    const op = node[0]
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
    if ((NUM_BIN_OPS.has(op) || REL_OPS.has(op)) && node.length === 3) {
      if (REL_OPS.has(op) && (isStrLiteral(node[1]) || isStrLiteral(node[2]))) { ok = false; return }
      for (let i = 1; i <= 2; i++) if (node[i] !== name) walk(node[i])
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
    if (op === '?:' && Array.isArray(node[1]) && REL_OPS.has(node[1][0]) &&
        ((node[2] === node[1][1] && node[3] === node[1][2]) ||
         (node[2] === node[1][2] && node[3] === node[1][1]))) {
      walk(node[1]); return
    }
    // Member access / method call on the param → it's a pointer, not an f64 number:
    // reject (out of contract). `.`/`?.`/`[]` with the name as receiver.
    if ((op === '.' || op === '?.' || op === '[]') && node[1] === name) { ok = false; return }
    // `=`/compound reassignment of the param to a non-numeric value: reject if it
    // could become a string. A reassignment makes the param mutable — conservatively
    // require the RHS to be string-free too (recurse), and the target isn't a use.
    for (let i = 1; i < node.length; i++) walk(node[i])
  }
  walk(body)
  return ok
}
