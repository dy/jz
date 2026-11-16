// The kernel-parity corpus: the source strings test/kernel-parity.js proves
// byte-identical between the native and self-compiled pipelines, test/kernel-oracle.js
// runs three ways for value parity (byte identity alone certifies identically-wrong
// output as readily as identically-right), and test/eager-stdlib-parity.js compiles
// with the stdlib preloaded.
import { BIGINT_TYPED_STORE_SOURCE } from './_bigint-typed-store-corpus.js'
import { EQ_ZERO_KERNEL } from './_optimizer-kernels.js'

export const CORPUS = {
  sum: `export let sum = (n) => { let s = 0; for (let i = 0; i < n; i++) s += i; return s }`,
  math: `export let f = (x) => Math.sqrt(x * x + 1) + Math.abs(x)`,
  // Also exercises restoration of unused value-number captures: copying a
  // WAT array with Object.assign lost its operands in the self-hosted compiler.
  dict: `export let count = (s) => { let d = {}; for (let i = 0; i < s.length; i++) { let c = s[i]; d[c] = (d[c] || 0) + 1 } return d['a'] || 0 }`,
  arr: `export let rev = (n) => { let a = []; for (let i = 0; i < n; i++) a.push(i * 2); let s = 0; for (let i = a.length - 1; i >= 0; i--) s += a[i]; return s }`,
  fold: `export let f = () => 0.1 + 0.2 - 0.3`,
  mfold: `export let g = () => Math.sqrt(9) + Math.abs(-2)`,
  // Generic peephole handoff: computed eq-zero expressions canonicalize to eqz,
  // while a bare-local zero arm stays visible to dense-switch recognition.
  eqzero: EQ_ZERO_KERNEL,
  // Compiling THIS SOURCE (not running it) is what exposed the bug: native jz
  // never runs typedarray.js's own JS through jz's compiler, only the kernel build
  // does (dist/jz.wasm = jz compiling its own source) — so a codegen defect in
  // this exact shape stayed invisible until self-compiled.
  boolconst: `const g = (n) => { if (typeof n === 'number') return n; return false }
export let f = (s) => g(s) === false`,
  nestedtyped: `export let f = (x) => new Int32Array(new Float64Array([x]))[0]`,
  // A boxed Number|BigInt local must be unboxed at a known BigInt typed-array
  // store, while a raw i64 payload with identical PTR.BIGINT tag bits must not
  // be probed.
  biginttypedstore: BIGINT_TYPED_STORE_SOURCE,
  subviewtyped: `export let f = (buf) => new Int32Array(buf, 0, new Float64Array(4).length)`,
  // (2)+(3) the DataView get/set closures (DV_GET/DV_SET loops): loadOp/
  // resultType/size/signed (get) and storeOp/valType/size (set) read after
  // emit(off)/emit(val)/emit(leNode) — reachable via a DataView receiver
  // nesting another DataView call in an offset/value position.
  dvnested: `export let f = (dv) => dv.setFloat64(dv.getInt32(0), dv.getFloat64(8))`,
  // (4) TypedArray.from's array-literal fast path: stride/store/elemType
  // re-read for element k+1 after element k's emit() — reachable when one
  // literal element is itself a nested same-family typed-array construction.
  fromnested: `export let f = () => Int32Array.from([Float64Array.from([5])[0], 2])`,
  // A result that is a Boolean or null keeps its null where it joins one
  // (summary/contract.js contractVal), and a later declarator's hoisted call
  // reads the name the earlier one set (plan/inline.js hoistNestedCalls).
  boolnull: `const f = (n) => { if (n > 2) return null; if (n > 1) return true; return false }
const parts = (n) => n > 0 ? { k: n } : null
const id = (e) => e === null ? 3 : e === undefined ? 4 : e === true ? 1 : e === false ? 0 : 5
export let tern = (n) => id(n > 0 ? f(n) : null)
export let and = (n) => { const p = parts(n), e = p && f(n); return id(e) }
export let type = (n) => typeof (n > 0 ? f(n) : null)`,
}
