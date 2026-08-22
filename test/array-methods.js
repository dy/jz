// Array methods: map, filter, reduce, forEach, find, indexOf, includes, slice
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onWasi, onKernel, adaptI64 } from './_matrix.js'
import { parse, has } from '../scripts/wat-probe.mjs'

function run(code) {
  const { module, instance } = jz(code)
  return adaptI64(module, instance.exports)
}

// jz()-based helper for regression tests that need full host wiring.
const runHost = (code) => jz(code).exports

// === .map ===

test('.map: double', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2, 3]
    let b = a.map((x) => x * 2)
    return b[0] + b[1] + b[2]
  }`)
  is(f(), 12)
})

test('.map: with capture', () => {
  const { f } = run(`export let f = (n) => {
    let a = [1, 2, 3]
    let b = a.map((x) => x + n)
    return b[0] + b[1] + b[2]
  }`)
  is(f(10), 36)  // 11+12+13
})

test('.map: preserves length', () => {
  is(run(`export let f = () => {
    let b = [10, 20, 30, 40, 50].map((x) => x / 10)
    return b.length
  }`).f(), 5)
})

// === .filter ===

test('.filter: basic', () => {
  is(run(`export let f = () => {
    let b = [1, 2, 3, 4, 5].filter((x) => x > 3)
    return b.length
  }`).f(), 2)
})

test('.filter: read elements', () => {
  const { f } = run(`export let f = () => {
    let b = [10, 5, 20, 3, 15].filter((x) => x > 8)
    return b[0] + b[1] + b[2]
  }`)
  is(f(), 45)  // 10+20+15
})

test('.filter: none match', () => {
  is(run(`export let f = () => [1, 2, 3].filter((x) => x > 10).length`).f(), 0)
})

// === .reduce ===

test('.reduce: sum', () => {
  is(run(`export let f = () => [1, 2, 3, 4, 5].reduce((s, x) => s + x, 0)`).f(), 15)
})

test('.reduce: product', () => {
  is(run(`export let f = () => [1, 2, 3, 4].reduce((p, x) => p * x, 1)`).f(), 24)
})

test('.reduce: max', () => {
  is(run(`export let f = () => [3, 7, 2, 9, 1].reduce((m, x) => { if (x > m) return x; return m }, 0)`).f(), 9)
})

// === .forEach ===

test('.forEach: runs without error', () => {
  // forEach returns 0 (void). We can't test side effects because capture is by value.
  is(run(`export let f = () => {
    let a = [1, 2, 3]
    return a.forEach((x) => x * 2)
  }`).f(), 0)
})

// === .find ===

test('.find: found', () => {
  is(run(`export let f = () => [10, 20, 30].find((x) => x > 15)`).f(), 20)
})

test('.find: not found', () => {
  ok(Number.isNaN(run(`export let f = () => [1, 2, 3].find((x) => x > 10)`).f()))
})

// === .indexOf ===

test('.indexOf: found', () => {
  is(run(`export let f = () => [10, 20, 30].indexOf(20)`).f(), 1)
})

test('.indexOf: not found', () => {
  is(run(`export let f = () => [10, 20, 30].indexOf(99)`).f(), -1)
})

// String equality must compare values, not NaN-boxed pointer bits — distinct
// allocations of the same string literal land at different heap addresses, so
// f64.eq treats them as unequal. indexOf/includes must route through __eq.
test('.indexOf: string found', () => {
  is(run(`export let f = () => ["A","B","C"].indexOf("B")`).f(), 1)
})

test('.indexOf: string via variable still matches', () => {
  is(run(`export let f = () => { let x = "B"; return ["A","B","C"].indexOf(x) }`).f(), 1)
})

// === .lastIndexOf ===
// Array.prototype.lastIndexOf — the highest matching index. Previously absent, so the
// method was force-narrowed to String (STRING_ONLY_METHODS) and `arr.lastIndexOf(x)`
// silently returned -1. Now a real array path; an UNTYPED receiver forks string-vs-array.
test('.lastIndexOf: last occurrence wins', () => {
  is(run(`export let f = () => [1, 5, 3, 5, 2].lastIndexOf(5)`).f(), 3)
  is(run(`export let f = () => [1, 5, 1, 3].lastIndexOf(1)`).f(), 2)
})
test('.lastIndexOf: not found', () => {
  is(run(`export let f = () => [1, 2, 3].lastIndexOf(9)`).f(), -1)
})
test('.lastIndexOf: untyped param array (no longer force-narrowed to string)', () => {
  is(runHost(`export let f = (a) => a.lastIndexOf(5)`).f([1, 5, 3, 5]), 3)   // host-marshalled array arg
  is(runHost(`export let f = (a) => a.lastIndexOf(9)`).f([1, 2, 3]), -1)
})
test('.lastIndexOf: string receiver still works (via the runtime fork)', () => {
  is(runHost(`export let f = (s) => s.lastIndexOf("l")`).f('hello'), 3)
  is(run(`export let f = () => "hello".lastIndexOf("l")`).f(), 3)
})

// === .includes ===

// `.includes` returns a boolean — surfaced as a real true/false at the export
// boundary (runHost decodes the NaN-boxed atom; the raw `run` instance can't).
test('.includes: found', () => {
  is(runHost(`export let f = () => [10, 20, 30].includes(20)`).f(), true)
})

test('.includes: not found', () => {
  is(runHost(`export let f = () => [10, 20, 30].includes(99)`).f(), false)
})

test('.includes: string found', () => {
  is(runHost(`export let f = () => ["A","B","C"].includes("B")`).f(), true)
})

test('.includes: string via variable still matches', () => {
  is(runHost(`export let f = () => { let x = "B"; return ["A","B","C"].includes(x) }`).f(), true)
})

// === .join ===

test('.join: default separator', () => {
  is(runHost(`export let f = () => ["A", "B", "C"].join()`).f(), 'A,B,C')
})

// === .sort ===

test('.sort: numeric ascending', () => {
  is(run(`export let f = () => {
    let a = [3, 1, 2]
    a.sort((x, y) => x - y)
    return a[0] * 100 + a[1] * 10 + a[2]
  }`).f(), 123)
})

test('.sort: numeric descending', () => {
  is(run(`export let f = () => {
    let a = [1, 3, 2]
    a.sort((x, y) => y - x)
    return a[0] * 100 + a[1] * 10 + a[2]
  }`).f(), 321)
})

test('.sort: returns the array (mutates in place)', () => {
  // r and a should both be sorted; .sort returns the receiver, not a copy.
  const { f } = run(`export let f = () => {
    let a = [3, 1, 2]
    let r = a.sort((x, y) => x - y)
    return r[0] === a[0] ? r[0] * 10 + a[2] : -1
  }`)
  is(f(), 13)
})

test('.sort: empty array', () => {
  is(run(`export let f = () => {
    let a = []
    a.sort((x, y) => x - y)
    return a.length
  }`).f(), 0)
})

test('.sort: single-element array', () => {
  is(run(`export let f = () => {
    let a = [42]
    a.sort((x, y) => x - y)
    return a[0]
  }`).f(), 42)
})

test('.sort: stable for equal keys', () => {
  // Sort by tens digit only — units digit ties must preserve insertion order.
  // Input: [22, 11, 21, 12, 23] sorted by floor(x/10) →
  // 1x's first (in original order: 11, 12), then 2x's (in original order: 22, 21, 23).
  is(run(`export let f = () => {
    let a = [22, 11, 21, 12, 23]
    a.sort((x, y) => Math.floor(x / 10) - Math.floor(y / 10))
    return a[0] * 10000 + a[1] * 100 + a[2]
  }`).f(), 111222)
})

test('.sort: comparator may mutate outer let', () => {
  // The comparator is dispatched through makeCallback (same path .find /
  // .filter use), so a closure that mutates a captured local works.
  is(run(`export let f = () => {
    let count = 0
    let a = [3, 1, 2]
    a.sort((x, y) => { count = count + 1; return x - y })
    return count > 0 && a[0] === 1 ? count : -1
  }`).f() > 0, true)
})

test('.sort: default string sort (no comparator)', () => {
  // String return needs runHost (jz wrapper decodes NaN-boxed pointers)
  is(runHost(`export let f = () => {
    let a = ['cherry', 'apple', 'banana']
    a.sort()
    return a[0] + '|' + a[1] + '|' + a[2]
  }`).f(), 'apple|banana|cherry')
})

test('.sort: default string sort on numbers (lexicographic)', () => {
  // No comparator → toString comparison: '1' < '10' < '2' → [1, 10, 2]
  is(run(`export let f = () => {
    let a = [10, 2, 1]
    a.sort()
    return a[0] * 100 + a[1] * 10 + a[2]
  }`).f(), 202)
})

// === .shift ===

test('.shift: repeated shifts update visible array', () => {
  is(run(`export let f = () => {
    let a = [10, 20, 30, 40]
    let x = a.shift()
    let y = a.shift()
    return x + y * 10 + a.length * 100 + a[0] * 1000
  }`).f(), 30410)
})

test('.shift: aliases follow shifted storage', () => {
  is(run(`export let f = () => {
    let a = [5, 6, 7]
    let b = a
    a.shift()
    return b.length * 100 + b[0] * 10 + b[1]
  }`).f(), 267)
})

test('.shift: push after shift appends after live tail', () => {
  is(run(`export let f = () => {
    let a = [1, 2, 3]
    a.shift()
    a.push(9)
    return a.length * 100 + a[0] * 10 + a[2]
  }`).f(), 329)
})

test('.shift: dynamic properties move with array', () => {
  is(run(`export let f = () => {
    let a = [1, 2, 3]
    a.name = 7
    a.shift()
    return a.name + a.length * 100 + a[0] * 10
  }`).f(), 227)
})

test('.shift: dynamic properties survive a second shift (global-table rekey)', () => {
  is(run(`export let f = () => {
    let a = [1, 2, 3, 4]
    a.name = 7
    a.shift()
    a.shift()
    return a.name + a.length * 100 + a[0] * 10
  }`).f(), 237)
})

test('.shift then grow: dynamic properties survive both (global-table move, then relocate)', () => {
  is(run(`export let f = () => {
    let a = [1, 2]
    a.name = 9
    a.shift()
    a.push(3)
    a.push(4)
    a.push(5)
    return a.name + a.length * 100 + a[0] * 10 + a[3]
  }`).f(), 434)
})

// A dyn-props membership filter over the global table must never skip a TRUE
// entry: exercise a props-carrying array (forces the global table non-empty)
// alongside a plain array whose shift/grow must stay a correct no-op miss.
test('.shift/.push: plain array unaffected by another array\'s dynamic props (filter miss stays correct)', () => {
  is(run(`export let f = () => {
    let tagged = [1, 2, 3]
    tagged.name = 7
    tagged.shift()
    let plain = [10, 20, 30]
    plain.shift()
    plain.push(40)
    plain.push(50)
    return tagged.name + plain.length * 100 + plain[0] * 10 + plain[2]
  }`).f(), 647)
})

// === .unshift ===

test('.unshift: prepends and pulls grow helper', () => {
  is(run(`export let f = () => {
    let a = [2]
    let n = a.unshift(1)
    return n * 100 + a.length * 10 + a[0]
  }`).f(), 221)
})

// === .slice ===

test('.slice: middle', () => {
  const { f } = run(`export let f = () => {
    let b = [10, 20, 30, 40, 50].slice(1, 4)
    return b.length
  }`)
  is(f(), 3)
})

test('.slice: values', () => {
  const { f } = run(`export let f = () => {
    let b = [10, 20, 30, 40, 50].slice(1, 4)
    return b[0] + b[1] + b[2]
  }`)
  is(f(), 90)  // 20+30+40
})

test('.slice: negative and omitted bounds', () => {
  const { f } = run(`export let f = () => {
    let b = [10, 20, 30, 40, 50].slice(-3)
    return b.length * 1000 + b[0] * 100 + b[1] * 10 + b[2]
  }`)
  is(f(), 6450)
})

// === .join ===

test('.join: comma sep', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2, 3]
    return a.join(",")
  }`)
  ok(isNaN(f()))  // returns NaN-boxed string pointer
})

// === Chained ===

// === .flat ===

test('.flat: nested arrays', () => {
  is(run(`export let f = () => [[1,2],[3,4],[5]].flat().length`).f(), 5)
})

test('.flat: mixed', () => {
  is(run(`export let f = () => { let a = [[10, 20], 30, [40]].flat(); return a[0] + a[1] + a[2] + a[3] }`).f(), 100)
})

// === .flatMap ===

test('.flatMap: expand', () => {
  is(run(`export let f = () => [1, 2, 3].flatMap((x) => [x, x * 2]).length`).f(), 6)
})

test('.flatMap: values', () => {
  is(run(`export let f = () => { let a = [1, 2].flatMap((x) => [x, x * 10]); return a[0] + a[1] + a[2] + a[3] }`).f(), 33)
})

test('.flatMap: preserves prior output across growth', () => {
  is(run(`export let f = () => { let a = [1, 2, 3, 4, 5].flatMap((x) => [x, x + 10]); return a.length * 100 + a[0] + a[9] }`).f(), 1016)
})

// === Chained ===

test('chain: map + reduce', () => {
  is(run(`export let f = () => [1, 2, 3].map((x) => x * x).reduce((s, x) => s + x, 0)`).f(), 14)
})

test('chain: map + filter', () => {
  let { f } = run(`export let f = () => {
    let r = [1, 2, 3, 4, 5].map((x) => x * 2).filter((x) => x > 4)
    return r[0] * 10000 + r[1] * 100 + r[2] + r.length * 1000000
  }`)
  is(f(), 3060810)  // 3*1M + 6*10K + 8*100 + 10
})

test('chain: map + filter Boolean', () => {
  is(run(`export let f = () => [0, 1, 2, 3].map((x) => x - 1).filter(Boolean).length`).f(), 3)
})

test('chain: filter + map', () => {
  let { f } = run(`export let f = () => {
    let r = [1, 2, 3, 4, 5].filter((x) => x > 2).map((x) => x * 10)
    return r[0] * 10000 + r[1] * 100 + r[2] + r.length * 1000000
  }`)
  is(f(), 3304050)  // 3*1M + 30*10K + 40*100 + 50
})

test('chain: map + forEach', () => {
  let { f } = run(`export let f = () => { let s = 0; [1, 2, 3].map((x) => x * x).forEach((x) => { s = s + x }); return s }`)
  is(f(), 14)
})

test('chain: filter + forEach', () => {
  let { f } = run(`export let f = () => { let s = 0; [1, 2, 3, 4].filter((x) => x > 2).forEach((x) => { s = s + x }); return s }`)
  is(f(), 7)
})

test('chain: filter + reduce', () => {
  is(run(`export let f = () => [1, 2, 3, 4, 5].filter((x) => x > 2).reduce((s, x) => s + x, 0)`).f(), 12)
})

// ============================================================================
// Type-aware method-dispatch regressions
// (parser/prepare crashes, missing-prop sentinels, host-typed-array spread)
// ============================================================================

test('Regression: compiler crash on toString / native-method property lookup', () => {
  // Parsing a file with a property named a native method (.toString) previously
  // crashed src/prepare.js if GENERIC_METHOD_MODULES / STATIC_METHOD_MODULES
  // implicitly matched Object.prototype.
  const src = `
    export let test = () => {
      let o = { toString: 1 }
      return o.toString
    }
  `
  let wasm
  try {
    wasm = compile(src)
    ok(wasm instanceof Uint8Array, 'Successfully compiled')
  } catch (e) {
    ok(false, `Compiler threw an error: ${e.message}`)
  }
})

test('Regression: dynamic property access on function returns undefined', () => {
  // __hash_get was failing OOB due to missing allocation header on PTR.CLOSURE.
  const { test } = runHost(`
    export let test = () => {
      let f = () => 1
      return f.prop
    }
  `)
  is(test(), undefined, 'missing property on function returns undefined')
})

test('Regression: dynamic property access on string returns undefined', () => {
  // __hash_get was failing OOB due to missing capacity header on PTR.SSO/STRING.
  const { test } = runHost(`export let test = () => "foo".prop`)
  is(test(), undefined, 'missing property on string returns undefined')
})

test('Regression: dynamic property assignment on string fails gracefully', () => {
  // JS semantics (ES2023 §13.15.2, non-strict PutValue on a primitive base):
  // the write is silently DISCARDED — `s.prop` reads back undefined. The old
  // pin asserted 42 (jz used to store string expandos in the global dyn-props
  // table), diverging from every engine; strings are primitives and now end
  // the dyn read/write paths immediately (module/collection.js STRING arms).
  const { test } = runHost(`
    export let test = () => { let s = "foo"; s.prop = 42; return s.prop }
  `)
  is(test(), undefined, 'property write on a string primitive is dropped (JS semantics)')
})

test('Regression: external method returning typed array spreads into array', () => {
  if (onWasi()) return  // wasi: js-object arg
  const host = { bytes() { return new Uint8Array([65, 66, 67]) } }
  const { exports } = jz(`export let test = (h) => {
    let out = []
    out.push(...h.bytes())
    return [out.length, out[0], out[2]]
  }`)
  const result = exports.test(host)
  is(result[0], 3)
  is(result[1], 65)
  is(result[2], 67)
})

test('Regression: external method returning typed array supports direct indexing', () => {
  if (onWasi()) return  // wasi: js-object arg
  const host = { bytes() { return new Uint8Array([65, 66, 67]) } }
  const { exports } = jz(`export let test = (h) => {
    let bytes = h.bytes()
    return [bytes.length, bytes[0], bytes[2]]
  }`)
  const result = exports.test(host)
  is(result[0], 3)
  is(result[1], 65)
  is(result[2], 67)
})

test('Regression: array literal spread copies external typed array values', () => {
  if (onWasi()) return  // wasi: js-object arg
  const host = { bytes() { return new Uint8Array([65, 66, 67]) } }
  const { exports } = jz(`export let test = (h) => {
    let out = [...h.bytes()]
    return [out.length, out[0], out[2]]
  }`)
  const result = exports.test(host)
  is(result[0], 3)
  is(result[1], 65)
  is(result[2], 67)
})

// `[...str]` spreads a string into its characters. The spread machinery decoded string
// ELEMENTS per-char (via __str_idx), but cached the source LENGTH with __len — array length,
// which is 0 for a string — so `[...str]` silently produced an empty array. Length now uses
// __str_len for a known string and a runtime STRING?__str_len:__len dispatch for an unknown
// source (a fn param, the compiler's own `[...key]`). This also closed the json self-compile
// byte-DIFF: the kernel's shape parser used `[...key]` to emit per-key char checks, so it
// dropped every key name (kernel built smaller, still correct via positional parsing) while
// jz.js (V8 spread) kept them — now both match.
test('array spread of a string yields its characters (length, indexing, map)', () => {
  is(run('export let f = () => { let a = [...("items")]; return a.length }').f(), 5, 'known-string spread length')
  is(run('export let f = () => [...("abc")].map(c => c.charCodeAt(0)).reduce((a,b)=>a+b,0)').f(), 294, 'spread → chars (97+98+99)')
  is(run('export let f = () => { let a = [..."ab", "c"]; return a.length }').f(), 3, 'string spread mixed with a literal element')
  // Unknown-source (the compiler's own `[...key]` shape): a jz string of statically-unknown
  // type — an array element / concat result — dispatches STRING?__str_len:__len at runtime.
  is(run('export let f = () => { let arr = ["items","meta"]; let a = [...arr[0]]; return a.length }').f(), 5, 'unknown-source (array element) spread length')
  is(run('export let f = () => { let s = "ab" + "cde"; let a = [...s]; return a.length }').f(), 5, 'unknown-source (concat) spread length')
  is(run('export let f = () => { let arr = ["hi"]; let a = [...arr[0]]; return a[1].charCodeAt(0) }').f(), 105, 'unknown-source spread indexing (i)')
  // typed-array + array spread still correct (no regression from the length-by-kind change)
  is(run('export let f = () => { let a = [1,2,3]; let b = [...a, 4]; return b.length * 10 + b[3] }').f(), 44, 'array spread intact')
})

test('Regression: imported function returning array with props keeps numeric indexing', () => {
  if (onKernel()) return  // kernel: host {modules} import resolution doesn't reach the single-source self-compile
  const { exports } = jz(`
    import { make } from './m.js'
    export let test = () => {
      let out = make()
      return [out.length, out[0], out[1], out._s]
    }
  `, {
    modules: {
      './m.js': `
        export const make = () => {
          let out = [97, 98]
          out._s = true
          out.valueOf = () => 'x'
          return out
        }
      `,
    },
  })
  const result = exports.test()
  is(result[0], 2)
  is(result[1], 97)
  is(result[2], 98)
  is(result[3], true)
})

// A custom `valueOf` assigned to an array must override the default when invoked.
// Regression surfaced in watr: `str()` attaches `bytes.valueOf = () => s` to a byte
// array so `string.const` can recover the original string via `.valueOf()`, and
// `normalize` distinguishes string-byte-arrays from sub-expressions via
// `arr.valueOf !== Array.prototype.valueOf`. jz ignored the assignment — calling
// `arr.valueOf()` returned the array itself — so `string.const`'s operand was
// misread as an opcode ("Unknown instruction 104").
test('valueOf: custom override on array is invoked', () => {
  const { f } = runHost(`export let f = () => {
    let a = [1, 2]
    a.valueOf = () => 'hi'
    return a.valueOf()
  }`)
  is(f(), 'hi')
})

test('valueOf: custom override differs from the original method', () => {
  const { f } = runHost(`export let f = () => {
    let a = [1, 2]
    let original = a.valueOf
    a.valueOf = () => 'hi'
    return a.valueOf === original ? 'unchanged' : 'overridden'
  }`)
  is(f(), 'overridden')
})

// An assigned `valueOf` override must win over the builtin even when the receiver
// is an ARRAY ELEMENT (`arr[0]`), not only a known-array local or a function param
// (both already handled). This is watr's `parts[0].valueOf()` shape, where
// `parts = node.slice(1)`. The committed override fix keys off the receiver's
// static type (vt === ARRAY|TYPED|OBJECT); an element read carries no such type, so
// the builtin runs and returns the receiver array — making `string.const` misread
// its string operand as an opcode ("Unknown instruction 104"). jz returns the
// receiver `[104,105]` here instead of the override's `'hi'`.
test('valueOf: override wins on an array-element receiver', () => {
  const { f } = runHost(`
    const mk = () => { let a = [104, 105]; a.valueOf = () => 'hi'; return a }
    export let f = () => { let arr = [mk()]; return arr[0].valueOf() }
  `)
  is(f(), 'hi')
})

// The comparison `arr.valueOf !== Array.prototype.valueOf` must reflect a runtime
// override — not be constant-folded from the receiver's static type. This is the
// EXACT discriminator at watr compile.js:369, which classifies a string-byte-array
// (override assigned by `str()`) as an immediate vs a sub-expression. jz only accepts
// `Array.prototype.valueOf` as a syntactic comparison RHS (it is otherwise "not in
// scope"), and folds `<arrayExpr>.valueOf === Array.prototype.valueOf` to `true`
// (so `!==` to `false`) because the receiver is statically an array — ignoring the
// assigned override. Result: every string operand misreads as an opcode
// ("Unknown instruction 104"). Distinct from the tests above, which compare against a
// captured runtime value or call `.valueOf()`; both of those already pass.
// Uses the jzify path: `Array.prototype.valueOf` only resolves under jzify (the
// path watr's build takes); the bare in-memory path rejects it as "not in scope".
test('valueOf: identity vs Array.prototype.valueOf reflects override (not static fold)', () => {
  const { f } = jz(`export let f = () => {
    let a = [104, 105]
    a.valueOf = () => 'hi'
    return a.valueOf !== Array.prototype.valueOf ? 'overridden' : 'builtin'
  }`, { jzify: true }).exports
  is(f(), 'overridden')
})

// A plain array (no override) must still compare EQUAL to Array.prototype.valueOf,
// so the fix narrows to "has an assigned override" rather than disabling the fold.
test('valueOf: plain array identity still equals Array.prototype.valueOf', () => {
  const { f } = jz(`export let f = () => {
    let a = [104, 105]
    return a.valueOf === Array.prototype.valueOf ? 'builtin' : 'overridden'
  }`, { jzify: true }).exports
  is(f(), 'builtin')
})

test('Regression: computed array receiver for indexing evaluates once', () => {
  const { test } = runHost(`
    export let test = () => {
      let count = 0
      let input = [[1]]
      let first = input.map(item => {
        count += 1
        return item.shift()
      })[0]
      return count * 10 + (first == first ? first : 9)
    }
  `)
  is(test(), 11)
})

test('Regression: ternary only evaluates the live branch', () => {
  const { test } = runHost(`
    export let test = () => {
      let bytes = []
      let buf = ''
      let code = null
      const commit = () => bytes.push(97)
      code != null ? (commit(), bytes.push(code)) : buf += 'a'
      return [bytes.length, buf.length]
    }
  `)
  const result = test()
  is(result[0], 0)
  is(result[1], 1)
})

// Regression: local-variable integer array fed through .map().join() produced
// garbage floats ('8.48e-314,...') instead of the correct string.
//
// Root cause: promoteIntArrayLiterals rewrites `let a=[1,2,3]` to
// `new Int32Array([1,2,3])` for SIMD optimization. The SIMD .map() then
// produces a PTR.TYPED (Int32Array) result. __str_join was reading elements
// with an 8-byte (f64) stride, but typed arrays have 4-byte stride for i32.
// Fix: __str_join dispatches to __typed_idx for PTR.TYPED receivers.
test('Regression: local-var integer array .map().join() matches JS (integers)', () => {
  const { f } = runHost(`export function f() {
    let a = [1, 2, 3]
    return a.map(x => x * 2).join(',')
  }`)
  is(f(), [1, 2, 3].map(x => x * 2).join(','))  // '2,4,6'
})

test('Regression: local-var integer array .map().join() matches JS (inline form parity)', () => {
  const { f, g } = runHost(`
    export function f() { let a = [1, 2, 3]; return a.map(x => x * 2).join(',') }
    export function g() { return [1, 2, 3].map(x => x * 2).join(',') }
  `)
  is(f(), '2,4,6')
  is(g(), '2,4,6')
  is(f(), g())
})

test('Regression: local-var integer array .map().join() with floats', () => {
  const { f } = runHost(`export function f() {
    let a = [1.5, 2.5, 3.5]
    return a.map(x => x * 2).join(',')
  }`)
  is(f(), [1.5, 2.5, 3.5].map(x => x * 2).join(','))  // '3,5,7'
})

test('Regression: stored map result .join() on local-var integer array', () => {
  const { f } = runHost(`export function f() {
    let a = [4, 5, 6]
    let b = a.map(x => x * 3)
    return b.join('-')
  }`)
  is(f(), [4, 5, 6].map(x => x * 3).join('-'))  // '12-15-18'
})

test('Array.from: a non-callable mapfn throws (TypeError), not an internal crash', () => {
  // Array.from(items, mapfn) spec step 2: if mapfn is defined and not callable, throw a
  // TypeError before iterating. A statically non-callable literal (boolean/number/null/object)
  // must surface this as a runtime throw — earlier a `true` mapfn slipped the callable guard
  // and crashed the compiler in the closure machinery instead.
  throws(() => run('export let f = () => Array.from([1, 2], true)').f())
  throws(() => run('export let f = () => Array.from([1, 2], false)').f())
  throws(() => run('export let f = () => Array.from([1, 2], 5)').f())
  // a real mapfn and an absent mapfn keep working
  is(run('export let f = () => { let a = Array.from([1, 2, 3], x => x * 10); return a[2] }').f(), 30)
  is(run('export let f = () => Array.from([1, 2, 3]).length').f(), 3)
})

// === Array.from: typed sources (audit-#12 P0-3) ===
// __arr_from did a raw `memory.copy(len<<3)` unconditionally — correct only for
// 8-byte f64-stride ARRAY storage. Any narrower/wider typed source (Int8..Uint32,
// Float32, view-indirected/BigInt64/BigUint64) got the wrong bytes at the wrong
// stride. Fixed: dispatch on `__ptr_type(src)` — PTR.ARRAY keeps the exact-same
// memory.copy (see the WAT-pin test below); any other type routes per-element
// through `$__typed_idx`, the same polymorphic reader `src[i]` bracket-reads use.
test('Array.from: every TypedArray element kind reads the correct value (was memory.copy garbage)', () => {
  is(run(`export let f = () => { let a = new Int8Array([1, 2, -3]); let r = Array.from(a); return r[0] * 100 + r[1] * 10 + r[2] }`).f(), 117)
  is(run(`export let f = () => { let a = new Uint8Array([1, 2, 3]); let r = Array.from(a); return r[0] * 100 + r[1] * 10 + r[2] }`).f(), 123)
  is(run(`export let f = () => { let a = new Uint8ClampedArray([1, 2, 3]); let r = Array.from(a); return r[0] * 100 + r[1] * 10 + r[2] }`).f(), 123)
  is(run(`export let f = () => { let a = new Int16Array([1, 2, -300]); let r = Array.from(a); return r[0] * 10000 + r[1] * 100 + r[2] }`).f(), 1 * 10000 + 2 * 100 - 300)
  is(run(`export let f = () => { let a = new Uint16Array([1, 2, 300]); let r = Array.from(a); return r[0] * 10000 + r[1] * 100 + r[2] }`).f(), 1 * 10000 + 2 * 100 + 300)
  is(run(`export let f = () => { let a = new Int32Array([1, 2, -70000]); let r = Array.from(a); return r[0] + r[1] + r[2] }`).f(), 1 + 2 - 70000)
  is(run(`export let f = () => { let a = new Uint32Array([1, 2, 70000]); let r = Array.from(a); return r[0] + r[1] + r[2] }`).f(), 70003)
  is(run(`export let f = () => { let a = new Float32Array([1.5, 2.5, 3.5]); let r = Array.from(a); return r[0] + r[1] + r[2] }`).f(), 7.5)
  is(run(`export let f = () => { let a = new Float64Array([1.5, 2.5, 3.5]); let r = Array.from(a); return r[0] + r[1] + r[2] }`).f(), 7.5)
})

test('Array.from: typed source + mapfn composes AFTER the correct element read', () => {
  // The SEPARATE mapfn iteration path (arrayLoop-based) had the identical bug —
  // f64-stride elemLoad on a non-f64-stride typed source. Now reads via $__typed_idx.
  is(run(`export let f = () => { let a = new Int32Array([1, 2, 3]); let r = Array.from(a, x => x * 2); return r[0] + r[1] + r[2] }`).f(), 12)
  is(run(`export let f = () => { let a = new Uint8Array([1, 2, 3]); let r = Array.from(a, x => x * 2); return r[0] + r[1] + r[2] }`).f(), 12)
  is(run(`export let f = () => { let a = new Float32Array([1.5, 2.5]); let r = Array.from(a, x => x * 2); return r[0] + r[1] }`).f(), 8)
})

test('Array.from: plain array is unaffected (fast path preserved, value + WAT)', () => {
  is(run(`export let f = () => { let a = [1, 2, 3]; let r = Array.from(a); return r[0] * 100 + r[1] * 10 + r[2] }`).f(), 123)
  is(run(`export let f = () => { let a = [1, 2, 3]; let r = Array.from(a, x => x * 2); return r[0] + r[1] + r[2] }`).f(), 12)
  if (onKernel()) return  // WAT-structure assertion — kernel leg compiles optimize:false, shape doesn't apply
  // The ARRAY-tagged fast path inside __arr_from must still be a bare memory.copy —
  // not a per-element loop — for the hot plain-array case.
  const tree = parse(`export let f = () => { let a = [1, 2, 3]; return Array.from(a) }`, 2)
  ok(has(tree, (n) => n[0] === 'memory.copy'), 'INVARIANT: __arr_from keeps memory.copy for the ARRAY fast path')
})

test('Array.from: BigInt64Array/BigUint64Array — bracket-read equivalence (carrier doctrine)', () => {
  // Whatever `src[i]` yields today is the contract; Array.from must land the SAME
  // carrier bits in `dst[i]` — not invent a new decode. Verified element-for-element
  // against the source's own bracket read, not against a hand-picked expected value.
  is(runHost(`export let f = () => {
    let a = new BigInt64Array(3); a[0] = 1n; a[1] = -2n; a[2] = 9223372036854775807n
    let r = Array.from(a)
    return (r[0] === a[0] && r[1] === a[1] && r[2] === a[2]) ? 1 : 0
  }`).f(), 1)
  is(runHost(`export let f = () => {
    let a = new BigUint64Array(3); a[0] = 1n; a[1] = 2n; a[2] = 18446744073709551615n
    let r = Array.from(a)
    return (r[0] === a[0] && r[1] === a[1] && r[2] === a[2]) ? 1 : 0
  }`).f(), 1)
})

test('Array.from: static array-like object literal reads real per-index values', () => {
  // arrayLikeLength already found the literal `length:` property; the per-index
  // VALUES were never read — every slot silently stored `undefined`. Fixed: a fully
  // static `{}` literal with a compile-time-int `length` unrolls, reading each
  // literal-index property directly (spec order: Get(0), Get(1), … ascending).
  is(run(`export let f = () => { let r = Array.from({0: 'a', length: 1}); return r[0] === 'a' ? 1 : 0 }`).f(), 1)
  is(run(`export let f = () => { let r = Array.from({0: 'a', 1: 'b', length: 2}); return (r[0] === 'a' && r[1] === 'b') ? 1 : 0 }`).f(), 1)
  // a literal-index gap (no "1" property) reads undefined, matching a real missing
  // array-like property — not a compile error, not the previous element's value.
  is(run(`export let f = () => { let r = Array.from({0: 'a', length: 2}); return r[1] === undefined ? 1 : 0 }`).f(), 1)
  is(run(`export let f = () => { let r = Array.from({0: 5, length: 1}, x => x * 2); return r[0] }`).f(), 10)
})

test('Array.from: dynamic array-like length reads real per-index values (was: documented gap, silently undefined)', () => {
  // Was the documented gap: arrayLikeLength found the literal `length:` property,
  // but a `length` that isn't a compile-time-int literal (e.g. arriving through a
  // function parameter) left every slot `undefined` — the loop knew the LENGTH,
  // never the indexed properties. Closed: `src`'s literal indices are still fully
  // known at compile time (only the loop bound is dynamic) — arrayLikeMaxIndex
  // finds the highest literal index, each present index's value evaluates once
  // up front, and the runtime loop dispatches by index instead of hardcoding
  // undefined (module/array.js, the `if (lengthExpr)` gap branch). ECMA-262
  // Array.from (22.1.2.1): LengthOfArrayLike reads `length` once, then
  // Get(arrayLike, ToString(k)) for k in [0, len) — real JS gives
  // `Array.from({0: 'a', length: 1})[0] === 'a'`.
  is(run(`export let f = (n) => { let r = Array.from({0: 'a', length: n}); return r[0] === 'a' ? 1 : 0 }`).f(1), 1)
  // A missing property (a real gap, or any index beyond the highest literal one)
  // reads undefined, same as a real array-like — not a compile error, not garbage.
  is(run(`export let f = (n) => { let r = Array.from({0: 'a', 2: 'c', length: n}); return r[1] === undefined ? 1 : 0 }`).f(3), 1)
  is(run(`export let f = (n) => { let r = Array.from({0: 'a', length: n}); return r[4] === undefined ? 1 : 0 }`).f(5), 1)
  // mapfn still runs per index against the real (or undefined-gap) element.
  is(run(`export let f = (n) => { let r = Array.from({0: 5, length: n}, x => x * 2); return r[0] }`).f(1), 10)
  // n = 0: an empty result, not a crash — the literal is still built, Array.from
  // just never iterates any index.
  is(run(`export let f = (n) => { let r = Array.from({0: 'a', length: n}); return r.length }`).f(0), 0)
})

test('Array.from(string): pin current per-char behavior (unaffected by the typed-source fix)', () => {
  is(runHost(`export let f = () => { let r = Array.from('abc'); return r[0] + r[1] + r[2] }`).f(), 'abc')
})

// === .length assignment ===

test('.length =: plain array resizes (grow & shrink), even when scalarization-eligible', () => {
  // Regression: literal arrays with only "safe" uses were scalarized / promoted to
  // Int32Array, folding the `.length` assignment TARGET into a literal —
  // `Assignment to non-variable: [null,2]`. A member write on the binding must
  // disqualify scalarization and typed promotion; resize stays an ARRAY op.
  is(run('export let f = () => { let a = [1, 2]; a.length = 5; return a.length }').f(), 5)
  is(run('export let f = () => { let a = [1, 2, 3]; a.length = 1; return a.length }').f(), 1)
  is(run('export let f = () => { let a = [1, 2]; a.length = 4; return a[0] + a.length }').f(), 5)
})

test('.length =: typed array rejects with a clear fixed-size error', () => {
  const fixedSize = /fixed-size/
  throws(() => compile('export let f = () => { let a = new Float64Array(2); a.length = 5; return a.length }'), fixedSize)
  throws(() => compile('export let f = (i) => { let a = new Float64Array(2); a[i] = 1; a.length = 5; return a.length }'), fixedSize)
  throws(() => compile('export let f = () => { let a = new Float64Array(2); a.length++; return a.length }'), fixedSize)
})

// === TypedArray .fill — regression for the silent-no-op bug ===
// The plain-array `__arr_fill` gates on PTR.ARRAY and silently returned a typed
// array UNCHANGED (a wrong result, no error). `.typed:fill` now loops the
// element-width-aware `__typed_set_idx` over the clamped range.

test('.fill: typed array fills (was a silent no-op)', () => {
  const { f } = runHost(`export let f = (n) => { let a = new Float64Array(n); a.fill(5); return a[0] + a[n - 1] }`)
  is(f(4), 10)
})

test('.fill: typed widths truncate like JS (Uint8 wraps, Int32 exact)', () => {
  const u8 = runHost(`export let f = () => { let a = new Uint8Array(4); a.fill(300); return a[0] }`).f
  const i32 = runHost(`export let f = () => { let a = new Int32Array(4); a.fill(-7); let s = 0; for (let i = 0; i < 4; i++) s += a[i]; return s }`).f
  is(u8(), 44)      // 300 & 255
  is(i32(), -28)
})

test('.fill: start/end and negatives clamp like JS', () => {
  const r = runHost(`export let f = () => {
    let a = new Float64Array(5); a.fill(9, 1, 3); a.fill(2, -1)
    let s = 0; for (let i = 0; i < 5; i++) s = s * 10 + a[i]
    return s
  }`).f
  is(r(), 9900 + 2)   // [0,9,9,0,2]
})

test('.fill: returns the array (chainable) + plain arrays still work', () => {
  is(runHost(`export let f = () => { let a = new Float64Array(3); return a.fill(4)[1] }`).f(), 4)
  is(run(`export let f = () => { let a = [1, 2, 3, 4]; a.fill(9); return a[0] + a[3] }`).f(), 18)
})

// === TypedArray .at — element-width bug (garbage even for a VALID index) ===
// No `.typed:at` ever existed, so a typed receiver fell through to the generic
// (non-ARRAY) `.array:at` path, which unconditionally f64.loads at off+t*8 — correct
// only for the 8-byte-wide kinds (Float64Array, BigInt64/BigUint64Array; the wrong
// opcode happened to read the right bytes there). Every narrower kind read the wrong
// OFFSET at the wrong WIDTH even in range: `new Int32Array([10,20,30]).at(1)` read
// garbage instead of 20. Now routes through the same resolveElem/elemLoadIR/SHIFT
// machinery `.typed:[]` (bracket read) already proves correct per width.
test('.at: every element width reads the correct value (was garbage for all but f64)', () => {
  is(runHost(`export let f = () => new Int8Array([10, 20, 30]).at(1)`).f(), 20)
  is(runHost(`export let f = () => new Uint8Array([10, 20, 30]).at(1)`).f(), 20)
  is(runHost(`export let f = () => new Uint8ClampedArray([10, 20, 30]).at(1)`).f(), 20)
  is(runHost(`export let f = () => new Int16Array([10, 20, 30]).at(1)`).f(), 20)
  is(runHost(`export let f = () => new Uint16Array([10, 20, 30]).at(1)`).f(), 20)
  is(runHost(`export let f = () => new Int32Array([10, 20, 30]).at(1)`).f(), 20)
  is(runHost(`export let f = () => new Uint32Array([10, 20, 30]).at(1)`).f(), 20)
  is(runHost(`export let f = () => new Float32Array([10, 20, 30]).at(1)`).f(), 20)
  is(runHost(`export let f = () => new Float64Array([10, 20, 30]).at(1)`).f(), 20)
})

test('.at: negative index (relative to length), all widths agree with the f64 baseline', () => {
  is(runHost(`export let f = () => new Int32Array([10, 20, 30]).at(-1)`).f(), 30)
  is(runHost(`export let f = () => new Uint8Array([10, 20, 30]).at(-2)`).f(), 20)
  is(runHost(`export let f = () => new Float64Array([10, 20, 30]).at(-3)`).f(), 10)
})

test('.at: out-of-range (positive, negative, Infinity, -Infinity, huge) → undefined, not garbage', () => {
  const oob = (ctor, idx) => runHost(`export let f = () => { let v = new ${ctor}([10, 20, 30]).at(${idx}); return v === undefined ? -999999 : v }`).f()
  for (const ctor of ['Int8Array', 'Int32Array', 'Float32Array', 'Float64Array']) {
    is(oob(ctor, 3), -999999, `${ctor}.at(3)`)
    is(oob(ctor, -4), -999999, `${ctor}.at(-4)`)
    is(oob(ctor, 10), -999999, `${ctor}.at(10)`)
    is(oob(ctor, 'Infinity'), -999999, `${ctor}.at(Infinity)`)
    is(oob(ctor, '-Infinity'), -999999, `${ctor}.at(-Infinity)`)
    is(oob(ctor, '1e20'), -999999, `${ctor}.at(1e20)`)
  }
})

// Compared via BigInt `===`/arithmetic (both correctly recognize .at()'s bigint result),
// not Number(...) — Number() has its OWN unrelated, pre-existing gap on this shape: kind.js
// (~line 838) special-cases the BRACKET-index node `a[i]` on a BigInt64/BigUint64Array
// receiver to statically claim VAL.BIGINT (steering Number()/bigIntDomain off the generic
// NaN-boxed decode path); no equivalent case exists for a `.at(i)` METHOD-CALL node, method
// or typed-array agnostic — grepped, zero hits for 'at' in kind.js/type.js/kind-traits.js.
// So `Number(bigTypedArr.at(i))` decodes the raw i64 bits as if NaN-boxed-tagged (wrong —
// they're untagged native bits) and returns garbage — confirmed live pre-existing (same
// under the old un-fixed .at() path, which also returned a bare untagged 'f64' node), out
// of scope for the width/offset bug this block fixes.
test('.at: BigInt64Array/BigUint64Array', () => {
  const f = runHost(`export let f = () => { let a = new BigInt64Array(3); a[0]=1n;a[1]=2n;a[2]=3n; return a.at(-1) === 3n ? 1 : 0 }`).f
  const u = runHost(`export let f = () => { let a = new BigUint64Array(3); a[0]=1n;a[1]=2n;a[2]=3n; return a.at(1) === 2n ? 1 : 0 }`).f
  const arith = runHost(`export let f = () => { let a = new BigInt64Array(3); a[0]=1n;a[1]=2n;a[2]=3n; return a.at(-1) + 10n === 13n ? 1 : 0 }`).f
  is(f(), 1)
  is(u(), 1)
  is(arith(), 1)
})

test('.at: view (subarray) receiver reads through the descriptor, kind-aware', () => {
  const f = runHost(`export let f = () => new Int16Array([1, 2, 3, 4, 5]).subarray(1, 4).at(-1)`).f
  is(f(), 4)
})

test('.at: opaque/polymorphic receiver (element kind not provable at compile time) dispatches dynamically', () => {
  const f = runHost(`export let f = (which) => {
    let t = which ? new Int8Array([10, 20, 30]) : new Float32Array([10, 20, 30])
    return t.at(1)
  }`).f
  is(f(1), 20)
  is(f(0), 20)
})

// === TypedArray .reverse / .copyWithin / .sort — same silent-no-op bug class ===
// `.reverse`/`.sort` routed through the PTR.ARRAY-gated plain-array helpers and
// returned the typed receiver UNCHANGED; `.copyWithin` was unimplemented. Each now
// has a `.typed:*` emitter going through the element-kind-aware get/set helpers.

test('.reverse: typed array reverses (was a silent no-op), all widths', () => {
  const f64 = runHost(`export let f = () => { let a = new Float64Array(3); a[0]=1; a[1]=2; a[2]=3; a.reverse(); return a[0]*100+a[1]*10+a[2] }`).f
  const u8 = runHost(`export let f = () => { let a = new Uint8Array(4); a[0]=10; a[1]=20; a[2]=30; a[3]=40; a.reverse(); return a[0]*1000+a[3] }`).f
  const i16 = runHost(`export let f = () => { let a = new Int16Array(2); a[0]=-5; a[1]=7; a.reverse(); return a[0]*100+a[1] }`).f
  is(f64(), 321)
  is(u8(), 40010)
  is(i16(), 695)   // [-5,7] → [7,-5]: 7*100 + -5
})

test('.reverse: returns the array (chainable)', () => {
  is(runHost(`export let f = () => { let a = new Int32Array(3); a[0]=1; a[1]=2; a[2]=3; return a.reverse()[0] }`).f(), 3)
})

test('.copyWithin: typed array (was unimplemented), overlap + negatives like JS', () => {
  const basic = runHost(`export let f = () => { let a = new Float64Array(5); for (let i=0;i<5;i++) a[i]=i+1; a.copyWithin(0,3); let s=0; for (let i=0;i<5;i++) s=s*10+a[i]; return s }`).f
  const overlap = runHost(`export let f = () => { let a = new Int32Array(5); for (let i=0;i<5;i++) a[i]=i+1; a.copyWithin(1,0,3); let s=0; for (let i=0;i<5;i++) s=s*10+a[i]; return s }`).f
  const neg = runHost(`export let f = () => { let a = new Uint8Array(5); for (let i=0;i<5;i++) a[i]=i+1; a.copyWithin(-2,-4,-1); let s=0; for (let i=0;i<5;i++) s=s*10+a[i]; return s }`).f
  is(basic(), 45345)     // [4,5,3,4,5]
  is(overlap(), 11235)   // [1,1,2,3,5]
  is(neg(), 12323)       // [1,2,3,2,3]
})

test('.sort: typed default is NUMERIC, not lexicographic (the key distinction)', () => {
  // Array.prototype.sort default is string order: [10,9,100] → [10,100,9].
  // TypedArray default is numeric: → [9,10,100]. Must not route through __arr_sort.
  const f = runHost(`export let f = () => { let a = new Uint8Array(3); a[0]=10; a[1]=9; a[2]=100; a.sort(); return a[0]*10000+a[1]*100+a[2] }`).f
  is(f(), 91100)   // [9,10,100]
})

test('.sort: floats, negatives, NaN-to-end, -0 before +0', () => {
  const mixed = runHost(`export let f = () => { let a = new Float64Array(5); a[0]=-1.5; a[1]=2; a[2]=-3; a[3]=0.5; a[4]=-3; a.sort(); let s=''; for (let i=0;i<5;i++) s+=a[i]+','; return s }`).f
  const nan = runHost(`export let f = () => { let a = new Float64Array(4); a[0]=3; a[1]=NaN; a[2]=1; a[3]=2; a.sort(); return (a[3]!==a[3])?(a[0]*100+a[1]*10+a[2]):-1 }`).f
  const negzero = runHost(`export let f = () => { let a = new Float64Array(3); a[0]=0; a[1]=-0; a[2]=0; a.sort(); return 1/a[0] }`).f
  is(mixed(), '-3,-3,-1.5,0.5,2,')
  is(nan(), 123)            // NaN sorted to a[3]; [1,2,3,NaN]
  is(negzero(), -Infinity)  // -0 sorted first → 1/-0 = -Infinity
})

test('.sort: with a comparator (insertion sort, closure per compare)', () => {
  const desc = runHost(`export let f = () => { let a = new Float64Array(4); a[0]=1; a[1]=3; a[2]=2; a[3]=4; a.sort((x,y)=>y-x); return a[0]*1000+a[1]*100+a[2]*10+a[3] }`).f
  is(desc(), 4321)
})

test('.sort: BigInt64 numeric compare on exact bits', () => {
  const f = runHost(`export let f = () => { let a = new BigInt64Array(3); a[0]=30n; a[1]=10n; a[2]=20n; a.sort(); return Number(a[0])*100+Number(a[2]) }`).f
  is(f(), 1030)   // [10n,20n,30n]
})

// === TypedArray .keys / .entries / .lastIndexOf ===
// .keys/.entries fell through collViewDyn's else (return the receiver), so .keys
// yielded VALUES and .entries yielded scalars; .lastIndexOf was unimplemented.

test('.keys: typed yields INDICES, not values (was returning values)', () => {
  const f = runHost(`export let f = () => { let a = new Float64Array(3); a[0]=5; a[1]=6; a[2]=7; let s=0; for (let k of a.keys()) s = s*10 + k; return s }`).f
  is(f(), 12)   // indices 0,1,2 → 012 (not values 5,6,7)
})

test('.entries: typed yields [index, element] pairs, kind-aware', () => {
  const f = runHost(`export let f = () => { let a = new Float64Array(3); a[0]=8; a[1]=9; a[2]=10; let s=0; for (let e of a.entries()) s += e[0]*1000 + e[1]; return s }`).f
  const i16 = runHost(`export let f = () => { let a = new Int16Array(2); a[0]=-3; a[1]=7; let s=0; for (let e of a.entries()) s += e[0]*100 + e[1]; return s }`).f
  is(f(), 3027)    // (0,8)+(1,9)+(2,10) = 8 + 1009 + 2010
  is(i16(), 104)   // (0,-3)+(1,7) = -3 + 107
})

test('.values: typed still yields values (unchanged); plain keys/entries unregressed', () => {
  is(runHost(`export let f = () => { let a = new Float64Array(3); a[0]=2; a[1]=3; a[2]=4; let s=0; for (let v of a.values()) s+=v; return s }`).f(), 9)
  is(run(`export let f = () => { let a = [5,6,7]; let s=0; for (let k of a.keys()) s+=k; return s }`).f(), 3)
  is(run(`export let f = () => { let a = [5,6]; let s=0; for (let e of a.entries()) s+=e[0]*10+e[1]; return s }`).f(), 21)
})

test('.lastIndexOf: typed (was unimplemented), incl. fromIndex + negative', () => {
  const hit = runHost(`export let f = () => { let a = new Float64Array(5); a[0]=1;a[1]=2;a[2]=1;a[3]=3;a[4]=1; return a.lastIndexOf(1) }`).f
  const miss = runHost(`export let f = () => { let a = new Int32Array(4); a[0]=1;a[1]=2;a[2]=3;a[3]=4; return a.lastIndexOf(9) }`).f
  const fromIdx = runHost(`export let f = () => { let a = new Float64Array(5); a[0]=1;a[1]=2;a[2]=1;a[3]=3;a[4]=1; return a.lastIndexOf(1, 3) }`).f
  const negIdx = runHost(`export let f = () => { let a = new Float64Array(5); a[0]=1;a[1]=2;a[2]=1;a[3]=3;a[4]=1; return a.lastIndexOf(1, -2) }`).f
  is(hit(), 4)
  is(miss(), -1)
  is(fromIdx(), 2)   // last 1 at index ≤ 3
  is(negIdx(), 2)    // -2 → index 3; last 1 at index ≤ 3
})

test('.findLast / .findLastIndex: typed (was reading f64 garbage)', () => {
  const fl = runHost(`export let f = () => { let a = new Float64Array(4); a[0]=3;a[1]=1;a[2]=4;a[3]=1; return a.findLast(x => x < 4) }`).f
  const fli = runHost(`export let f = () => { let a = new Float64Array(4); a[0]=3;a[1]=1;a[2]=4;a[3]=1; return a.findLastIndex(x => x < 4) }`).f
  const u8 = runHost(`export let f = () => { let a = new Uint8Array(4); a[0]=10;a[1]=5;a[2]=20;a[3]=5; return a.findLast(x => x < 15) }`).f
  const miss = runHost(`export let f = () => { let a = new Int32Array(3); a[0]=1;a[1]=2;a[2]=3; return a.findLastIndex(x => x > 9) }`).f
  is(fl(), 1)    // last element < 4 is a[3]=1
  is(fli(), 3)   // its index
  is(u8(), 5)    // last u8 < 15 is a[3]=5 (kind-aware, not f64 garbage)
  is(miss(), -1)
})

test('.indexOf / .includes: typed honor fromIndex (was ignored)', () => {
  const io = runHost(`export let f = () => { let a = new Float64Array(4); a[0]=3;a[1]=1;a[2]=4;a[3]=1; return a.indexOf(1, 2) }`).f
  const ioNeg = runHost(`export let f = () => { let a = new Float64Array(4); a[0]=3;a[1]=1;a[2]=4;a[3]=1; return a.indexOf(1, -1) }`).f
  const inc = runHost(`export let f = () => { let a = new Float64Array(4); a[0]=3;a[1]=1;a[2]=4;a[3]=1; return a.includes(3, 1) ? 1 : 0 }`).f
  is(io(), 3)      // first 1 at index ≥ 2
  is(ioNeg(), 3)   // -1 → start at index 3
  is(inc(), 0)     // 3 is at index 0, excluded by fromIndex 1
})

// === TypedArray ES2023 immutable methods: toReversed / toSorted / with ===
// All return a fresh typed array (receiver unchanged); were unimplemented (threw).

test('.toReversed: reversed copy, original untouched', () => {
  const r = runHost(`export let f = () => { let a = new Float64Array(3); a[0]=1; a[1]=2; a[2]=3; let b = a.toReversed(); return b[0]*100 + b[2]*10 + a[0] }`).f
  is(r(), 311)   // b=[3,2,1] → 3*100+1*10; a[0] still 1
})

test('.toSorted: sorted copy (numeric default + comparator), original untouched', () => {
  const num = runHost(`export let f = () => { let a = new Float64Array(4); a[0]=3;a[1]=1;a[2]=4;a[3]=1; let b = a.toSorted(); return b[0]*1000+b[3]*100 + a[0] }`).f
  const u8 = runHost(`export let f = () => { let a = new Uint8Array(3); a[0]=10; a[1]=9; a[2]=100; return a.toSorted()[0]*1000 + a.toSorted()[2] }`).f
  const cb = runHost(`export let f = () => { let a = new Int32Array(3); a[0]=1; a[1]=3; a[2]=2; return a.toSorted((x,y)=>y-x)[0] }`).f
  is(num(), 1403)   // b=[1,1,3,4] → 1*1000+4*100; a[0] still 3
  is(u8(), 9100)    // numeric (not lexicographic): [9,10,100]
  is(cb(), 3)       // descending comparator
})

test('.with: copy with one element replaced; negative index; OOB throws', () => {
  const w = runHost(`export let f = () => { let a = new Float64Array(3); a[0]=1; a[1]=2; a[2]=3; let b = a.with(1, 9); return b[1]*10 + a[1] }`).f
  const neg = runHost(`export let f = () => { let a = new Float64Array(3); a[0]=1; a[1]=2; a[2]=3; return a.with(-1, 9)[2] }`).f
  is(w(), 92)    // b[1]=9; a[1] still 2
  is(neg(), 9)   // -1 → last index
  throws(() => runHost(`export let f = () => { let a = new Float64Array(3); return a.with(5, 9)[0] }`).f(), /.*/)
})

// === TypedArray .subarray — a zero-copy aliasing VIEW (not a copy) ===
// Was unimplemented (threw). Subtlety: small typed arrays are scalarized/mirrored, which
// desyncs a persistent view from the array's storage — so a `subarray` receiver must be
// kept memory-backed (createsTypedArrayAlias in plan/literals.js). f64 element writes
// through the view were the canary for that bug.

test('.subarray: zero-copy view — writes alias the parent both ways (all sizes)', () => {
  const small = runHost(`export let f = () => { let a = new Float64Array(5); for (let i=0;i<5;i++) a[i]=i+1; let v = a.subarray(1,4); v[1]=77; a[3]=88; return v[0]*1+v[1]*10+v[2]*100 + a[2]*1000 }`).f
  const large = runHost(`export let f = () => { let a = new Float64Array(100); for (let i=0;i<100;i++) a[i]=i+1; let v = a.subarray(1,4); v[1]=77; return a[2] }`).f
  is(small(), 88*100 + 77*10 + 2 + 77*1000)  // v=[2,77,88]; a[2]=77 (v[1] wrote it)
  is(large(), 77)
})

test('.subarray: read, negative indices, one/zero args, length+byteOffset', () => {
  is(runHost(`export let f = () => { let a = new Int32Array(5); for (let i=0;i<5;i++) a[i]=i*2; return a.subarray(1,4).join("-") }`).f(), '2-4-6')
  is(runHost(`export let f = () => { let a = new Float64Array(6); for (let i=0;i<6;i++) a[i]=i+1; return a.subarray(-4,-1).join("-") }`).f(), '3-4-5')
  is(runHost(`export let f = () => { let a = new Float64Array(5); for (let i=0;i<5;i++) a[i]=i+1; return a.subarray(2).join("-") }`).f(), '3-4-5')
  is(runHost(`export let f = () => { let a = new Float64Array(5); let v = a.subarray(1,4); return v.length*100 + v.byteOffset }`).f(), 308)
})

test('.subarray: chained methods + sub-of-sub + Uint8 kind-aware', () => {
  is(runHost(`export let f = () => { let a = new Uint8Array(5); for (let i=0;i<5;i++) a[i]=i+1; return a.subarray(1,4).map(x=>x*10).join("-") }`).f(), '20-30-40')
  is(runHost(`export let f = () => { let a = new Float64Array(6); for (let i=0;i<6;i++) a[i]=i+1; let v = a.subarray(1,5); let w = v.subarray(1,3); w[0]=88; return a[2] }`).f(), 88)
  is(runHost(`export let f = () => { let a = new Int16Array(5); for (let i=0;i<5;i++) a[i]=i*3; let v = a.subarray(2); v[0]=-9; return a[2] }`).f(), -9)
})

// Integer-index contract (asm.js-style; see README "differences with JS"). An index
// coerces to i32, so a fractional/NaN index TRUNCATES rather than yielding JS's
// `undefined`. Typed-array access is raw (no bounds check) — the speed primitive that
// makes the hot loops competitive; plain `[]` arrays stay bounds-checked. This pins the
// contract so it stays intentional (and distinct from the object numeric-KEY path, which
// IS JS-correct via __i32_to_str). NOT a JS-parity claim — a documented divergence.
test('array index contract: i32-truncating, typed raw, plain bounds-checked', () => {
  // Fractional/NaN index TRUNCATES to a valid in-bounds element (the contract), not JS's undefined.
  is(run(`export let f = () => { const a=[11,22]; return a[1.5] }`).f(), 22)   // →a[1]; JS: undefined
  is(run(`export let f = () => { const a=[11,22]; return a[NaN] }`).f(), 11)   // →a[0]; JS: undefined
  is(run(`export let f = () => { const a=new Float64Array(2); a[0]=11; a[1]=22; return a[1.5] }`).f(), 22)
  is(run(`export let f = () => { const a=new Float64Array(2); a[0]=11; a[1]=22; return a[NaN] }`).f(), 11)
  // Plain `[]` arrays ARE bounds-checked: OOB / negative → undefined (surfaces as NaN at the f64
  // return boundary), NOT a raw read. (A typed array would read raw memory — the speed primitive.)
  ok(Number.isNaN(run(`export let f = () => { const a=[11,22]; return a[5] }`).f()), 'plain OOB → undefined')
  ok(Number.isNaN(run(`export let f = () => { const a=[11,22]; return a[-1] }`).f()), 'plain negative → undefined')
})

// A small fixed typed array whose reference is CAPTURED (bound, stored, or subarray'd)
// must not be scalarized/mirrored — a write through the captured alias has to reach the
// original. (subarray was the canary; the same class hit `let b = a`, `o.x = a`, `[a]`.)
test('typed array: writes through a captured alias reach the original (no scalarize desync)', () => {
  is(runHost(`export let f = () => { let a = new Float64Array(5); for (let i=0;i<5;i++) a[i]=i+1; let b = a; b[0]=99; return a[0] }`).f(), 99)
  is(runHost(`export let f = () => { let a = new Float64Array(5); for (let i=0;i<5;i++) a[i]=i+1; let o = {x:a}; o.x[0]=99; return a[0] }`).f(), 99)
  is(runHost(`export let f = () => { let a = new Float64Array(5); for (let i=0;i<5;i++) a[i]=i+1; let arr = [a]; arr[0][0]=99; return a[0] }`).f(), 99)
})

// `new T([literals])` / `T.from([…])` builds the typed array natively — alloc + one
// native-typed store per element — rather than materializing a boxed-f64 ARRAY (every
// element a 9-byte f64.const) and a per-element f64→elem copy loop. Pins both the
// correctness across element kinds AND the absence of the round-trip (no copy loop, and
// no f64.store for the integer views). The shape jz's own copy-loop→from fusion emits
// (vm's instruction table: 1977→1382 B once this stopped round-tripping through f64).
test('typed array from literal: native build, no f64 round-trip', () => {
  // correctness across signed/unsigned/width/float element kinds
  is(runHost(`export let f = () => { const a = new Int32Array([10, 20, 30]); return (a[0]+a[1]+a[2])|0 }`).f(), 60)
  is(runHost(`export let f = () => { const a = Int32Array.from([10, 20, 30, 40]); return (a[0]+a[3])|0 }`).f(), 50)
  is(runHost(`export let f = () => { const a = new Uint8Array([255, 256, 1]); return (a[0]+a[1]+a[2])|0 }`).f(), 256) // 255 + 0 (wrap) + 1
  is(runHost(`export let f = () => { const a = new Int16Array([-1, 32768]); return (a[0]+a[1])|0 }`).f(), -32769)     // -1 + (-32768)
  is(runHost(`export let f = () => { const a = new Float64Array([1.5, 2.25, 3.125]); return a[0]+a[1]+a[2] }`).f(), 6.875)
  is(runHost(`export let f = () => { const a = new Float32Array([0.5, 0.25]); return a[0]+a[1] }`).f(), 0.75)
  // element expressions (not just constants) also build directly
  is(runHost(`export let f = (x) => { const a = new Int32Array([x, x*2, x*3]); return (a[0]+a[1]+a[2])|0 }`).f(7), 42)

  // an integer view from an int literal carries NO f64.store and NO copy loop
  const wat = compile(`export const f = () => { const a = new Int32Array([1, 2, 3, 4, 5, 6]); return (a[0]+a[5])|0 }`, { wat: true, optimize: { level: 'size' } })
  ok(!/f64\.store/.test(wat), 'no f64.store: integer literal stored as i32 directly, not via a boxed-f64 array')
  ok(!/\(loop/.test(wat), 'no copy loop: each element stored inline')
})

// `.every()` on a typed-array FIELD of a heap-returned object crashed the
// compiler ("internal: Cannot read properties of null (reading '0')") — the
// receiver's element type flows through an object schema, not a local
// binding, so `resolveElem` (module/typedarray.js) can't trace it back to a
// `new XArray(...)` ctor and `typedLoop` returned null. TWO compounding bugs:
// (1) emit.js's `tryStaticDispatch` treated ANY non-undefined return from a
// `.${vt}:${method}` emitter — including this `null` "can't handle it" sentinel
// — as a definitive match, so dispatch stopped instead of falling through to a
// working strategy, and the null IR reached a consumer and crashed; (2) even
// with (1) fixed, "fall through" would have meant module/array.js's generic
// `.every` (`arrayLoop`), which assumes 8-byte f64-boxed elements — wrong for a
// real typed array's packed native bytes (proven separately: the sibling
// `.map` case, which already had its own "fall back to generic" special case,
// silently returns garbage — a latent bug of the same shape, left as-is since
// no test exercises it and it isn't one of this pass's 18). Fixed at the root:
// `typedLoop` (shared by every/some/find*/indexOf/includes/reduce/forEach) now
// falls back to `__typed_get_idx` — the same runtime aux-tag dispatch
// `.reverse`/`.sort`/`.fill`/`.copyWithin` already use unconditionally — when
// the concrete element kind can't be proven statically. Live instance:
// time-stretch/psola.js (`norm.every((v) => v <= 1e-8)` on a render()-returned
// buffer pair).
test('every: typed-array field of heap-returned object', () => {
  const { test } = runHost(`
    let render = (n) => {
      let norm = new Float32Array(n)
      for (let i = 0; i < n; i++) norm[i] = 0
      return { norm }
    }
    export let test = (n) => {
      let { norm } = render(n)
      if (norm.every((value) => value <= 1e-8)) return 1
      return 0
    }`)
  is(test(4), 1)
})

// `typedArray.set(src)` on an array held in a DYNAMICALLY-ADDED struct field was a
// silent no-op — a receiver whose static type is fully unknown (a dyn-prop field
// carries no schema/ctor tracking at all) never reached ANY `.typed:*` emitter:
// emitMethodCall's dispatch has no arm for "unknown-type receiver, but a
// TYPED-specific emitter also exists for this method name" (the sibling of the
// STRING-vs-generic runtime fork it already has), so `.set` fell to the generic
// emitter — module/collection.js's `Map.prototype.set(key, val)` — silently
// mistaking the source array for a Map key. (Confirmed the same root cause is
// not `.set`-specific: `.forEach`/`.fill` on the identical shape misfired too —
// a 3-element Float64Array's `.forEach` callback fired 24 times, 3 × its 8-byte
// stride, because the generic path also misreads a typed array's BYTE-length
// header as a raw element count.) Fixed with a new runtime ptr-type fork
// (src/compile/emit.js, mirrors the existing string fork) that checks the
// receiver's actual tag and dispatches `.typed:${method}` when it really is a
// typed array. The same local binding or a literal-schema field already worked
// (vt was known there, reaching `.typed:set` via static dispatch). Live
// instance: time-stretch pvoc/pvoc-lock/transient (`state.prev = new
// Float64Array(n)` on the stftBatch state object, then `state.prev.set(phase)`
// each frame — WASM output silently diverged from JS).
// An earlier emit-side attempt at this fix miscompiled the SELF-COMPILE kernel
// (tokenizer lost `let`). THIS session's re-attempt (probed on fd593164):
// root-caused the earlier miscompile's likely mechanism first — a SECOND,
// competing runtime fork racing the existing string fork. TYPED and STRING
// share five method names (at/includes/indexOf/lastIndexOf/slice); a fork
// bolted on separately from the string one has to re-decide, on its own, which
// of the two checks a shared method name first, and can silently misroute a
// real string through the wrong arm (the self-hosted tokenizer is
// string-method-heavy: `source.slice(i, j)` etc.). Avoided by construction:
// added the `.typed:${method}` case to tryRuntimeStringFork's OWN dispatch
// (src/compile/emit.js) via the existing dispatchByPtrType helper — STRING
// still checked first, TYPED second, generic last, one decision instead of
// two competing ones. Correctness is solid: `npm run build` + kernel-oracle
// (539/539 AGREE-tier assertions, native vs kernel vs JS-oracle) + kernel-parity
// (byte-identical WAT at O2/O3) all passed clean on a dist/jz.wasm built with
// this diff, plus this test's own runtime result and forEach/fill/slice/Map.set
// differential probes — no logic or semantic defect found anywhere.
// NOT LANDED — self-compile BUILD reliability regresses. `node scripts/build-
// dist.mjs` / `scripts/self-compile-build.mjs` (both: native jz compiling its
// own ~159-module source graph at -O3) call watr's assemble() and, WITH this
// diff applied, die there 4 of 5 runs with "Unknown instruction null" (a
// memidx/data-segment site, watr/src/compile.js) — including two failures on
// scripts/build-dist.mjs itself, the exact script the ONE success came from
// (byte-for-byte the same source: the build is flaky, not just script-
// dependent). WITHOUT this diff (src/autoload.js's fix alone, or an untouched
// fd593164 control worktree): 2/2 clean. So the trigger needs this diff
// present, but doesn't fire every time — consistent with tipping a MARGINAL,
// pre-existing edge in the self-compile pipeline rather than this diff being
// unconditionally wrong (this repo's own .work/research.md documents active,
// independent self-compile-build nondeterminism — §defect 2, 2026-08-20, the
// day before this tip). The fix as designed is preserved, NOT committed to
// src/compile/emit.js: full file + diff at .work-adjacent session scratchpad
// keep-emit.js / keep-emit.diff (mirrors the prior attempt's own keep-emit.js
// precedent). Next session: reproduce with JZ_SELF_COMPILE_OPT=2 (rule out
// -O3-only), then bisect self.js's 159-module graph (disable half, retry) to
// the source position feeding `null` into watr's memidx/data builder — the
// in-kernel discipline pass this shape has needed since the first attempt.
// LOCALIZED (2026-08-21, agent/typed-set-edge, worktree off ca9ca31d). Crash-rate
// reproduced first: 5/5 `npm run build` runs failed on this worktree (was 4/5),
// identical stack every time (watr/src/compile.js instr()@1127, called from the
// code/func-body section handler @851, assemble/compile @267/356, index.js's
// watrCompile(optimized) call) — confirms the defect, not a fluke of the prior
// session's count. NOT a memidx/data-segment site as first guessed — that was
// this diff's own hedge, unresolved at the time. Root-caused via a temp
// pre-watrCompile IR census (index.js, gated on JZ_DEBUG_DUMP_TREE, deleted with
// this fix): 2 real `npm run build` runs both surfaced the identical shape, a
// bare `['then', null]` (2-element array) nested under an `(if …(i32.and
// tagbits mask)(i32.eq …)(i32.const 3)… )` — PTR.TYPED=3 (layout.js) — i.e.
// `dispatchByPtrType`'s (src/ir.js) own `['then', ir]` construction with `ir`
// unresolved to `null`. One run caught 112 such nodes across many distinct
// compiler-internal functions ($closure24/25/29/121/211/929/2040/2252/2997/
// 3010/4118/4121, $__start, $m60_ast$handlerArgs, …) — self.js's own module
// graph, not this diff's emit.js/module/*.js source meaning.
// MECHANISM: `tryRuntimeStringFork`'s new `cases.push([PTR.TYPED, callMethod(t,
// typedEmitter)])` (this diff, src/compile/emit.js) embeds
// `callMethod(t, typedEmitter)`'s return value VERBATIM into `dispatchByPtrType`'s
// `then` arm — and `callMethod` → `emitMethodCallSpread`'s common path
// (src/compile/emit.js: `if (!parsed.hasSpread) return methodEmitter(objArg,
// ...parsed.normal)`) is a bare passthrough with no falsy guard. Several
// `.typed:*` emitters use `return null` as a DECLINE signal for a shape their
// fast path doesn't cover: confirmed `.typed:slice`
// (module/typedarray.js:2610, `if (r.isBigInt) return null`) and
// `.typed:filter` (module/typedarray.js:2548, `if (!r || r.isBigInt) return
// null`; broader — also declines on a wholly-unresolved element kind, `!r`);
// siblings unaudited. That convention is SOUND for every PRE-EXISTING caller —
// `tryStaticDispatch`'s direct `.${vt}:${method}` call and the top-level
// TYPED_STRATEGIES list both treat a falsy strategy return as "try the next
// strategy" — this diff's dispatchByPtrType embedding is the FIRST caller that
// splices a `.typed:${method}` result straight into IR with no such guard, so
// a decline becomes a bare `null` sitting where an instruction belongs. The
// decline convention itself predates this session (real, latent, in module/
// typedarray.js already) — this diff supplies the first caller that doesn't
// respect it, which is exactly the "pre-existing edge, newly tipped" shape the
// earlier hedge guessed at, now with a name: not self-compile-build
// nondeterminism (research.md §defect 2 is a different, wasm-hosted jz×jz
// region-allocator mechanism, ruled out — this is host-native, no region
// arena involved), but a real per-compile trigger condition (self.js contains
// several vt-unknown receivers, several of them BigInt-element or
// unresolved-element typed arrays, calling a method this diff newly routes
// through the TYPED case) that fires on MOST but not EVERY compile — plausibly
// order/inlining-sensitive in which of several equally-guilty call sites gets
// hit or optimized-away first, not yet isolated further.
// JZ_SELF_COMPILE_OPT=2 (O2) discrimination: not yet run separately — every
// localization run above used `npm run build`'s O3 default.
// DIRECTION (a) TRIED PRIOR SESSION AND REVERTED — UNSAFE, do not repeat as-is.
// Guarded `tryRuntimeStringFork`: a nullish `callMethod(t, typedEmitter)` (or
// `strEmitter`) is omitted from `cases`, not pushed — falls through to the next
// case or to `generic` instead of embedding `null`. Build-crash gate PASSED
// clean: `npm run build` × 5/5 (was 5/5 FAIL without the guard). But
// kernel-oracle/kernel-parity, run immediately after per this repo's own gate
// order, FAILED near-totally on the resulting dist/jz.wasm — kernel-oracle 1/13
// pass (was 13/13 clean at ca9ca31d), kernel-parity 0/3 — every single kernel
// invocation, including the trivial byte-identical-WAT-at-O0 probe (no typed
// arrays involved at all), threw an empty-message `SyntaxError` from the
// KERNEL'S OWN compiled parser (confirmed directly: `self.exports.default(...)`
// on a plain `sum` source throws `SyntaxError("")`, not a WASM trap). This
// disproved the working assumption behind (a) — that a declined TYPED case is
// effectively dead code at runtime, so falling through to `generic` is
// consequence-free. It is NOT dead code: watr's assembler rejects malformed IR
// at BUILD time regardless of reachability (explaining the clean 5/5 build),
// but at least one of the ~112 census-found sites sits on the kernel's live
// tokenizer/parser hot path and IS reached with real data — `generic`'s
// wrong-layout read there corrupts the compiled parser itself.
//
// FIXED (agent/typed-decline-b, direction (b) — audit + close every reachable
// decline, rather than guard-and-omit it). Audited all ~29 `.typed:*` emitters
// (grep `'.typed:` module/typedarray.js): `.typed:fill`/`.reverse`/`.copyWithin`/
// `.sort`/`.set`/`.at`/`.subarray`/`.toBase64`/`.toHex`/`.setFrom*` never decline
// (unconditional runtime aux-byte dispatch); `.typed:forEach`/`.reduce`/
// `.indexOf`/`.lastIndexOf`/`.includes`/`.find`/`.findIndex`/`.findLast`/
// `.findLastIndex`/`.some`/`.every` share one dynamic-branch helper (`typedLoop`)
// that itself never returns falsy, so their own `if (!loop) return null` guards
// are dead; `.typed:toReversed`/`.toSorted`/`.with` only propagate `.typed:slice`'s
// decline. Two had a REAL reachable decline once the TYPED case below embeds a
// typed emitter's raw return into `dispatchByPtrType` unguarded: `.typed:slice`'s
// `r.isBigInt` case now routes into the SAME `!r` → `__typed_slice_rt` runtime
// fallback direction (a) sketched (slice is a raw byte copy — BigInt needs no
// separate static path); `.typed:filter`'s `!r || r.isBigInt` case gets a new
// runtime aux-dispatch loop (module/typedarray.js) — `__typed_get_idx`/
// `__typed_set_idx` per element (the same helpers `typedLoop`'s own dynamic
// branch already leans on unconditionally), `__ptr_aux`/`__typed_shift`/
// `__alloc_hdr_n`/`__mkptr` for a correctly-strided, correctly-tagged output
// allocated worst-case and patched to the true passed count — mirrors
// `__typed_slice_rt`'s own runtime-aux-dispatch allocation shape, extended with
// filter's per-element callback. `tryRuntimeStringFork` renamed `tryRuntimePtrTypeFork`
// (src/compile/emit.js) — it dispatches STRING vs TYPED vs generic now, not just
// string vs generic. `set: ['core','typedarray','collection']` landed in
// src/autoload.js PROP_MODULES, generalized to every OTHER `.typed:*` name that
// shares a generic `.${method}` emitter (fill/map/filter/reduce/forEach/find*/
// every/some/copyWithin/at/toSorted/toReversed/with/sort/reverse/slice/indexOf/
// lastIndexOf/includes) — audit found ALL of them missing `typedarray`, not just
// `set`; differentially confirmed load-bearing (a host-provided typed-array
// PARAMETER — source names no typed ctor anywhere, so `includeForRuntimeCtor`
// never fires — silently misdispatched `.fill()` without this row: 1003 instead
// of 9009, reading a real Float64Array as a guessed plain array). `.typed:[]`/
// `.typed:[]=` (index ops, not method calls) stay out of scope: a different,
// pre-existing, already-guarded compile-time-only call path (module/array.js /
// src/compile/emit-assign.js) never reached through this fork.
//
// CLOSED IN A FOLLOW-UP SESSION (agent/typed-map-width): `.typed:map`'s own
// `!r` (fully-unresolved, non-BigInt) case used to fall back to generic
// `.map` — sound for BigInt (bit-identical 8-byte load, the same reasoning as
// its own accepted BigInt fallback a few lines above it) but a real
// width-correctness gap for a genuinely narrow unresolved receiver: not just
// "double-width" but a raw header/stride misread (array.js's generic `.map`
// reads the header via a direct, non-polymorphic `arrayLenFromPtr`/8-byte-
// stride `arrayLoop`, not the aux-aware `__len`/per-width `elemLoadIR`),
// confirmed to read outright garbage (denormal `2.5e-316`-class values, raw
// adjacent heap bytes) for an Int8Array through the opaque-polymorphic/
// dyn-field/host-receiver fork shapes below — not a plausible wrong number.
// Fixed the same way `.typed:filter`'s `!r` branch above was: a runtime
// aux-dispatch loop (module/typedarray.js) — `__typed_get_idx`/
// `__typed_set_idx` per element (the SAME helpers `typedLoop`'s own dynamic
// branch and `.typed:set`'s `!r` branch already lean on unconditionally),
// `__ptr_aux`/`__typed_shift`/`__alloc_hdr_n`/`__mkptr` for a correctly-
// strided, correctly-tagged output — simpler than filter's shape since map's
// output length is always EXACTLY the input length (one-shot alloc, no
// worst-case-then-patch-the-count dance; mirrors `__typed_slice_rt`'s own
// shape instead). Differentially verified against real Node/V8 typed arrays
// (not hand-picked literals) for Int8Array wrap (ECMA-262 ToInt8, 7.1.11),
// Uint8Array wrap-not-clamp (ToUint8, 7.1.10 — contrast with
// Uint8ClampedArray's ToUint8Clamp, 7.1.12, which only its element WRITES
// use), and Float32Array f32 store-rounding (distinct from f64 arithmetic),
// at optimize 0/2/3.
//
// A SEPARATE, narrower, pre-existing gap surfaced while probing the
// host-receiver shape with `Uint8ClampedArray` specifically (not one of this
// fix's required pins — left unfixed, noted here so it isn't lost): a program
// whose source names NO `Uint8ClampedArray`/`Float16Array` ctor anywhere (the
// host-receiver shape's whole premise) never calls `setLinkDemand('clamped'/
// 'f16')` — that only fires from inside a resolved `resolveElem` or a literal
// `new Uint8ClampedArray(...)`/`new Float16Array(...)` node — so
// `__typed_set_idx`'s clamped/f16 branches (module/typedarray.js, gated
// behind `ctx.linkDemand.clamped`/`.f16` template conditionals) compile OUT
// entirely; a REAL clamped/f16 value flowing in from the host at runtime then
// falls through to the plain-integer wrap path instead of clamping/f16-
// converting. Reproduces with `.filter`'s existing `!r` branch too (shared
// stdlib fns) given an out-of-range value — `.filter` just never surfaced it
// (it only ever stores back an already-in-range LOADED value, no arithmetic).
// Infra-level (`setLinkDemand`/autoload conservativeness for the
// zero-ctor-syntax host-receiver shape), not `.typed:map`-specific; out of
// this fix's scope.
//
// A SECOND separate, pre-existing gap surfaced the same way, fully
// independent of `.map()`: bracket-index reads (`dst[i]`) on an erased-vt
// HOST-PROVIDED receiver read garbage for any element width narrower than
// 8 bytes — reproduces on a bare `let m = dst; return m[0]` with zero method
// calls involved. `.set`'s own host-receiver pin above only ever exercises
// Float64Array (8-byte stride), which happens to read correctly BY
// COINCIDENCE (same class this file's `.at` fix note already documents for a
// different site: "Float64Array/BigInt64Array/BigUint64Array (also 8-byte)
// happened to read the right bytes by coincidence of matching stride, not by
// correctness"). Matches this file's own prior note two paragraphs up:
// "`.typed:[]`/`.typed:[]=` (index ops, not method calls) stay out of scope:
// a different, pre-existing, already-guarded compile-time-only call path
// (module/array.js / src/compile/emit-assign.js) never reached through this
// fork" — confirmed here to be live, not hypothetical. The host-receiver pin
// below reads back via `.forEach` (a proven-correct dispatch) specifically to
// route around this independent gap rather than accidentally re-test it.
// Flip `test.todo` → `test` once a build run holds clean across a real repeat
// count (10+) AND kernel-oracle/kernel-parity both hold at 13/13 and 33/33 —
// not just the build exit code. (Both held clean on this branch — see its
// commits for the exact tallies.)
test('set: into typed-array field added dynamically to an empty object', () => {
  const { f } = runHost(`export let f = () => {
    const s = {}
    s.a = new Float64Array(4)
    const b = new Float64Array([1, 2, 3, 4])
    s.a.set(b)
    return s.a[0] * 1000 + s.a[3]
  }`)
  is(f(), 1004)
})

// The registration-totality case: `dst`/`src` are opaque exported-function
// params — this source names NO typed ctor anywhere, so `typedarray` can ONLY
// autoload via src/autoload.js PROP_MODULES' `set` row (includeForRuntimeCtor
// never fires — there is no `new XArray(...)` literal for it to see). Uses
// `r.memory.Float64Array(...)` (test/buffer.js's own host-marshaling idiom) to
// pass real host typed arrays into params the compiler never pins a vt for.
// Differentially confirmed load-bearing pre-fix (agent/typed-decline-b): 1003
// (misdispatched to a guessed-array read of dst's raw bytes), not 1004.
test('set: host-provided typed receiver (source names no typed ctor at all)', () => {
  const r = jz(`export function setIt(dst, src) { dst.set(src); return dst[0] * 1000 + dst[3] }`)
  is(Number(r.exports.setIt(r.memory.Float64Array([0, 0, 0, 0]), r.memory.Float64Array([1, 2, 3, 4]))), 1004)
})

// .fill sibling probe — same dyn-field shape as the .set pin above, the other
// method the original defect report named as misfiring via the generic
// fallback (a typed array's BYTE-length header misread as a raw element count).
test('fill: into typed-array field added dynamically to an empty object', () => {
  const { f } = runHost(`export let f = () => {
    const s = {}
    s.a = new Float64Array(4)
    s.a.fill(7)
    return s.a[0] * 1000 + s.a[3]
  }`)
  is(f(), 7007)
})

// .forEach sibling probe — same shape; asserts both correct call COUNT (the
// original defect fired 24 times for a 3-element array, 8× its true length)
// and correct per-call VALUES (sum, not just count).
test('forEach: into typed-array field added dynamically to an empty object', () => {
  const { f } = runHost(`export let f = () => {
    const s = {}
    s.a = new Float64Array([1, 2, 3])
    let calls = 0, sum = 0
    s.a.forEach((v) => { calls++; sum += v })
    return calls * 1000 + sum
  }`)
  is(f(), 3006)
})

// .filter sibling probe on a NARROW (1-byte) element width — the actual shape
// `.typed:filter`'s new runtime aux-dispatch branch (module/typedarray.js) has
// to get right: a wrong-stride generic fallback would misread this immediately
// (8-byte f64 slots over 1-byte elements), unlike Float64Array above where a
// stride mismatch happens to be bit-invisible.
test('filter: into typed-array field added dynamically to an empty object (narrow element width)', () => {
  const { f } = runHost(`export let f = () => {
    const s = {}
    s.a = new Int8Array([1, -2, 3, -4, 5])
    const t = s.a.filter(x => x > 0)
    return t.length * 1000 + t[0] * 10 + t[2]
  }`)
  is(f(), 3015)
})

// .typed:slice / .typed:filter BigInt pins — the OTHER decline condition this
// branch closed (`r.isBigInt`, alongside `!r` above). Both now route through a
// runtime aux-byte dispatch instead of a bare `return null`; asserted via
// `.length` (the runtime structure `__typed_slice_rt`/the new filter loop
// produce is correct) rather than further element indexing — re-indexing a
// BigInt slice/filter RESULT held in a variable hits a separate, pre-existing
// analyze.js gap (BigInt element-kind isn't propagated through a `.slice()`/
// `.map()` assignment's static type tracking, same as this file's existing
// accepted `.typed:map` BigInt-fallback rows already exhibit) — out of the
// `.typed:*` emitter-decline scope this branch audits.
test('slice: BigInt64Array (isBigInt no longer bails to a bare decline)', () => {
  const { f } = runHost(`export let f = () => {
    let b = new BigInt64Array(4)
    b[0] = 5n; b[1] = 6n; b[2] = 7n
    return b.slice(0, 2).length
  }`)
  is(f(), 2)
})

test('filter: BigInt64Array (isBigInt no longer bails to a bare decline)', () => {
  const { f } = runHost(`export let f = () => {
    let b = new BigInt64Array(4)
    b[0] = 5n; b[1] = 0n; b[2] = 7n; b[3] = 0n
    return b.filter(x => x !== 0n).length
  }`)
  is(f(), 2)
})

// === .typed:map `!r` decline — species/width fix (agent/typed-map-width) ===
// See the long comment above the BigInt pins for the full mechanism. Four
// pins: the opaque-polymorphic idiom this file already uses for `.at`'s own
// dynamic-dispatch test, the dyn-field shape (narrow width, matching
// `.filter`'s sibling probe just above), the host-receiver shape (zero
// typed-ctor syntax anywhere in source), and the Uint8Array wrap-vs-clamp
// truth. Each differential against a real engine value, not a hand-picked one.

test('.map: opaque/polymorphic receiver preserves species + width (was reading garbage via the generic-array decline)', () => {
  // `which` makes the element kind unprovable at compile time (resolveElem's
  // `!r` case) — the same idiom '.at: opaque/polymorphic receiver' above uses.
  // ECMA-262 ToInt8 (7.1.11): 100*2=200 wraps to 200-256=-56, two's-complement.
  const f = runHost(`export let f = (which) => {
    let t = which ? new Int8Array([100, 100]) : new Float32Array([100, 100])
    let m = t.map(x => x * 2)
    return m[0] * 1000 + m[1]
  }`).f
  is(f(1), -56 * 1000 + -56, 'Int8Array branch: wraps like JS, not [200,200]')
  is(f(0), 200 * 1000 + 200, 'Float32Array branch: exact (200 is f32-representable)')
})

test('.map: into typed-array field added dynamically to an empty object (narrow element width)', () => {
  const { f } = runHost(`export let f = () => {
    const s = {}
    s.a = new Int8Array([100, 100])
    const m = s.a.map(x => x * 2)
    return m[0] * 1000 + m[1]
  }`)
  is(f(), -56 * 1000 + -56)
})

test('.map: host-provided typed receiver (source names no typed ctor at all) preserves species + width', () => {
  // dst carries no typed-ctor syntax anywhere in source, so resolveElem(dst) can
  // never trace a binding — the `!r` decline this fix closes. Reads back via
  // .forEach (proven-correct dispatch) rather than dst[i]/m[i] bracket
  // indexing — seeing the SEPARATE bracket-index-on-erased-vt-host-receiver
  // gap noted in the long comment above, not re-testing it here.
  const r = jz(`export function f(dst) {
    let m = dst.map(x => x * 2)
    let out = 0
    m.forEach(x => { out = out * 1000 + x })
    return out
  }`)
  is(Number(r.exports.f(r.memory.Int8Array([100, 100]))), -56 * 1000 + -56)
})

test('.map: Uint8Array wraps (ToUint8) not clamps, through the runtime decline path', () => {
  // Unlike Uint8ClampedArray (whose element WRITES saturate via ToUint8Clamp,
  // ECMA-262 7.1.12), plain Uint8Array wraps modulo 256 like every other
  // integer kind (ToUint8, 7.1.10) — the same modular law as Int8Array's
  // ToInt8 (7.1.11) above, just unsigned: 200*2=400, 400 mod 256 = 144 (NOT
  // 255, which is what a clamp would give).
  const f = runHost(`export let f = (which) => {
    let t = which ? new Uint8Array([200, 200]) : new Float64Array([200, 200])
    let m = t.map(x => x * 2)
    return m[0] * 1000 + m[1]
  }`).f
  is(f(1), 144 * 1000 + 144)
})

test('.map: Float32Array keeps f32 store-rounding through the runtime decline path (distinct from f64)', () => {
  // TypedArray element WRITES coerce via the store width (f32.demote_f64 for
  // Float32Array), so the result differs from plain f64 arithmetic — computed
  // in FULL f64 precision inside the callback, then rounded once on store.
  // Differential against the real engine, not a hand-derived Math.fround chain.
  const f = runHost(`export let f = (which) => {
    let t = which ? new Float32Array([0.1, 0.2]) : new Int8Array([0, 0])
    let m = t.map(x => x + 0.2)
    return m[0]
  }`).f
  is(f(1), new Float32Array([0.1]).map(x => x + 0.2)[0])
  ok(f(1) !== 0.1 + 0.2, 'must NOT equal plain f64 arithmetic')
})

// === .typed:map callback index + BigInt species (agent/typed-map-index,
// external audit follow-up to agent/typed-map-width above) ===
//
// Two remaining defects the width fix didn't touch:
//
// (A) CALLBACK INDEX — both the static scalar path (module/typedarray.js,
// the `elemType != null && !r.isBigInt` branch) and the runtime aux-dispatch
// loop just above (the `!r` / BigInt fallback) invoked the callback with only
// the element, dropping the index JS always passes as the 2nd arg. Every
// OTHER typed-array iteration method in this file (forEach/find/findIndex/
// findLast/findLastIndex/some/every — see the `ctx.closure.floor = 2`
// comment near this file's top) already passes (item, idx); `.map` was the
// one holdout. Fixed by adding a `f64.convert_i32_s` of the loop-counter
// local as a 2nd closure-call arg on both paths — the SAME idiom the other
// methods already use, needing no width bump (floor was already 2). The `arr`
// 3rd arg real JS callbacks also receive stays a recorded gap: jz's callback
// machinery never passes it to ANY iteration method anywhere in the compiler
// (array.js's own `.map`/`.filter`/`.forEach` don't either — grep
// `cb.call([item, idxArg` in module/array.js — only `.reduce`'s (acc, item,
// idx) needs a 3-wide floor); adding a receiver-array arg just for typed
// `.map` would be new, inconsistent surface, not a mirror of anything.
//
// (B) BIGINT SPECIES — a statically-known BigInt64Array/BigUint64Array
// receiver used to short-circuit `.typed:map` straight to generic
// `Array.prototype.map` (module/typedarray.js, the `if (r?.isBigInt)` branch
// that used to sit right after `resolveElem`). The 8-byte payload survived
// (bit-identical width), but the SPECIES didn't: the result was a plain
// PTR.ARRAY, not a typed array — `ArrayBuffer.isView()` on it reports false,
// and it carries none of a typed array's other behavior. Fixed by excluding
// `r.isBigInt` from the SIMD and scalar branches instead, letting it fall
// through to the SAME runtime aux-dispatch loop the `!r` (unresolved) case
// already used — which was already proven BigInt-sound (its aux mask already
// preserved TYPED_ELEM_BIGINT_FLAG; `__typed_get_idx`/`__typed_set_idx`
// already roundtrip BigInt elements bit-exact via f64.reinterpret_i64) since
// dynamically-unresolved-but-actually-BigInt receivers always reached it —
// only the STATICALLY-known case was diverted away from it.

test('.map: callback receives (item, idx) — static scalar path (Uint8Array)', () => {
  // ECMA-262 23.2.3.20 ToIntegerOrInfinity / ToUint8 (7.1.10): element writes
  // wrap mod 256. Differential against the real engine (not a hand-picked
  // literal): [1,1].map((x,i)=>x+i) → [1,2] in real V8/Node.
  const f = runHost(`export let f = () => {
    let a = new Uint8Array([1, 1])
    let m = a.map((x, i) => x + i)
    return m[0] * 1000 + m[1]
  }`).f
  const expected = new Uint8Array([1, 1]).map((x, i) => x + i)
  is(f(), expected[0] * 1000 + expected[1], 'JS: [1,1] → [1,2]')
})

test('.map: callback receives (item, idx) — runtime aux-dispatch path (opaque/polymorphic receiver)', () => {
  // Same opaque-receiver idiom as the species/width pin above (`which` makes
  // the element kind unprovable at compile time — resolveElem's `!r` case),
  // now with an index-using callback to exercise the SECOND fixed call site.
  const f = runHost(`export let f = (which) => {
    let t = which ? new Uint8Array([1, 1]) : new Float32Array([1, 1])
    let m = t.map((x, i) => x + i)
    return m[0] * 1000 + m[1]
  }`).f
  const expected = new Uint8Array([1, 1]).map((x, i) => x + i)
  is(f(1), expected[0] * 1000 + expected[1])
})

test('.map: BigInt64Array/BigUint64Array preserve species (was: silently rerouted to generic Array.prototype.map — PTR.ARRAY, wrong species)', () => {
  const isView1 = runHost(`export let f = () => ArrayBuffer.isView(new BigInt64Array([1n]).map(x => x)) ? 1 : 0`).f
  is(isView1(), 1, 'BigInt64Array: result is still a typed array, not a plain Array')

  const isView2 = runHost(`export let f = () => ArrayBuffer.isView(new BigUint64Array([1n]).map(x => x)) ? 1 : 0`).f
  is(isView2(), 1, 'BigUint64Array: same')

  // Value pin: x => x + 1n over [1n] → [2n]. Reads the element straight off
  // the map-call chain (not through an intermediate `let`) — resolveElem's
  // TYPED_CHAIN_METHODS walk resolves `new BigInt64Array(…).map(…)[0]`
  // statically; a `let m = …; m[0]` indirection would instead hit a SEPARATE,
  // pre-existing, already-documented analyze.js gap (BigInt element-kind
  // isn't propagated through a `.map()`/`.slice()` ASSIGNMENT's static type
  // tracking — see the BigInt slice/filter pins' comment above), which this
  // fix does not touch and is out of scope here.
  //
  // Block-body callback (`x => { return x + 1n }`), NOT the terser
  // expression-body `x => x + 1n` — see the `test.todo` immediately below for
  // why: an expression-bodied arrow's IMPLICIT return of `param + BigIntLiteral`
  // hits a separate, pre-existing, general miscompile (confirmed with zero
  // typed-array/map involvement — a captured-variable closure `() => x + 1n`
  // alone reproduces it); the explicit block-bodied `return` of the identical
  // expression is unaffected. This species/value pin only needs to prove
  // THIS fix's routing is correct, so it sidesteps that separate bug rather
  // than being blocked by it.
  const val = runHost(`export let f = () => new BigInt64Array([1n]).map(x => { return x + 1n })[0] === 2n ? 1 : 0`).f
  is(val(), 1, '1n + 1n = 2n, correct species and bit-exact roundtrip')

  const uval = runHost(`export let f = () => new BigUint64Array([1n]).map(x => { return x + 1n })[0] === 2n ? 1 : 0`).f
  is(uval(), 1, 'BigUint64Array: same')
})

// NOT a defect of this fix (agent/typed-map-index) — recorded here because
// the external audit's Part B pin was phrased with an expression-bodied
// callback exactly like this. Root cause fully isolated, with zero
// typed-array/array-method involvement at all:
//   export function f(x) { let g = () => x + 1n; return g() }   // f(5n) → garbage
//   export function f(x) { let g = () => { return x + 1n }; return g() }  // f(5n) → 6n, correct
// An expression-bodied (implicit-return) arrow whose value is `ident + BigIntLiteral`
// loses the BigInt census; the identical computation under an explicit block
// `return` is fine. Reproduces identically on unmodified 6fa3fd7e (pre-dates
// this branch). Flip to `test` once that separate miscompile is fixed.
test.todo('.map: BigInt64Array — exact expression-bodied form from the audit pin (x => x + 1n)', () => {
  const val = runHost(`export let f = () => new BigInt64Array([1n]).map(x => x + 1n)[0] === 2n ? 1 : 0`).f
  is(val(), 1)
})

test('.map: BigInt64Array callback also receives the correct index (both fixes compose)', () => {
  // Side-channel index capture (plain NUMBER arithmetic on `i`, callback
  // returns `x` UNCHANGED) — deliberately avoids BigInt arithmetic inside the
  // callback body so this test exercises ONLY index plumbing (this fix's
  // scope), not the separate expression-body arithmetic gap documented above.
  const f = runHost(`export let f = () => {
    let seen = 0
    new BigInt64Array([10n, 20n, 30n]).map((x, i) => { seen = seen * 10 + i; return x })
    return seen
  }`).f
  is(f(), 12, 'indices 0,1,2 seen in order')
})

test('map: named constructor-fn callback reboxes (ptrKind through the inline wrapper)', () => {
  // `.map(s => mk(s))` with mk a NAMED fn returning an object: mk compiles with a
  // narrowed raw-pointer return; the callback inliner's block wrapper must carry the
  // ptrKind metadata or asF64 numeric-converts the raw offset — map returned
  // [1104,1128] instead of objects (digital-filter core/matched-z.js).
  const r = jz(`function mk(s) { return { v: s } }
export function f(arr) { return arr.map(s => mk(s)) }
export function g() { let a = [10, 20]; return a.map(s => mk(s)) }`)
  is(r.memory.read(r.exports.g()), [{ v: 10 }, { v: 20 }], 'local source')
  is(r.memory.read(r.exports.f(r.memory.Array([10, 20]))), [{ v: 10 }, { v: 20 }], 'host-marshaled source')
})

// Array.isArray answers from the STATIC kind when known — a rep-narrowed array
// (raw base local, e.g. a slice() result) is not a NaN-box, so the runtime tag
// test alone reads a plain number and says false. O2+ promotion-DERIVED arrays
// remain a recorded gap (.work/todo.md, extension-surface archive) — pinned at O0 here.
test('Array.isArray: statically-known arrays (slice/rest results)', () => {
  const o = { optimize: false }
  is(jz(`export let f = () => { let a = [1, 2]; let s = a.slice(0); return Array.isArray(s) ? 1 : 0 }`, o).exports.f(), 1)
  is(jz(`export let f = () => { const [...x] = [1]; return Array.isArray(x) ? 1 : 0 }`, o).exports.f(), 1)
  // side effects of the argument are preserved when the answer is static
  is(jz(`export let f = () => { let n = 0; let mk = () => { n = n + 1; return [1] }; let r = Array.isArray(mk()) ? 1 : 0; return n * 10 + r }`, o).exports.f(), 11)
  // non-arrays still answer false at every level
  is(jz(`export let f = () => Array.isArray(42) ? 1 : 0`).exports.f(), 0)
})

// `.valueOf()` on an unresolved-static-type receiver (a heterogeneous array's
// element, or a plain parameter with no call-site type proof) must return the
// receiver UNCHANGED (Object.prototype.valueOf, ES2024 20.1.3.7 — Array/plain
// Object inherit it verbatim). Root cause (kernel-parity self-compile printer
// collapse, watr's print.js `node[i]?.valueOf?.() ?? node[i]` then
// `Array.isArray(sub)`): jz's unresolved-type `.valueOf()` dispatch
// (emit.js tryRuntimePtrTypeFork's generic fallback arm) reads ONE shared,
// flat-keyed `ctx.core.emit['.valueOf']` slot — module/string.js registers
// the correct identity passthrough there, but module/date.js used to
// OVERWRITE that SAME flat key with its own Date.prototype.valueOf
// (`emitDateGetTime`: `f64.load` at the receiver's own base address) whenever
// both modules were linked into the same compile (which autoload does
// unconditionally for any unresolved `.valueOf()` call site, independent of
// whether the program ever mentions Date). For an array, offset 0 IS
// element 0, so `arr.valueOf()` silently returned `arr[0]` instead of `arr`.
// Not a self-compile-only bug — reproduces with plain native compile(), zero
// Date usage anywhere in this source.
test('valueOf on unresolved-type receiver returns identity, not element 0 (date.js flat-key regression)', () => {
  // Array element read through a computed index — the exact shape self-
  // compile's WAT printer uses (node[i]?.valueOf?.() ?? node[i]).
  is(jz(`export let f = () => {
    let node = ['func', ['export', 'x'], ['param', 'n']]
    let n = 0
    for (let i = 1; i < node.length; i++) {
      let raw = node[i].valueOf()
      if (Array.isArray(raw)) n = n + 1
    }
    return n
  }`).exports.f(), 2, 'both nested-array elements must still be seen as arrays after .valueOf()')
  // Plain function parameter — no call-site type proof, the other common
  // unresolved-receiver shape (needs closure infra live to reach the sidecar
  // probe strategy; an unrelated closure elsewhere in the program supplies it,
  // matching a real multi-function program rather than this one-liner).
  is(jz(`let use = (fn) => fn(1)
export let f = (x) => { let v = x.valueOf(); return Array.isArray(v) ? 1 : 0 }
export let g = () => use(n => n + 1)`).exports.f(3), 0, 'a plain number parameter is unaffected (sanity)')
  const r = jz(`let use = (fn) => fn(1)
export let f = (x) => { let v = x.valueOf(); return typeof v }
export let g = () => use(n => n + 1)`)
  is(r.memory.read(r.exports.f(r.memory.Array([1, 2]))), 'object', 'an array parameter\'s .valueOf() must read back as object, not number')
  // Date.prototype.valueOf itself must be unaffected by removing the flat
  // override — a PROVEN Date receiver dispatches through the type-qualified
  // `.date:valueOf` key (tryStaticDispatch), never the flat one.
  is(jz(`export let f = () => { let d = new Date(12345); return d.valueOf() }`).exports.f(), 12345)
})

// ES2023 change-by-copy Array methods (2026-07-11, Ring 2) — port of the
// TypedArray versions to plain arrays. toSorted/toReversed/with return a NEW
// array (receiver untouched); copyWithin mutates in place and returns the
// receiver. Default sort is lexicographic-string (NOT typed's numeric default).
// runHost (marshaling exports) decodes string returns; run (adaptI64) does not.
test('Array change-by-copy: toSorted / toReversed', () => {
  is(runHost(`export let f = () => [10,9,100].toSorted().join(",")`).f(), '10,100,9')   // lexicographic default
  is(runHost(`export let f = () => [3,1,2].toSorted((a,b)=>a-b).join(",")`).f(), '1,2,3')
  is(runHost(`export let f = () => { let a=[3,1,2]; a.toSorted(); return a.join(",") }`).f(), '3,1,2')  // receiver intact
  is(runHost(`export let f = () => [1,2,3].toReversed().join(",")`).f(), '3,2,1')
  is(runHost(`export let f = () => { let a=[1,2,3]; let b=a.toReversed(); return a[0]*100+b[0] }`).f(), 103)
  is(runHost(`export let f = () => ["a","b","c"].toReversed().join("")`).f(), 'cba')  // string elements
})
test('Array .with(index, value)', () => {
  is(runHost(`export let f = () => [1,2,3].with(1,9).join(",")`).f(), '1,9,3')
  is(runHost(`export let f = () => [1,2,3].with(-1,9).join(",")`).f(), '1,2,9')          // negative from end
  is(runHost(`export let f = () => { let a=[1,2,3]; a.with(0,9); return a[0] }`).f(), 1)  // receiver intact
  is(runHost(`export let f = () => ["a","b","c"].with(1,"X").join("")`).f(), 'aXc')       // string element boxed correctly
  throws(() => runHost(`export let f = () => [1,2,3].with(5,9)`).f(), /./)                // RangeError (out of range)
  throws(() => runHost(`export let f = () => [1,2,3].with(-4,9)`).f(), /./)               // out of range from end
})
test('Array .copyWithin', () => {
  is(runHost(`export let f = () => [1,2,3,4,5].copyWithin(0,3).join(",")`).f(), '4,5,3,4,5')
  is(runHost(`export let f = () => [1,2,3,4,5].copyWithin(0,-2).join(",")`).f(), '4,5,3,4,5')  // negative start
  is(runHost(`export let f = () => [1,2,3,4,5].copyWithin(1,3,4).join(",")`).f(), '1,4,3,4,5')  // bounded end
  is(runHost(`export let f = () => { let a=[1,2,3,4]; return a.copyWithin(0,2)===a ? 1 : 0 }`).f(), 1)  // returns receiver
})
test('Array.of', () => {
  is(runHost(`export let f = () => Array.of(1,2,3).join(",")`).f(), '1,2,3')
  is(runHost(`export let f = () => Array.of(7).length`).f(), 1)      // NOT Array(7)'s length-7 hole array
  is(runHost(`export let f = () => Array.of().length`).f(), 0)
  is(runHost(`export let f = () => { let xs=[1,2]; return Array.of(...xs,3).join(",") }`).f(), '1,2,3')  // spread
})
