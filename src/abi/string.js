/**
 * src/abi/string — string carriers.
 *
 * One file holds every strategy the compiler may pick for a string-typed
 * binding. Carriers are named exports; the narrower tags each site with the
 * chosen carrier, and codegen reads `ctx.abi.string[<carrier>]` (today only
 * the default carrier `sso` is reached — per-site picking arrives with the
 * JS String Builtins specialization workstream).
 *
 * Carriers:
 *   - `sso`         default. NaN-boxed STRING pointer (PTR.STRING=4) with
 *                   Small-String-Optimization for ≤4 ASCII chars packed inline
 *                   in the aux+offset fields.
 *   - `jsstring`    architectural scaffold. Native JS strings via JS String
 *                   Builtins (`wasm:js-string` imports); externref slot. Empty
 *                   ops table — the 9-item compiler-wide checklist below blocks
 *                   real codegen.
 *
 * No `name`/`type` discriminant field — carriers are referenced by object
 * identity from the default-bundle in `src/abi/index.js`.
 *
 * @module src/abi/string
 */

// ─────────────────────────────────────────────────────────────────────────
// Op contract (shared by every carrier)
//
//     ops.<op>(...slotCarriers, ctx) → wasm IR
//
//   - Every string-valued argument is a **slot-carrier IR**: IR whose runtime
//     WASM value matches `slotTypes[0]`. Under `sso` that's `f64` (the NaN-
//     boxed pointer); under `jsstring` that's `externref`. The caller is
//     responsible for producing slot-carrier IR — typically
//     `asF64(emit(strNode))` today; once non-f64 string slots ship, call
//     sites switch to a carrier-driven `coerceSlot` helper.
//   - The op is self-contained: it inlines whatever WASM
//     reinterprets/wraps it needs to reach its stdlib helper signature.
//     `sso` emits `['i64.reinterpret_f64', sF64]` inline rather than
//     importing `asI64` from `src/ir.js` — this module is loaded transitively
//     from `src/ctx.js`, so importing back into `src/ir.js` would read
//     `LAYOUT.NAN_PREFIX_BITS` before `src/ctx.js`'s `LAYOUT` const is bound.
//   - `ctx` is the ambient compilation context, passed last. Each op
//     registers its stdlib dependency via `ctx.core.includes.add(name)`.
//
// Layout the `sso` ops are calibrated against (defined in `src/ctx.js`):
//   - LAYOUT.NAN_PREFIX_BITS, LAYOUT.TAG_SHIFT, LAYOUT.AUX_SHIFT,
//     LAYOUT.OFFSET_MASK, LAYOUT.SSO_BIT
//   - PTR.STRING = 4
// ─────────────────────────────────────────────────────────────────────────

// ── sso ───────────────────────────────────────────────────────────────────

// Local inline coercer — IR-only, no src/* import (cycle safety). Caller is
// expected to pass IR whose WASM-level value is already f64 (e.g. via
// `asF64(emit(strNode))`); this wraps the unbox to i64 the stdlib helpers
// take. Kept as a one-liner so each op reads as a single `call`.
const ssoI64 = (sF64) => ['i64.reinterpret_f64', sF64]

import { isReassigned, isLeaf } from '../ast.js'
import { LAYOUT, oobNanIR, ssoBitI64Hex } from '../../layout.js'

/** Pre-shifted SSO discriminator — layout.js is cycle-free; the thunk exists for
 *  load-order laziness ONLY. Deliberately NOT memoized: a module-level memo of a
 *  runtime-BUILT string dangles across the self-host kernel's `_clear()` arena
 *  rewind (warm compile #2 interpolated the stale pointer's garbage bytes into
 *  `(i64.const …)` → watr "Bad int") — the same dangling-cache class as DOLLAR /
 *  stdlibParseCache (see scripts/self.js setupSelf). Recomputing is a few ops at
 *  emit time; correctness over a micro-memo. */
const ssoBitI64 = () => ssoBitI64Hex()

/** Allocate a fresh i64 local in the current function. Replicated here (not
 *  imported from `src/ir.js`) to keep this module loadable during ctx.js
 *  bootstrap — see header note about the cycle. */
const allocLocalI64 = (ctx, tag) => {
  let name
  do { name = `_${tag}${ctx.func.uniq++}` } while (ctx.func.locals.has(name))
  ctx.func.locals.set(name, 'i64')
  return name
}
const allocLocalI32 = (ctx, tag) => {
  let name
  do { name = `_${tag}${ctx.func.uniq++}` } while (ctx.func.locals.has(name))
  ctx.func.locals.set(name, 'i32')
  return name
}


/** Per-use cheap form of `charCodeAt` against a pre-decomposed param receiver
 *  (shape 1): a bounds check plus a 2-arm SSO/heap byte select reading the four
 *  i32 decode locals in `dec`. The index is referenced three times, so a
 *  side-effecting `iI32` is spilled to a scratch local first — leaves are safe
 *  to duplicate. `oobNan` picks the OOB contract / result type exactly as in
 *  the generic path. */
function emitDecompCharRead(dec, iI32, ctx, oobNan, inBounds = false) {
  const rt = oobNan ? 'f64' : 'i32'
  let idx = iI32, spill = null
  if (!isLeaf(iI32)) { spill = allocLocalI32(ctx, 'ci'); idx = ['local.get', `$${spill}`] }
  const ssoByteExpr = ['i32.wrap_i64', ['i64.and',
    ['i64.shr_u', ['local.get', `$${dec.ptr64}`], ['i64.mul', ['i64.extend_i32_u', idx], ['i64.const', 7]]],
    ['i64.const', '0x7f']]]
  const heapByteExpr = ['i32.load8_u', ['i32.add', ['local.get', `$${dec.loadbase}`], idx]]
  // Both arms are trap-free: the prologue routes an SSO receiver's speculative
  // heap load to memory[0 + idx], and an in-bounds SSO idx is at most 6. Speed
  // tier in a compact graph uses a select that unswitchStringRepLoop can fold
  // out of the loop. Other tiers/large graphs keep the predictable branch —
  // evaluating both arms without the unswitch regresses the self-host parser.
  const canUnswitch = ctx.transform.optimize?.unswitchStringRepLoop === true && ctx.func.list.length <= 64
  const ccByte = canUnswitch
    ? ['select', ssoByteExpr, heapByteExpr, ['local.get', `$${dec.sso}`]]
    : ['if', ['result', 'i32'], ['local.get', `$${dec.sso}`], ['then', ssoByteExpr], ['else', heapByteExpr]]
  // `inBounds`: the index is proven in [0, len) by an enclosing canonical scan
  // (analyze.js inBoundsCharCodeAt / splitCharScanLoops' in-bounds main loop), so
  // the OOB arm is dead — drop the per-char `i >= len` compare. This is what turns
  // a split char-scan loop into a bare load (the `if(sso)` arm is loop-invariant and
  // V8-folds), matching AS/native on tokenizer-shape scans. Otherwise keep the guard.
  const use = inBounds
    ? (oobNan ? ['f64.convert_i32_u', ccByte] : ccByte)
    : ['if', ['result', rt],
        ['i32.ge_u', idx, ['local.get', `$${dec.len}`]],
        ['then', oobNan ? oobNanIR() : ['i32.const', 0]],
        ['else', oobNan ? ['f64.convert_i32_u', ccByte] : ccByte]]
  return spill
    ? ['block', ['result', rt], ['local.set', `$${spill}`, iI32], use]
    : use
}

/** Emit the function-entry decomposition prologue for the param-fast-path
 *  shape of `charCodeAt`. Decodes the f64 NaN-box once per call into three i32
 *  scratch locals (`base`, `len`, `sso`) recorded in `dec`. Per-iter
 *  `charCodeAt` then collapses to a length compare + 2-arm select; the load
 *  from `(base + i)` stays memory-safe when SSO because the inner select
 *  reroutes the address to 0 (always-valid memory[0]).
 *
 *  Returns an array of IR statements suitable for splicing between the boxed-
 *  param inits and the user body in `emitFunc`. The off<4 guard preserves the
 *  pre-decomp semantics: any pointer with offset bits below 4 (null/undefined
 *  reaching here via type error) gets `len=0` so every bounds check trips and
 *  every `charCodeAt` returns 0 — same shape as the legacy `__char_at`. */
export function emitCharDecompPrologue(dec) {
  // Receiver expression: a param's local slot (shape-1 classic) or a stable
  // module global (dec.recvGlobal — the parser-state shape: `cur.charCodeAt(idx)`
  // against a global assigned only outside the scanning function). Built fresh
  // (IR nodes must not be structurally shared; also the self-host kernel
  // compiles this file — stick to constructs jz itself supports).
  const ptr = ['i64.reinterpret_f64', dec.recvGlobal ? ['global.get', dec.recvGlobal] : ['local.get', `$${dec.param}`]]
  const ssoTest = ['i64.ne',
    ['i64.and', ptr, ['i64.const', ssoBitI64()]],
    ['i64.const', 0]]
  const offMask = `0x${LAYOUT.OFFSET_MASK.toString(16).toUpperCase()}`
  const off = ['i32.wrap_i64', ['i64.and', ptr, ['i64.const', offMask]]]
  // SSO length lives at payload bits 42-44 (7-bit-codec layout; see module/string.js).
  const ssoLen = ['i32.wrap_i64', ['i64.and', ['i64.shr_u', ptr, ['i64.const', 42]], ['i64.const', 7]]]
  // Heap length is `i32.load(off - 4)`; guard against off<4 (corrupt/non-string
  // payload) so the load doesn't trap on a wrapped-negative address.
  const heapLen = ['if', ['result', 'i32'],
    ['i32.lt_u', off, ['i32.const', 4]],
    ['then', ['i32.const', 0]],
    ['else', ['i32.load', ['i32.sub', off, ['i32.const', 4]]]]]
  return [
    ['if',
      ssoTest,
      ['then',
        ['local.set', `$${dec.sso}`, ['i32.const', 1]],
        ['local.set', `$${dec.base}`, off],
        ['local.set', `$${dec.ptr64}`, ptr],   // full payload: SSO chars are 7-bit, span into aux
        ['local.set', `$${dec.len}`, ssoLen],
        // SSO: route every per-iter load to address 0 (always valid, byte
        // discarded by the outer select).
        ['local.set', `$${dec.loadbase}`, ['i32.const', 0]]],
      ['else',
        ['local.set', `$${dec.sso}`, ['i32.const', 0]],
        ['local.set', `$${dec.base}`, off],
        ['local.set', `$${dec.len}`, heapLen],
        // Heap: per-iter loads use the real string-data base.
        ['local.set', `$${dec.loadbase}`, off]]],
  ]
}

// True iff every call expression in `body` is a `.charCodeAt` member call and
// no suspension point (yield/await) or `new` appears — the stability proof for
// shape-1b global decomposition: nothing that runs during this function can
// reassign a module global. Escaped arrows are safe to ignore beyond their
// visible call nodes: they only run when called, and every call here is
// charCodeAt (single-threaded).
export function bodyOnlyCharCodeAtCalls(body) {
  if (!Array.isArray(body)) return true
  const op = body[0]
  if (op === 'yield' || op === 'await' || op === 'new') return false
  if (op === '()' || op === '?.()') {
    const callee = body[1]
    if (!(Array.isArray(callee) && (callee[0] === '.' || callee[0] === '?.') && callee[2] === 'charCodeAt')) return false
  }
  for (let i = 1; i < body.length; i++) if (!bodyOnlyCharCodeAtCalls(body[i])) return false
  return true
}

export const sso = {
  // Wasm slot type a string value occupies under this carrier: the f64
  // NaN-boxed slot (PTR.STRING tag in the high bits, SSO inline data or
  // 32-bit heap offset in the low). Read by `src/compile.js` signature
  // synthesis to type string params/returns at the JS↔wasm boundary.
  slotTypes: ['f64'],

  ops: {
    /** Byte length. Receiver: f64 slot carrier. Returns i32 — caller widens
     *  to f64 if it needs JS-spec `.length` semantics. */
    byteLen: (sF64, ctx) => {
      ctx.core.includes.add('__str_byteLen')
      return ['call', '$__str_byteLen', ssoI64(sF64)]
    },

    /** Char code at index i. Receiver: f64 slot carrier; index: i32. The
     *  `oobNan` flag picks the out-of-bounds contract (see the param comment
     *  below): `false` ⇒ i32 result, `0` for OOB (raw-byte primitive);
     *  `true` ⇒ f64 result, NaN for OOB (JS-spec `String.prototype.charCodeAt`).
     *
     *  Two emission shapes, picked at the call site:
     *
     *  1. **Param-decomposition fast path** — when the receiver is a `local.get`
     *     of a function parameter that isn't boxed (no closure mutation) and
     *     isn't a generator/async frame slot, we hoist the SSO-bit test, offset
     *     extraction, and heap-length load to a function-entry prologue. The
     *     prologue writes three i32 locals — `$<p>$ccbase`, `$<p>$cclen`,
     *     `$<p>$ccsso` — once per call. Every `charCodeAt` in the body collapses
     *     to a length compare + a 2-arm select between the two byte
     *     formulations: `(off >> (i*8)) & 0xFF` for the SSO 4-byte packed form
     *     and `i32.load8_u (base + i)` for the heap form. Memory safety of the
     *     load when the string is actually SSO is preserved by feeding the load
     *     address through `select(0, base+i, sso)` — for SSO strings the load
     *     reads byte 0 of linear memory (always valid in wasm), and the outer
     *     select discards the garbage. Tokenizer-shape loops go from ~13
     *     instructions per char (5 of them loop-invariant but un-LICM'd by V8
     *     because of the surrounding `if/else`) to 4: `local.get`, `i32.ge_u`,
     *     `i32.add`, `i32.load8_u`. Closes the AS gap on the tokenizer pin.
     *
     *  2. **Generic inline fallback** — when the receiver is some other
     *     expression (member access, call result, ternary on f64 strings, etc.)
     *     we emit the SSO-vs-heap dispatch in line. Watr's L2 default keeps the
     *     WAT-level inliner off (regex-split miscompile, watr 4.6.4), so we
     *     can't rely on watr to inline `__char_at` for us. Side-effect-free
     *     leaves (`local.get` of non-param locals, `*.const`, `global.get`)
     *     duplicate the f64→i64 reinterpret at every use and trust V8 CSE;
     *     anything heavier spills once to an i64 temp so each branch reuses the
     *     same value.
     *
     *  Function-entry prologue emission for shape 1 happens in
     *  `src/compile.js#emitFunc` — it drains `ctx.func.charDecomp` after the
     *  body emit completes and splices an init block between the boxed-param
     *  inits and the user statements. */
    charCodeAt: (sF64, iI32, ctx, oobNan = false, inBounds = false) => {
      // `oobNan` selects the out-of-bounds semantics and result type:
      //   - false (default): OOB → `i32.const 0`, result i32 — the raw-byte
      //     primitive used by the `buf += s[i]` append-byte fast path.
      //   - true: OOB → numeric NaN, result f64 — the JS-spec `charCodeAt`
      //     contract (`pos < 0 || pos >= length` ⇒ NaN). The parser hot loop
      //     `while ((cc = s.charCodeAt(i++)) <= 32)` relies on `NaN <= 32`
      //     being false to terminate; an i32 `0` would loop forever.
      // A fresh OOB node per use — IR nodes must not be structurally shared
      // (later passes mutate in place).
      const mkOob = () => oobNan ? oobNanIR() : ['i32.const', 0]
      const rt = oobNan ? 'f64' : 'i32'
      const widen = b => oobNan ? ['f64.convert_i32_u', b] : b
      // Shape 1: receiver is a `local.get` of a non-boxed function parameter.
      // The decomposition is correct only when the parameter's value can't
      // change after entry — boxed params are stored in heap cells and read
      // through `f64.load`, so we conservatively skip them. Non-param locals
      // are excluded too: even if narrowing concludes they're never reassigned,
      // their initialisation typically happens inside the function body and the
      // prologue would run before the init.
      if (Array.isArray(sF64) && sF64[0] === 'local.get') {
        const raw = typeof sF64[1] === 'string' ? sF64[1] : ''
        const name = raw.startsWith('$') ? raw.slice(1) : raw
        const param = ctx.func.current?.params?.find(p => p.name === name)
        const isBoxed = ctx.func.boxed?.has(name)
        // The decomposition only stays in sync if the param's f64 slot is
        // never overwritten — `s = s + 'X'` would invalidate the cached
        // base/len/sso/loadbase locals. Also require the param's wasm slot
        // to actually be `f64` (i64.reinterpret_f64 below would fail
        // validation otherwise — narrowed-to-int params have type 'i32').
        if (param && param.type === 'f64' && param.ptrKind == null
            && !isBoxed && ctx.func.body && !isReassigned(ctx.func.body, name)) {
          if (!ctx.func.charDecomp) ctx.func.charDecomp = new Map()
          let dec = ctx.func.charDecomp.get(name)
          if (!dec) {
            const base = `${name}$ccbase`
            const len = `${name}$cclen`
            const sso = `${name}$ccsso`
            // `loadbase` is the address used for the per-iter `load8_u`: equal
            // to `base` when heap (real string data) and 0 when SSO (memory[0]
            // is always valid; the loaded byte is garbage but the outer select
            // discards it). Pre-computing it in the prologue removes a
            // per-iter `select` and lets V8 fold the add into the load.
            const loadbase = `${name}$ccldb`
            const ptr64 = `${name}$ccp64`
            ctx.func.locals.set(base, 'i32')
            ctx.func.locals.set(len, 'i32')
            ctx.func.locals.set(sso, 'i32')
            ctx.func.locals.set(loadbase, 'i32')
            ctx.func.locals.set(ptr64, 'i64')   // full SSO payload for 7-bit char extraction
            dec = { base, len, sso, loadbase, ptr64, param: name }
            ctx.func.charDecomp.set(name, dec)
          }
          return emitDecompCharRead(dec, iI32, ctx, oobNan, inBounds)
        }
      }

      // Shape 1b: receiver is a `global.get` of a module global that is STABLE
      // within this function — the layered-parser hot shape (`cur.charCodeAt(idx)`
      // in subscript's space/peek/next loops, where `cur` is module state written
      // only by parse() entry, never by the scanning function). Same entry
      // decomposition as the param path. Soundness gates:
      //   - the global is never assigned in this function's body, AND
      //   - the body's only call expressions are `.charCodeAt` member calls (so
      //     no user call can transitively reassign the global mid-function), AND
      //   - no yield/await (a suspension point lets foreign code write it).
      // Gated on charDecompGlobals — only emitFunc's named-function path drains
      // the prologue (closure bodies have no collectParamInits; an undrained
      // decomposition would read len=0 and misreport every char as OOB).
      if (Array.isArray(sF64) && sF64[0] === 'global.get' && ctx.func.charDecompGlobals) {
        const raw = typeof sF64[1] === 'string' ? sF64[1] : ''
        const name = raw.startsWith('$') ? raw.slice(1) : raw
        if (name && ctx.func.body
            && !isReassigned(ctx.func.body, name)
            && bodyOnlyCharCodeAtCalls(ctx.func.body)) {
          if (!ctx.func.charDecomp) ctx.func.charDecomp = new Map()
          const key = `#g:${name}`
          let dec = ctx.func.charDecomp.get(key)
          if (!dec) {
            const base = `${name}$ccbase`
            const len = `${name}$cclen`
            const sso = `${name}$ccsso`
            const loadbase = `${name}$ccldb`
            const ptr64 = `${name}$ccp64`
            ctx.func.locals.set(base, 'i32')
            ctx.func.locals.set(len, 'i32')
            ctx.func.locals.set(sso, 'i32')
            ctx.func.locals.set(loadbase, 'i32')
            ctx.func.locals.set(ptr64, 'i64')
            dec = { base, len, sso, loadbase, ptr64, param: name, recvGlobal: `$${name}`, global: true }
            ctx.func.charDecomp.set(key, dec)
          }
          return emitDecompCharRead(dec, iI32, ctx, oobNan, inBounds)
        }
      }

      // Shape 2: generic inline form for non-param receivers.
      //
      // Both the receiver `sF64` and the index `iI32` are duplicated across the
      // SSO/heap branches (and within each branch for bounds + load). Either
      // side may be a side-effecting expression — e.g. parse.js's `str[i++]`
      // lowers to a charCodeAt whose index is a `(block (local.set $tmp
      // (f64.add (f64.load $i) 1)) (f64.store $i $tmp) (local.get $tmp))` —
      // so we MUST spill anything that isn't side-effect-free to a local
      // before referencing it more than once. Leaves (`local.get`, `*.const`,
      // `global.get`) are safe to duplicate; everything else is spilled.
      const sLeaf = isLeaf(sF64)
      const iLeaf = isLeaf(iI32)
      const ptrI64Expr = ssoI64(sF64)
      let ptrName = null
      let getPtr
      if (sLeaf) {
        getPtr = () => ssoI64(sF64)
      } else {
        ptrName = allocLocalI64(ctx, 'cc')
        getPtr = () => ['local.get', `$${ptrName}`]
      }
      let idxName = null
      let getIdx
      if (iLeaf) {
        getIdx = () => iI32
      } else {
        idxName = allocLocalI32(ctx, 'ci')
        getIdx = () => ['local.get', `$${idxName}`]
      }
      const offMask = `0x${LAYOUT.OFFSET_MASK.toString(16).toUpperCase()}`
      const offExpr = () => ['i32.wrap_i64', ['i64.and', getPtr(), ['i64.const', offMask]]]
      const ssoLen = ['i32.wrap_i64', ['i64.and', ['i64.shr_u', getPtr(), ['i64.const', 42]], ['i64.const', 7]]]
      const ssoByte = ['i32.wrap_i64', ['i64.and',
        ['i64.shr_u', getPtr(), ['i64.mul', ['i64.extend_i32_u', getIdx()], ['i64.const', 7]]],
        ['i64.const', '0x7f']]]
      const ssoBranch = ['if', ['result', rt],
        ['i32.ge_u', getIdx(), ssoLen],
        ['then', mkOob()],
        ['else', widen(ssoByte)]]
      const heapLen = ['i32.load', ['i32.sub', offExpr(), ['i32.const', 4]]]
      const heapByte = ['i32.load8_u', ['i32.add', offExpr(), getIdx()]]
      const heapBranch = ['if', ['result', rt],
        ['i32.lt_u', offExpr(), ['i32.const', 4]],
        ['then', mkOob()],
        ['else', ['if', ['result', rt],
          ['i32.ge_u', getIdx(), heapLen],
          ['then', mkOob()],
          ['else', widen(heapByte)]]]]
      const dispatch = ['if', ['result', rt],
        ['i64.ne', ['i64.and', getPtr(), ['i64.const', ssoBitI64()]], ['i64.const', 0]],
        ['then', ssoBranch],
        ['else', heapBranch]]
      if (sLeaf && iLeaf) return dispatch
      const preface = ['block', ['result', rt]]
      if (!sLeaf) preface.push(['local.set', `$${ptrName}`, ptrI64Expr])
      if (!iLeaf) preface.push(['local.set', `$${idxName}`, iI32])
      preface.push(dispatch)
      return preface
    },

    /** Content equality. Both args: f64 slot carriers. Returns i32 boolean.
     *  The bit-eq fast path is inlined at the site: static-literal dedup, SSO
     *  packing and slice interning make identical bits the DOMINANT equal case
     *  (a compiler comparing tree tags against literals hits it ~always), so
     *  most comparisons skip the __str_eq call entirely. Content compare only
     *  on bit-mismatch. */
    eq: (aF64, bF64, ctx) => {
      ctx.core.includes.add('__str_eq')
      // i64 temps allocated through the passed ctx — importing ir.js's tempI64
      // here would close the abi→ir→ctx→abi module cycle the kernel bundler
      // rejects (mirrors freshLocal's registration).
      const fresh = () => {
        let n
        do { n = `seq${ctx.func.uniq++}` } while (ctx.func.locals.has(n))
        ctx.func.locals.set(n, 'i64')
        return n
      }
      const ta = fresh(), tb = fresh()
      return ['block', ['result', 'i32'],
        ['local.set', `$${ta}`, ssoI64(aF64)],
        ['local.set', `$${tb}`, ssoI64(bF64)],
        ['if', ['result', 'i32'],
          ['i64.eq', ['local.get', `$${ta}`], ['local.get', `$${tb}`]],
          ['then', ['i32.const', 1]],
          ['else', ['call', '$__str_eq', ['local.get', `$${ta}`], ['local.get', `$${tb}`]]]]]
    },

    /** Three-way byte compare. Both args: f64 slot carriers. Returns i32 ∈ {-1, 0, 1}. */
    cmp: (aF64, bF64, ctx) => {
      ctx.core.includes.add('__str_cmp')
      return ['call', '$__str_cmp', ssoI64(aF64), ssoI64(bF64)]
    },

    /** Concat with ToString coercion on both sides. Both args: f64 slot
     *  carriers. Returns f64 (the new STRING ptr's slot carrier).
     *  Named `cat`, not `concat`: under self-host this op is invoked as a
     *  method on the statically-untyped `ctx.abi.string.ops` receiver, and the
     *  name `concat` collides with `Array.prototype.concat` — the method-call
     *  dispatcher's string/array runtime guess (emit.js) would hijack it into a
     *  bogus array concat. A non-builtin name routes through dynamic property
     *  dispatch (load the closure slot, call it) correctly. */
    // `ext` (default false) opts into the bump-EXTEND fast path — sound only when emit
    // proves `a` is dead-after (a self-accumulation `x = x + …`). Otherwise the _fresh twin
    // alloc+copies, never mutating the live `a` operand. (See __str_concat in module/string.js.)
    cat: (aF64, bF64, ctx, ext = false) => {
      const fn = ext ? '__str_concat' : '__str_concat_fresh'
      ctx.core.includes.add(fn)
      return ['call', '$' + fn, ssoI64(aF64), ssoI64(bF64)]
    },

    /** Concat assuming both sides are already strings (skip ToString). */
    concatRaw: (aF64, bF64, ctx, ext = false) => {
      const fn = ext ? '__str_concat_raw' : '__str_concat_raw_fresh'
      ctx.core.includes.add(fn)
      return ['call', '$' + fn, ssoI64(aF64), ssoI64(bF64)]
    },
  },
}

// ── jsstring ──────────────────────────────────────────────────────────────
//
// Architectural scaffold for native JS strings via JS String Builtins.
// Under this carrier, string values flow across the wasm boundary as
// `externref` instead of nanbox-tagged heap offsets. String operations
// (`length`, `charCodeAt`, `concat`, `fromCharCode`, …) are emitted as
// calls to imports from the `wasm:js-string` namespace — engine-provided
// builtins that read/write the engine's native String representation.
//
//   Spec: https://webassembly.github.io/js-string-builtins/js-api/
//   Engine support: V8 17+, Safari 18.4+, Firefox behind a flag.
//
// ### Status — scaffold, not a working codegen path
//
// Today this carrier exists to:
//   1. Slot into the default-bundle in `src/abi/index.js` so the dispatch
//      infrastructure is exercised end-to-end with two carriers.
//   2. Document the contract future string-codegen rerouting will plug into.
//   3. Outline the compiler-wide changes a real implementation requires —
//      they're larger than "fill in the ops table" and need their own plan.
//
// Until those changes land, `jsstring` is exported alongside `sso` but the
// default bundle in `src/abi/index.js` still picks `sso`. The narrower will
// flip individual sites to `jsstring` once the codegen paths below are real.
//
// ### Wire shape
//
//     (import "wasm:js-string" "length"        (func $__jss_length        (param externref) (result i32)))
//     (import "wasm:js-string" "charCodeAt"    (func $__jss_charCodeAt    (param externref i32) (result i32)))
//     (import "wasm:js-string" "concat"        (func $__jss_concat        (param externref externref) (result (ref extern))))
//     (import "wasm:js-string" "compare"       (func $__jss_compare       (param externref externref) (result i32)))
//     (import "wasm:js-string" "test"          (func $__jss_test          (param externref)            (result i32)))
//     (import "wasm:js-string" "fromCharCode"  (func $__jss_fromCharCode  (param i32)                  (result (ref extern))))
//     (import "wasm:js-string" "substring"     (func $__jss_substring     (param externref i32 i32)    (result (ref extern))))
//
// ### Compiler-wide checklist (dependency order)
//
//   1. **Import declaration channel.** Mirror `ctx.core.includes` for
//      `wasm:js-string` imports — a `ctx.core.imports` set that compile.js
//      drains into `(import ...)` nodes. The string-builtins API is feature-
//      detected (`WebAssembly.validate` with the import set), so the host
//      must either gate compile output on builtins support or polyfill the
//      imports from JS for older engines.
//
//   2. **STRING-typed locals as externref.** `ctx.func.locals` today stores
//      `'f64' | 'i32'` per local; STRING locals need `'externref'`. Touch
//      every site that declares string locals (closures, params, refinements,
//      destructuring) so the WAT `(local $name externref)` lands.
//
//   3. **emit() returns externref for STRING-typed nodes.** Today every
//      `emit(strNode)` returns f64-typed IR carrying a NaN-boxed pointer.
//      Under jsstring it must return externref-typed IR. The `asF64` call
//      sites currently feeding the carrier would route through a carrier-
//      driven `coerceSlot(emit(...))` helper instead, so the slot type swap
//      is transparent to callers.
//
//   4. **Boundary wrappers.** `src/compile.js:synthesizeBoundaryWrappers`
//      types every string param/result through f64 (or i64 for ptr carriers).
//      Read `ctx.abi.string.slotTypes[0]` — if `externref`, declare the
//      param/result `externref` and skip the nanbox box/unbox steps.
//
//   5. **Literals.** `['str', "foo"]` today writes into the heap and returns
//      a NaN-boxed pointer. Under jsstring it would need a module-level
//      `externref` global initialized from a JS-side literal table — likely
//      via a startup import that hands back the canonical `externref` for
//      each known string. Or build at runtime with `fromCharCodeArray`.
//
//   6. **Mutating fast paths.** Heap-string optimizations like
//      `__str_append_byte` (mutate in place when lhs is heap-top) don't
//      translate — engine strings are immutable. These paths must gate off
//      under jsstring (`if (slotTypes[0] === 'f64') …`) or be removed from
//      the carrier's surface entirely.
//
//   7. **Cross-carrier interop.** Mixing nanbox numeric values and externref
//      strings in the same function means locals span two slot types.
//      `i32`/`f64`/`externref` already coexist (closures use `i32` for boxed
//      cells), so the multi-slot story is incremental, not novel.
//
//   8. **`?.length`, optional access.** The `?.` emit threads `local.get`
//      through `notNullish`, which today inspects f64 NaN-shape bits.
//      `externref` nullishness is a single `ref.is_null` (no NaN inspection),
//      so the optional-chain emit needs a carrier-aware nullish predicate.
//
//   9. **Host wiring.** `interop.js` passes externref strings directly
//      (no encode/decode) and supplies the `wasm:js-string` imports object
//      when the binary references any. JS strings already act as externrefs
//      at the host boundary — the bridge mostly hands them through.

export const jsstring = {
  // Wasm slot type a string value occupies under this carrier. Read by
  // `src/compile.js:synthesizeBoundaryWrappers` for param/result typing
  // (item 4) and by the slot coercer at every STRING `emit()` call site
  // (item 3).
  slotTypes: ['externref'],

  // Names of `wasm:js-string` imports this carrier relies on. Used
  // (eventually) by the compiler to declare the import nodes once any op
  // references them.
  imports: ['length', 'charCodeAt', 'concat', 'fromCharCode', 'substring',
            'codePointAt', 'compare', 'test', 'intoCharCodeArray', 'fromCharCodeArray'],

  // Op hooks — string operations routed through this carrier. Inputs are
  // already externref-typed (the param/local that carries the value); outputs
  // are i32 (`length`, `charCodeAt`) or (for future ops) externref again.
  // Each op registers its builtin import via `ctx.core.jsstring.add(name)`;
  // `compile.js` drains the set into `(import "wasm:js-string" …)` nodes.
  ops: {
    /** Byte length. Receiver: externref. Returns i32 — caller widens to f64
     *  if it needs JS-spec `.length` (a number for the JS-visible export). */
    byteLen: (sExt, ctx) => {
      ctx.core.jsstring.add('length')
      return ['call', '$__jss_length', sExt]
    },

    /** Char code at index i. Receiver: externref; index: i32. Returns i32.
     *  `wasm:js-string.charCodeAt` traps on OOB — callers must only use this
     *  shape under an in-bounds proof (analyze.js `inBoundsCharCodeAt`). The
     *  generic OOB-NaN contract is still handled via the SSO fallback (which
     *  doesn't apply when the receiver is externref — see core.js dispatch). */
    charCodeAt: (sExt, iI32, ctx) => {
      ctx.core.jsstring.add('charCodeAt')
      return ['call', '$__jss_charCodeAt', sExt, iI32]
    },
  },
}

// Signatures for the `wasm:js-string` imports this carrier emits. Indexed by
// builtin name (the bare key drained from `ctx.core.jsstring`); `compile.js`
// builds the `(import …)` node from this table.
export const JSS_IMPORT_SIGS = {
  length:       { params: ['externref'],            result: 'i32' },
  charCodeAt:   { params: ['externref', 'i32'],     result: 'i32' },
}

// Default carrier — picked when narrower has no stronger evidence. Reached
// via `ctx.abi.string` (which the default-bundle in `src/abi/index.js` binds
// to this export).
export default sso
