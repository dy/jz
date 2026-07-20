// Destructuring, optional chaining, typeof
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
function run(code, opts) {
  return jz(code, opts).exports
}

// ============================================
// Array destructuring
// ============================================

test('destruct: let [a, b] = arr', () => {
  const { f } = run(`export let f = () => {
    let arr = [10, 20, 30]
    let [a, b, c] = arr
    return a + b + c
  }`)
  is(f(), 60)
})

test('destruct: from pointer array', () => {
  const { f } = run(`export let f = () => {
    let pair = [7, 11]
    let [a, b] = pair
    return a * 10 + b
  }`)
  is(f(), 81)  // 7*10 + 11
})

test('destruct: partial array', () => {
  const { f } = run(`export let f = () => {
    let a = [100, 200, 300]
    let [x, y] = a
    return x + y
  }`)
  is(f(), 300)  // only first two elements
})

test('destruct: sparse first element stays nullish', () => {
  const { f } = run(`export let f = () => {
    let [x, y] = [, 7]
    return (x == null) + y
  }`)
  is(f(), 8)
})

test('destruct: inline arrow param nested array pattern', () => {
  const { f } = run(`
    let inspect = ([kind, fields, subkind, supertypes, rec], ctx) =>
      (kind === 'func') + (fields[0].length === 0) + (fields[1].length === 0) + (ctx === 7)
    export let f = () => inspect(['func', [[], []]], 7)
  `)
  is(f(), 4)
})

test('destruct: inline arrow param nested rest pattern', () => {
  const { f } = run(`
    let inspect = ([mod, field, [kind, ...dfn]], ctx) =>
      (mod === 'm') + (field === 'f') + (kind === 'func') + (dfn[0][0] === 'type') + (ctx === 7)
    export let f = () => inspect(['m', 'f', ['func', ['type', 0]]], 7)
  `)
  is(f(), 5)
})

test('destruct: module-scope for-of binding pattern declares generated temps', () => {
  const { f } = jz(`
    const groups = { a: ["A"], b: ["B", "C"] }
    let total = 0
    let last = ""
    for (const [key, names] of Object.entries(groups)) {
      total += key.length + names.length
      for (const name of names) last = name
    }
    export let f = () => total + last.length
  `, { jzify: true }).exports
  is(f(), 6)
})

// ============================================
// Object destructuring
// ============================================

test('destruct: let {x, y} = obj', () => {
  const { f } = run(`export let f = () => {
    let o = {x: 3, y: 4}
    let {x, y} = o
    return x * x + y * y
  }`)
  is(f(), 25)
})

test('destruct: object in function', () => {
  const { f } = run(`
    let mag2 = (v) => {
      let {x, y} = v
      return x * x + y * y
    }
    export let f = () => mag2({x: 5, y: 12})
  `)
  is(f(), 169)
})

test('destruct: computed object key', () => {
  const { f } = run(`export let f = () => {
    let k = "a"
    let {[k]: x} = {a: 7}
    return x
  }`)
  is(f(), 7)
})

test('destruct assign: [...rest] = arr', () => {
  const { f } = run(`export let f = () => {
    let rest
    ;[...rest] = [3, 4, 5]
    return rest.length * 10 + rest[2]
  }`)
  is(f(), 35)
})

test('destruct assign: [a = v] default', () => {
  const { f } = run(`export let f = () => {
    let a
    ;[a = 9] = []
    return a
  }`)
  is(f(), 9)
})

test('destruct assign: ({x: a} = obj)', () => {
  const { f } = run(`export let f = () => {
    let a;
    ({x: a} = {x: 7})
    return a
  }`)
  is(f(), 7)
})

test('destruct assign: newline after declaration keeps assignment statement', () => {
  const { f } = run(`export let f = () => {
    let a
    ({x: a} = {x: 8})
    return a
  }`)
  is(f(), 8)
})

test('destruct assign: ({x = v} = obj) default', () => {
  const { f } = run(`export let f = () => {
    let x;
    ({x = 5} = {})
    return x
  }`)
  is(f(), 5)
})

test('destruct assign: ({x: a = v} = obj) alias default', () => {
  const { f } = run(`export let f = () => {
    let a;
    ({x: a = 6} = {})
    return a
  }`)
  is(f(), 6)
})

test('destruct: jzify preserves object default pattern before spread use', () => {
  const { f } = jz(`export let f = () => {
    const source = { items: [3, 1, 2] }
    const { items = [] } = source
    const sorted = [...items].sort((a, b) => a - b)
    return sorted.length * 10 + sorted[0]
  }`, { jzify: true }).exports
  is(f(), 31)
})

test('destruct assign: scalar array literal swap does not allocate array', () => {
  const wat = compile(`export let f = () => {
    let a = 1, b = 2
    ;[a, b] = [b, a]
    return a * 10 + b
  }`, { wat: true })
  ok(!/__arr|__mkptr|__alloc/.test(wat), 'array-literal destruct swap should lower to locals only')
  is(run(`export let f = () => {
    let a = 1, b = 2
    ;[a, b] = [b, a]
    return a * 10 + b
  }`).f(), 21)
})

// ============================================
// Optional chaining
// ============================================

test('optional: ?.prop on valid object', () => {
  const { f } = run(`export let f = () => {
    let o = {x: 42, y: 0}
    return o?.x
  }`)
  is(f(), 42)
})

test('optional: ?.prop on null returns null', () => {
  const { f } = run(`export let f = () => {
    let o = null
    return o?.x
  }`)
  ok(isNaN(f()), '?.prop on null returns null NaN')
})

test('optional: ?.[i] on valid array', () => {
  const { f } = run(`export let f = () => {
    let a = [10, 20]
    return a?.[1]
  }`)
  is(f(), 20)
})

test('optional: ?.[i] on null returns null', () => {
  const { f } = run(`export let f = () => {
    let a = null
    return a?.[0]
  }`)
  ok(isNaN(f()), '?.[i] on null returns null NaN')
})

test('optional: ?.[i] on string returns char', () => {
  const { f } = jz(`export let f = () => {
    let s = "ab"
    return s?.[1]
  }`).exports
  is(f(), 'b')
})

test('optional: ?.length on array', () => {
  const { f } = run(`export let f = () => {
    let a = [1, 2, 3]
    return a?.length
  }`)
  is(f(), 3)
})

test('optional: ?.length on string', () => {
  const { f } = run(`export let f = () => {
    let s = "abc"
    return s?.length
  }`)
  is(f(), 3)
})

test('optional: ?.length on null returns null', () => {
  const { f } = run(`export let f = () => {
    let a = null
    return a?.length
  }`)
  ok(isNaN(f()), '?.length on null returns null NaN')
})

test('optional: ?.[i] evaluates base once', () => {
  // Base expression should not be re-evaluated in the then branch
  const { f } = run(`export let f = () => {
    let c = 0
    let a = [100, 200]
    let r = a?.[c]
    return r
  }`)
  is(f(), 100)
})

test('optional: ?.prop on dynamic HASH object', () => {
  is(run(`export let f = () => {
    let o = JSON.parse('{"x":1}')
    return o?.x
  }`).f(), 1)
})

// obj?.method(args) evaluates obj once, returns null when nullish, otherwise
// dispatches the same as obj.method(args). These pin that the optional-callee
// shape (['()', ['?.', ...], ...]) reaches the standard method dispatch — so
// type-aware lowerings like .toLowerCase apply to optional chains too.

test('optional: ?.method() on string literal', () => {
  const { f } = jz(`export let f = () => "Express"?.toLowerCase()`).exports
  is(f(), 'express')
})

test('optional: ?.method() on local string', () => {
  const { f } = jz(`export let f = () => {
    let s = "Express"
    return s?.toLowerCase()
  }`).exports
  is(f(), 'express')
})

test('optional: ?.method() on null returns null', () => {
  const { f } = run(`export let f = () => {
    let s = null
    return s?.toLowerCase()
  }`)
  ok(isNaN(f()), '?.method() on null returns NULL_NAN')
})

test('optional: ?.method() on hash member', () => {
  // The compound case: hash-derived string flowing into an optional method
  // chain — exercises both the hash read and the optional-call lowering.
  const { f } = jz(`export let f = () => {
    let h = JSON.parse('{"name":"Express"}')
    return h.name?.toLowerCase()
  }`).exports
  is(f(), 'express')
})

// Optional-chain continuation: per ECMAScript, an optional access short-circuits
// the entire continuation chain, not just its own step. `a?.b.c` with nullish `a`
// must evaluate to undefined — not run `.c` on the nullish result of `a?.b`.

test('optional: ?.b.c continuation with nullish base returns undefined', () => {
  const { f } = run(`export let f = (a) => a?.b.c`)
  ok(isNaN(f(null)), 'a?.b.c with null returns undef NaN')
  ok(isNaN(f(undefined)), 'a?.b.c with undefined returns undef NaN')
})

test('optional: ?.b.c continuation with non-null base reads through', () => {
  const { f } = run(`export let f = () => {
    let o = {b: {c: 42}}
    return o?.b.c
  }`)
  is(f(), 42)
})

test('optional: ?.b[i] continuation with nullish base returns undefined', () => {
  const { f } = run(`export let f = (a) => a?.b[0]`)
  ok(isNaN(f(null)), 'a?.b[0] with null returns undef NaN')
})

test('optional: nested ?.b?.c.d short-circuits at deepest nullish', () => {
  const { f } = run(`export let f = () => {
    let o = {b: null}
    return o?.b?.c.d
  }`)
  ok(isNaN(f()), 'o?.b?.c.d with null b returns undef NaN')
})

test('optional: dynamic string property compares numerically against number RHS', () => {
  const { f } = jz(`export let f = () => {
    let o = JSON.parse('{"a":{"b":"10"}}')
    return o.a?.b > 6
  }`).exports
  is(f(), true)
})

// ============================================
// typeof
// ============================================

test('typeof: number', async () => {
  const { exports: { f } } = await jz('export let f = () => typeof 42')
  is(f(), 'number')
})

test('typeof: array (pointer)', async () => {
  const { exports: { f } } = await jz('export let f = () => { let a = [1,2]; return typeof a }')
  is(f(), 'object')
})

test('typeof: object (pointer)', async () => {
  const { exports: { f } } = await jz('export let f = () => { let o = {x: 1}; return typeof o }')
  is(f(), 'object')
})

test('typeof: string SSO', async () => {
  const { exports: { f } } = await jz('export let f = () => { let s = "hi"; return typeof s }')
  is(f(), 'string')
})

test('typeof: string heap', async () => {
  const { exports: { f } } = await jz('export let f = () => { let s = "hello world"; return typeof s }')
  is(f(), 'string')
})

// A destructured binding must carry the same type tag as the element it bound.
// Regression: `let [, idx] = arr` lost the type tag, so `typeof idx` returned
// 'undefined' even though the value coerced fine — while `arr[1]` was correct.
// Surfaced in watr's `let [, idx] = nodes.shift(); typeof idx === 'string'`
// type resolution, producing spurious "Type mismatch" compile errors.
test('typeof: destructured string binding', async () => {
  const { exports: { f } } = await jz(`export let f = () => { let arr = ['type', '\$name']; let [, idx] = arr; return typeof idx }`)
  is(f(), 'string')
})

test('typeof: destructured matches indexed', async () => {
  const { exports: { f } } = await jz(`export let f = () => {
    let arr = ['type', '\$name']
    let [, d] = arr
    let i = arr[1]
    return (typeof d) === (typeof i) ? 'match' : 'mismatch'
  }`)
  is(f(), 'match')
})

// Destructuring the Math builtin must bind members like the equivalent alias
// `let abs = Math.abs` (which compiles and runs). Idiomatic shorthand in the
// wild: window-function/util.js `export let { cos, sin, abs, … } = Math`, and
// fourier-transform/index.js `const { sqrt, sin, cos, abs, SQRT1_2, SQRT2 } = Math`.
test('destruct: from Math builtin namespace', () => {
  const { exports: { f } } = jz(`let { abs } = Math
export let f = (x) => abs(x)`)
  is(f(-3), 3)
})

test('destruct: Math namespace in function body', () => {
  const { exports: { f } } = jz(`export let f = (x) => { let { max, abs } = Math; return max(abs(x), 2) }`)
  is(f(-5), 5)
})

test('destruct: renamed member `{ pow: myPow }`', () => {
  const { exports: { f } } = jz(`const { pow: myPow } = Math
export let f = (x, y) => myPow(x, y)`)
  is(f(2, 10), 1024)
})

test('destruct: constant member `{ SQRT2 }`', () => {
  const { exports: { f } } = jz(`const { SQRT2 } = Math
export let f = (x) => x * SQRT2`)
  is(f(2), 2 * Math.SQRT2)
})

// fourier-transform/index.js line 7, verbatim shape — blocks compiling every
// package (noise-reduction: stft/wiener/omlsa/specsub/dereverb/vad/…) that
// windows a signal through it.
test('destruct: fourier-transform-shaped multi-name destructure', () => {
  const { exports: { f } } = jz(`const { sqrt, sin, cos, abs, SQRT1_2, SQRT2 } = Math
export let f = (v) => sqrt(abs(v)) * SQRT1_2 * SQRT2`)
  is(f(-4), Math.sqrt(Math.abs(-4)) * Math.SQRT1_2 * Math.SQRT2)
})

// Module top-level `let { … } = Math` must not collide with the compiler's
// own internal globals of the same name in a multi-module bundle (observed as
// "'abs' conflicts with a compiler internal — choose a different name"). A
// plain user binding `let abs = (x) => x` (no Math involved) already compiles
// fine, so the collision was specific to the destructure path.
test('destruct: top-level `let {abs} = Math` in a multi-module bundle', () => {
  const { exports } = jz(
    `import { go } from './dep.js'
    let { abs, exp, max } = Math
    export let f = (v) => max(abs(v), go(v))`,
    { modules: { './dep.js': `export let go = (x) => x + 1` } }
  )
  is(exports.f(-5), Math.max(Math.abs(-5), -5 + 1))
})

// A user binding named `Math` must shadow the builtin namespace — destructuring
// from it reads the user's own object, not Math.sqrt.
test('destruct: user `Math` binding shadows the builtin', () => {
  const { exports: { f } } = jz(`let Math = { sqrt: (x) => x }
const { sqrt } = Math
export let f = (v) => sqrt(v)`)
  is(f(7), 7)
})

// Adversarial: a plain user variable/global that happens to be spelled like
// one of the compiler's own INTERNAL module names ('math', 'fn', 'array', …
// — the lowercase emit-key prefix, distinct from the capitalized `Math`
// builtin) must resolve as an ordinary binding. The namespace-alias fast path
// keys off resolved values, and an un-renamed local self-maps to its own name
// in the scope table — so a variable literally named `math`/`fn` must not be
// mistaken for a compile-time alias to the `math`/`fn` module.
test('destruct: user variable named like an internal module name (`math`) is not intercepted', () => {
  const { exports: { f } } = jz(`let math = { sqrt: (x) => x + 1 }
export let f = (v) => math.sqrt(v)`)
  is(f(7), 8)
})

test('destruct: bare local named like an internal module name (`fn`) compiles as an ordinary binding', () => {
  const { exports: { g } } = jz(`let fn = 5
export let g = () => fn`)
  is(g(), 5)
})

// Assignment-form destructure (`({x} = Math)`, no declaration) goes through a
// different prepare path than `let {x} = Math` — pin it separately.
test('destruct: assignment-form `({sqrt, abs} = Math)`', () => {
  const { exports: { f } } = jz(`let sqrt, abs
;({sqrt, abs} = Math)
export let f = (v) => sqrt(abs(v))`)
  is(f(-9), 3)
})

// Namespace-as-value aliasing (`const M = Math; M.sqrt(x)`) is the same class
// of bug: no first-class Math value exists, so `M` must alias the module
// itself, not box a runtime namespace object.
test('destruct: namespace-as-value alias `const M = Math`', () => {
  const { exports: { f } } = jz(`const M = Math
export let f = (v) => M.sqrt(v)`)
  is(f(9), 3)
})

// Same alias, declared inside a function body instead of at module top level.
// The top-level form (above) aliases `M` through `scope.chain` — the same flat
// table `Math` itself resolves through, so the '.' handler needs no changes.
// Inside a function, `registerBuiltinAlias` would instead have to write `M`
// into the block-scoped `scopes` stack, which the '.' handler's `mod =
// ctx.scope.chain[obj]` check does not consult — extending it there requires
// distinguishing a genuine alias from an ordinary un-renamed local that merely
// happens to be NAMED like a module (e.g. a `fn` callback parameter self-maps
// to its own name), which is more risk to the hottest path in prepare than
// this rarer shape justifies.
// Re-verified independently (2026-07-06): confirmed in src/prepare/index.js —
// `resolveCallee`'s bare-identifier branch DOES check `scopes.length &&
// isDeclared(callee) ? resolveScope(callee) : ctx.scope.chain[callee]`, but its
// sibling `.`-callee branch a few lines down reads only `ctx.scope.chain[obj]`,
// exactly as diagnosed — the fix is real and roughly as scoped as described.
// Left AS TODO this session for an ADDITIONAL, independent reason: this file is
// mid-edit by the user this session (git status dirty, non-empty diff already
// present) and the project's own discipline for this pass forbids touching it
// while that's true — not just the architectural-risk call above. Flip
// `test.todo` → `test` when fixed.
test('destruct: namespace-as-value alias inside a function body', () => {
  const { exports: { f } } = jz(`export let f = (v) => { const M = Math; return M.sqrt(v) }`)
  is(f(16), 4)
})

// A builtin-namespace alias carries no storage (it's a compile-time-only
// rewrite to the resolved emit key) — reassigning it must be a clear compile
// error, never a silent miscompile that targets nothing.
test('destruct: reassigning a plain alias `let sin = Math.sin` is a compile error', () => {
  let error
  try { compile(`let sin = Math.sin
sin = 5
export let f = () => sin`) } catch (e) { error = e }
  ok(error && /Cannot reassign 'sin'/.test(error.message), `expected a reassignment error, got: ${error?.message}`)
})

test('destruct: reassigning a destructured member `{abs}` is a compile error', () => {
  let error
  try { compile(`let { abs } = Math
abs = 5
export let f = () => abs`) } catch (e) { error = e }
  ok(error && /Cannot reassign 'abs'/.test(error.message), `expected a reassignment error, got: ${error?.message}`)
})

test('destruct: reassigning a function-scope destructured member is a compile error', () => {
  let error
  try { compile(`export let f = (x) => { let { abs } = Math; abs = 5; return abs }`) } catch (e) { error = e }
  ok(error && /Cannot reassign 'abs'/.test(error.message), `expected a reassignment error, got: ${error?.message}`)
})

// jzify hoists top-level `function` declarations to the front of their
// enclosing block (mirroring JS function-hoisting), so a `function`-declared
// helper can textually precede the `let {…} = Math` alias it calls. Real JS
// gets away with this because the helper isn't invoked until the whole module
// has finished initializing — pin that jz resolves the alias the same way.
test('destruct: hoisted sibling function references a Math alias declared later in source order', () => {
  const { exports } = jz(`
    export default function run(x) { return helper(x) }
    let { exp } = Math
    function helper(x) { return exp(x) }
  `)
  // jz's own exp kernel (module/math.js) approximates, so this diverges from
  // V8's native Math.exp by a few ulps — tolerance, not exact equality (same
  // convention as test/math.js's `almost`).
  ok(Math.abs(exports.default(1) - Math.exp(1)) < 1e-6, `expected ~${Math.exp(1)}, got ${exports.default(1)}`)
})

// ============================================================================
// Unblanketing fixes (2026-07-10) — three real bugs the coarse test262 skips hid:
// 1. defaults fired on null (?? lowering) — must fire ONLY on undefined;
// 2. numeric keys in object patterns crashed the compiler (string-hash on 0);
// 3. `var` pattern declarators were silently DROPPED by hoist-vars.
// ============================================================================

test('destruct: defaults fire only on undefined, never null', () => {
  is(run(`export let f = () => { let [a = 1, b = 2] = [null, undefined]; return (a === null ? 1 : 0) * 10 + b }`).f(), 12)
  is(run(`export let f = () => { let { x = 5, y = 6 } = { x: null }; return (x === null ? 1 : 0) * 10 + y }`).f(), 16)
  // lazy: default not evaluated when a value is present
  is(run(`export let f = () => { let n = 0; let bump = () => ++n; let [a = bump()] = [5]; return n * 10 + a }`).f(), 5)
  // holes and out-of-bounds still take defaults
  is(run(`export let f = () => { let v, h, o, k = 0; for ([v = 1, h = 2, o = 3] of [[9, , ]]) k = v * 100 + h * 10 + o; return k }`).f(), 923)
})

test('destruct: numeric keys in object patterns are index reads', () => {
  is(run(`export let f = () => { let { 0: v, length: z } = [7, 8]; return v * 10 + z }`).f(), 72)
  is(run(`let g = ([...{ 0: v, 1: w, length: z }]) => v * 100 + w * 10 + z; export let f = () => g([7, 8])`).f(), 782)
})

test('destruct: var pattern declarators hoist their bindings', () => {
  is(run(`var [b] = [3]; export let f = () => b`).f(), 3)
  is(run(`var { x, y = 2 } = { x: 9 }; export let f = () => x * 10 + y`).f(), 92)
  is(run(`export let f = () => { var a = 1, [b2] = [2], { c } = { c: 3 }; return a * 100 + b2 * 10 + c }`).f(), 123)
})

// for-of head assignment-form object pattern parses as a STATEMENT-position
// `{…}` cover (a `;`-block node, not a `,`-list) — patternItems unwraps both.
// Before: the pattern silently mis-destructured (defaults fired on null).
test('destruct: for-of head cover-grammar object pattern', () => {
  is(run(`export let f = () => { let x, c = 0; for ({ x = 1 } of [{ x: null }]) { c = (x === null ? 1 : 0) * 10 + 1 } return c }`).f(), 11)
  is(run(`export let f = () => { let x, c = 0; for ({ x = 2 } of [{}]) { c = x } return c }`).f(), 2)
  is(run(`export let f = () => { let x; for ({ x } of [{ x: 9 }]) { } return x }`).f(), 9)
})

// `arguments`-lowered param defaults ride the same undefined-only rule
// (jzify/arguments.js used `??` — a passed null took the default).
test('destruct: arguments-path param default fires only on undefined', () => {
  is(run(`function f(a = 9) { return arguments.length * 100 + (a === null ? 10 : a === undefined ? 20 : a) }
    export let g = () => f() * 1000 + f(null)`).g(), 9110)
})

// catch-param patterns + var-pattern for-of heads + assignment-form targets
// (2026-07-10): all three bound nothing or shadowed the outer binding before.
test('destruct: catch patterns / var-pattern heads / assignment-form targets', () => {
  is(run(`export let f = () => { try { throw { a: 5 } } catch ({ a }) { return a } }`).f(), 5)
  is(run(`export let f = () => { try { throw [7] } catch ([x]) { return x } }`).f(), 7)
  is(run(`export let f = () => { let r = 0; for (var { x } of [{ x: 3 }]) r = x; return r }`).f(), 3)
  is(run(`export let f = () => { for (var [y] of [[4], [9]]) { } return y }`).f(), 9)
  // assignment-form heads write the EXISTING binding (visible after the loop)
  is(run(`export let f = () => { let x = 0; for (x of [5, 6]) { } return x }`).f(), 6)
  is(run(`export let f = () => { let o = { x: 0 }; for (o.x of [7, 8]) { } return o.x }`).f(), 8)
  is(run(`export let f = () => { let a = 0; for ([a] of [[9]]) { } return a }`).f(), 9)
  is(run(`export let f = () => { let k = 0; for (k in { z: 1 }) { } return k.length }`).f(), 1)
})

// Shadow renames for catch params + destructure targets (2026-07-20): a catch
// param or pattern target shadowing an outer (renamed) binding used to resolve
// handler/block reads to the OUTER binding — and the catch local aliased its
// WASM slot. Catch now gets its own scope frame + rename; pattern targets
// rename via substPattern (prop keys stay source-spelled: `{x}` → `{x: x@n}`).
test('destruct: shadowed catch params and pattern targets bind their own local', () => {
  is(run(`export let main = () => { let e = 5; { let e = 6; try { throw 1 } catch (e) { return e } } }`).main(), 1)
  is(run(`export let main = () => { let e = 5; try { throw 1 } catch (e) { e = e + 10 } return e }`).main(), 5)
  is(run(`export let main = () => { try { throw 1 } catch (e) { try { throw 2 } catch (e) { return e } } }`).main(), 2)
  is(run(`export let main = () => { let x = 50; { let x = 60; try { throw { x: 2 } } catch ({ x }) { return x } } }`).main(), 2)
  is(run(`export let main = () => { let x = 50; let r = 0; { let { x } = { x: 2 }; r = x } return r * 100 + x }`).main(), 250)
  is(run(`export let main = () => { let v = 50; let r = 0; { let { k: v } = { k: 3 }; r = v } return r * 100 + v }`).main(), 350)
  is(run(`export let main = () => { let a = 9; let r = 0; { let [a, ...rs] = [1, 2, 3]; r = a * 10 + rs[1] } return r * 100 + a }`).main(), 1309)
  is(run(`export let main = () => { let x = 50; let r = 0; { let { o: { x } } = { o: { x: 8 } }; r = x } return r * 100 + x }`).main(), 850)
  // sibling pattern binding referenced from a default sees the NEW binding
  is(run(`export let main = () => { let r = 0; { let { a, b = a + 1 } = { a: 5 }; r = a * 10 + b } return r }`).main(), 56)
})

// The comma-group hole: the parser groups multi-prop object patterns as
// ['{}', [',', 'a', 'b']] — renaming those bare strings as array-style targets
// destroyed the shorthand's implied KEY ({a}→{a@1}, reads a nonexistent prop).
// This shape is all over the compiler's own source (for (const [, {lName, type}]
// of replacements) in promote-globals) — the miscompiled pass only RUNS inside
// the built kernel, so the kernel leg was the sole witness (1h17m fuzz-gate spin).
test('destruct: renamed multi-prop object patterns keep property keys', () => {
  is(run(`export let f = () => { const a = 100, b = 200; let out = a + b; { const [, { a, b }] = [0, { a: 1, b: 2 }]; out = out * 10 + a + b } return out }`).f(), 3003)
  is(run(`export let f = () => { const m = new Map(); m.set('gA', { a: 1, b: 2 }); m.set('gB', { a: 3, b: 4 }); const a = 100, b = 200; let out = a + b; for (const [, { a, b }] of m) out = out * 10 + a + b; return out }`).f(), 30037)
  is(run(`export let f = () => { const a = 9; let r = 0; { const { a = 5 } = {}; r = a } return r * 10 + a }`).f(), 59)
  is(run(`export let f = () => { const a = 9; let r = 0; { const { a = 5 } = { a: 3 }; r = a } return r * 10 + a }`).f(), 39)
})
