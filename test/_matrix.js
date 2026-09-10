/**
 * Test-matrix axis awareness (optimize level + host).
 *
 * `npm run test:opt0|opt3` (the gated level extremes; `test:opt1` exists for
 * ad-hoc use) set `JZ_TEST_OPTIMIZE` and `test:wasi` sets `JZ_TEST_HOST`, which
 * index.js applies as compile defaults. Most tests assert
 * behaviour (correctness) and run on every leg. Two families don't:
 *
 *  1. Optimizer-OUTPUT pins — binary-size thresholds, "this pass eliminated X",
 *     SIMD advisories, vectorized-vs-baseline equality — whose premise only holds
 *     once the relevant pass ran. Guard with `if (belowOpt(N)) return`.
 *  2. JS-host-only behaviour — host/env imports, tagged-template interpolation of
 *     live JS values, externref/js-string interop, external (host) objects, host
 *     timer wiring, and the callable-`run`-export-returns-a-value pattern (`run` is
 *     the reserved void WASI command entry). These can't apply under the hostless
 *     WASI boundary. Guard with `if (onWasi()) return`.
 *
 * Guarding (vs deleting) keeps each test live on the legs where it IS meaningful.
 *
 * @module test/_matrix
 */

import { f64ToI64, i64ToF64, coerce, memory as jzMemory, type as ptrType } from '../interop.js'
import { PTR, encodePtrHi, encodeTypedElemAux } from '../layout.js'

// i64 bits for an arg: a box (BigInt, incl. coerce's null/undef sentinels) passes through;
// a number / f64 NaN-box reinterprets to its bits (intact on V8, where tests run).
const argBits = (v) => typeof v === 'bigint' ? v : f64ToI64(v)

/**
 * Adapt RAW wasm exports back to the f64 NaN-box ABI for tests that instantiate
 * directly (bypassing `jz/interop` wrap()). The i64 boundary carrier (Safari NaN-
 * canonicalization dodge) makes boxed params/results cross as i64/BigInt; this
 * reinterprets BigInt↔f64 at exactly the positions the `jz:i64exp` custom section
 * marks, so a legacy `run(code).f(x)` keeps seeing/passing f64 NaN-boxes & numbers.
 *
 * `mod` is the WebAssembly.Module (for the custom section), `raw` its instance
 * exports. With no i64 exports the raw object is returned untouched.
 */
// A NaN-box carrying the PTR.BIGINT tag (interop.js isBox and type).
const bigintBox = b => typeof b === 'bigint' && (Number((b >> 32n) & 0xFFFFFFFFn) & 0xFFF80000) === 0x7FF80000 && ptrType(b) === PTR.BIGINT

export function adaptI64(mod, raw) {
  const i64Exp = new Map()
  const sec = WebAssembly.Module.customSections(mod, 'jz:i64exp')
  if (sec.length) try { for (const e of JSON.parse(new TextDecoder().decode(sec[0]))) i64Exp.set(e.name, e) } catch { /* ignore */ }
  if (!i64Exp.size) return raw
  const out = {}
  for (const [name, fn] of Object.entries(raw)) {
    if (typeof fn !== 'function') { out[name] = fn; continue }
    const sig = i64Exp.get(name)
    if (!sig) { out[name] = fn; continue }
    const piSet = new Set(sig.p), r = sig.r, m = sig.m, t = sig.t || null
    // A `t` slot takes typed storage the raw host builds itself: allocate in the
    // instance's memory, write the TYPED header (props word, byteLen, byteLen),
    // fill from the array-like, pass the box; a `+` slot copies back after.
    const typedArg = (x, ctor, writes, back) => {
      const Ctor = globalThis[ctor]
      const src = x instanceof Ctor ? x : Ctor.from(typeof x === 'number' && x !== x ? jzMemory(raw.memory).read(x) : x)
      const bytes = src.length * Ctor.BYTES_PER_ELEMENT
      const hdr = raw._alloc(16 + bytes)
      const dv = new DataView(raw.memory.buffer)
      dv.setBigInt64(hdr, 0n, true); dv.setInt32(hdr + 8, bytes, true); dv.setInt32(hdr + 12, bytes, true)
      new Ctor(raw.memory.buffer, hdr + 16, src.length).set(src)
      if (writes && x !== null && typeof x === 'object') back.push([x, hdr + 16, src.length, Ctor])
      return (BigInt(encodePtrHi(PTR.TYPED, encodeTypedElemAux(ctor))) << 32n) | BigInt((hdr + 16) >>> 0)
    }
    out[name] = (...args) => {
      // Pad to the wasm arity: an i64 param requires a BigInt, so a missing arg must be a
      // box (UNDEF_NAN) — `undefined` throws "Cannot convert undefined to a BigInt". coerce
      // maps null/undefined → atom box; a number / f64 NaN-box reinterprets to its bits.
      while (args.length < fn.length) args.push(undefined)
      const back = []
      const a = args.map((x, i) => {
        const slot = t?.[String(i)]
        if (slot) return typedArg(x, slot.endsWith('+') ? slot.slice(0, -1) : slot, slot.endsWith('+'), back)
        return piSet.has(i) ? argBits(coerce(x)) : x
      })
      const ret = fn(...a)
      for (const [host, off, len, Ctor] of back) {
        const view = new Ctor(raw.memory.buffer, off, len)
        if (ArrayBuffer.isView(host)) host.set(view.subarray(0, host.length))
        else for (let i = 0; i < host.length && i < len; i++) host[i] = view[i]
      }
      // `m`: a multi-value tuple crosses as i64 lanes — reinterpret each back to the f64
      // NaN-box ABI (numbers restore; boxes' bits are exact on V8, where tests run).
      if (m) return ret.map(i64ToF64)
      // A boxed BigInt result (an export's result contract: the BigInt crosses
      // boxed) reads as interop's decoder reads it, the cell's payload; every
      // other box keeps its f64 bits for the raw host to inspect.
      return r ? (bigintBox(ret) ? jzMemory(raw.memory).read(ret) : i64ToF64(ret)) : ret
    }
  }
  return out
}

const env = process.env.JZ_TEST_OPTIMIZE

/** Resolved optimize level for this run. Mirrors index.js TEST_ENV_DEFAULTS:
 *  no env → compiler default (2); `false` → 0; `size` → 2; `speed` → 3; numeric → itself. */
export const OPT_LEVEL =
  env == null ? 2
  : env === 'false' ? 0
  : /^-?\d+$/.test(env) ? Number(env)
  : env === 'size' ? 2
  : env === 'speed' ? 3
  : 2

/** True when this run's optimize level is below `min` — an optimizer-output assertion
 *  can't hold, so the test should `return` early instead of asserting a false regression. */
export const belowOpt = (min) => OPT_LEVEL < min

/** Resolved compile host for this run ('js' default; 'wasi' under test:wasi). */
export const HOST = process.env.JZ_TEST_HOST || 'js'

/** True under the hostless WASI boundary — a JS-host-only assertion (env/host imports,
 *  template-interpolated JS values, externref/js-string, external objects, host timers,
 *  callable-`run`-returns-value) can't apply, so the test should `return` early. */
export const onWasi = () => HOST === 'wasi'

/** Force the BigInt retirement diagnostic (JZ_BIGINT_STRICT=1, src/ir.js
 *  bigintStrict()) for exactly the synchronous compile `fn` performs.
 *  Main-stabilization interim flip (2026-08-14, .work/archive/bigint-retirement-
 *  design.md §9): an unprovable BigInt flow boxes by DEFAULT again (the
 *  pre-Slice-1 behavior — any input program legitimately reaching boxing,
 *  including watr/subscript's own bundled BigInt sites, must keep compiling
 *  out of the box); Slice 1's own compile-time refusal is opt-in, scoped
 *  tightly around one sync call so no concurrently-running test observes
 *  the toggle (same discipline as test/watr.js's withRawCarrier). Tests
 *  that pin the diagnostic's own wording/flow-class naming wrap their
 *  compile call in this. */
export const withBigintStrict = (fn) => {
  const prev = process.env.JZ_BIGINT_STRICT
  process.env.JZ_BIGINT_STRICT = '1'
  try { return fn() }
  finally { if (prev === undefined) delete process.env.JZ_BIGINT_STRICT; else process.env.JZ_BIGINT_STRICT = prev }
}

/** True when execution compiles through the Wasm kernel. The adapter forwards
 *  supported compiler options (test/kernel-target.js). Tests that inspect ctx,
 *  profiles, or analysis snapshots use _compileInProcess explicitly; their
 *  execution checks can still use the selected target. Host-only imports and
 *  runtime facilities need their own onKernel guard. */
export const onKernel = () => process.env.JZ_TEST_TARGET === 'jz.wasm'

const SWEEP = process.env.JZ_TEST_SWEEP === '1'

/** The level an `optimize` value resolves to (src/optimize/config.js LEVEL_PRESETS). */
const levelOf = (o) => o === false || o === 0 ? 0 : o === true || o == null ? 2 : typeof o === 'object' ? levelOf(o.level) : o === 'speed' ? 3 : o === 'size' || o === 'fast' ? 2 : o

/** The levels this leg owns: its own under JZ_TEST_OPTIMIZE; the plain default leg
 *  also owns O1, which no CI leg runs (.github/workflows/test.yml). */
const LEG_LEVELS = new Set(env == null ? (HOST === 'js' ? [2, 1] : [2]) : [OPT_LEVEL])

/** The subset of `wanted` optimize values this leg runs. An in-test sweep
 *  `for (const optimize of levels(false, 2, 3))` compiles once per leg — the matrix
 *  (`npm run test:matrix`, CI's four legs) supplies the other levels — instead of
 *  every level on every leg. JZ_TEST_SWEEP=1 runs the whole list in one process.
 *  A leg whose level is not wanted runs nothing, like a belowOpt() guard. */
export const levels = (...wanted) => SWEEP ? wanted : wanted.filter(o => LEG_LEVELS.has(levelOf(o)))
