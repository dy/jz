// Array methods: map, filter, reduce, forEach, find, indexOf, includes, slice
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onWasi, onKernel, adaptI64 } from './_matrix.js'

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
// source (a fn param, the compiler's own `[...key]`). This also closed the json self-host
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
  if (onKernel()) return  // kernel: host {modules} import resolution doesn't reach the single-source self-host
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
// The emit-side fix for this shape (see the todo-batch session) miscompiles the
// SELF-HOST kernel (tokenizer loses `let` — bisected to that emit.js hunk alone;
// preserved in the session scratchpad as keep-emit.js). Needs the in-kernel
// discipline pass before re-landing. Flip `test.todo` → `test` when fixed.
test.todo('set: into typed-array field added dynamically to an empty object', () => {
  const { f } = runHost(`export let f = () => {
    const s = {}
    s.a = new Float64Array(4)
    const b = new Float64Array([1, 2, 3, 4])
    s.a.set(b)
    return s.a[0] * 1000 + s.a[3]
  }`)
  is(f(), 1004)
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
