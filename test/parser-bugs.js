import test from 'tst'
import jz, { compile } from '../index.js'
import { is, ok } from 'tst/assert.js'
import { isDestructurePat } from '../jzify/hoist-vars.js'
import { parse } from '../src/parse.js'

test('bracketless nested conditionals', () => {
    let src = `
        export let f = (a, b) => {
            let res = 0;
            if (a)
                if (b) res = 1;
                else res = 2;
            else
                if (b) res = 3;
                else res = 4;
            return res;
        };
    `;
    let { exports } = jz(src, { env: {} });
    is(exports.f(1, 1), 1);
    is(exports.f(1, 0), 2);
    is(exports.f(0, 1), 3);
    is(exports.f(0, 0), 4);
});

test('bracketless nested conditionals with trailing statements', () => {
    let src = `
        export let f = (a, b) => {
            let res = 0;
            if (a) {
                if (b) res = 1;
                else res = 2;
            } else {
                if (b) res = 3;
                else res = 4;
            }
            return res;
        };
    `;
    let { exports } = jz(src, { env: {} });
    is(exports.f(1, 1), 1);
    is(exports.f(1, 0), 2);
    is(exports.f(0, 1), 3);
    is(exports.f(0, 0), 4);
});

// --- valid-jz = valid-JS guards (re-audit pass 4) ---

const rejects = (src, match) => {
    let err
    try { compile(src) } catch (e) { err = e }
    ok(err, `should reject: ${src}`)
    if (match) ok(err.message.includes(match), `error should mention '${match}': ${err && err.message}`)
}

test('object getter/setter rejected (PARSE-3): jz objects have no accessors', () => {
    // Previously compiled to dead code → o.x read undefined (silent miscompile).
    rejects('export let f = () => { let o = { get x() { return 42 } }; return o.x }', 'getter/setter')
    rejects('export let f = () => { let o = { set x(v) {} }; return 1 }', 'getter/setter')
    // Methods, spread, shorthand, plain props must still compile.
    is(jz('export let f = () => { let o = { g() { return 7 } }; return o.g() }').exports.f(), 7)
    is(jz('export let f = () => { let a = 5; let o = { a, b: 2 }; return o.a + o.b }').exports.f(), 7)
})

test('?? mixed with ||/&& without parens rejected (PARSE-4, ES2020)', () => {
    rejects('export let f = () => null ?? 1 || 2', '??')
    rejects('export let f = (a, b, c) => a ?? b && c', '??')
    rejects('export let f = (a, b, c) => a || b ?? c', '??')
    // Parenthesized + non-mixed + destructuring defaults using || stay valid.
    is(jz('export let f = (a, b, c) => a ?? (b || c)').exports.f(7, 0, 0), 7)
    is(jz('export let f = (a, b, c) => (a ?? b) || c').exports.f(0, 5, 9), 9)
    is(jz('export let f = (b, c) => { let [a = b || c] = []; return a }').exports.f(0, 9), 9)
})

test('early errors: scopes, parameters, targets, and control flow reject before jzify', () => {
    rejects('let x; let x;', 'duplicate lexical')
    rejects(`'use strict'; function f(a, a) {}`, 'duplicate parameter')
    rejects('const f = ([a]) => { "use strict"; return a }', 'non-simple')
    rejects('1 = 2', 'assignment target')
    rejects('const x;', 'requires an initializer')
    rejects('break;', 'outside loop')
    rejects('class C { constructor(){} constructor(){} }', 'constructor')
    rejects('class C { #x; m(){ return this.#y } }', 'not declared')
    // Deliberately valid counterexamples: sloppy simple duplicate parameters,
    // nested rest binding patterns, and ordinary for-of declarations.
    ok(compile('function f(a, a){ return a }') instanceof Uint8Array, 'sloppy Script permits simple duplicate params')
    is(jz('let f = ([...{0:x}]) => x; export let g = () => f([7])').exports.g(), 7)
    is(jz('export let g = () => { let s=0; for (const x of [1,2]) s+=x; return s }').exports.g(), 3)
})

test('early errors: nested spread commas do not masquerade as a trailing rest parameter', () => {
    is(jz('export let f = (x = [...[]]) => x.length').exports.f(), 0,
      'empty spread without a trailing comma stays valid')
    is(jz('export let f = (x = [...[],]) => x.length').exports.f(), 0,
      'empty spread at the final comma boundary stays valid')
    is(jz('export let f = (x = { a: [...[],] }) => x.a.length').exports.f(), 0,
      'the initializer marker survives nested object and array delimiters')
    is(jz('export let f = ({ x = [...[],] } = {}) => x.length').exports.f(), 0,
      'an object binding default starts expression context at its own nesting depth')
    is(jz('export let f = ([x = [...[],]] = []) => x.length').exports.f(), 0,
      'an array binding default starts expression context at its own nesting depth')
    is(jz('export let f = (x = ([...[],])) => x.length').exports.f(), 0,
      'a parenthesized initializer inherits expression context')
    is(jz('let n = (...x) => x.length; export let f = (x = n(...[],)) => x').exports.f(), 0,
      'call-spread trailing commas remain valid inside an initializer')
    is(jz('export let f = (x = [...[], 1,]) => x[0]').exports.f(), 1,
      'array spread followed by an element and trailing comma stays valid')
    is(jz('let n = (...x) => x.length; export let f = () => n(...[],)').exports.f(), 0,
      'call spread with a trailing comma stays valid')
    is(jz("const base=['for']; export let f=(types=[...base,'switch','switch_typeswitch'])=>types.join(',')").exports.f(),
      'for,switch,switch_typeswitch', 'Porffor default-parameter shape keeps all elements in order')
    rejects('export let f = (...x,) => x.length', 'rest parameter')
    rejects('export let f = ([...x,]) => x.length', 'rest parameter')
    rejects('export let f = ({...x,}) => x', 'rest parameter')
    // JZ cannot preserve this computed binding key yet. Keep it on the reject
    // side of correct-or-reject instead of exposing an accepted undefined.
    rejects('export let f = ({[([...[],]).length]: x}) => x', 'rest parameter')
    // A call-spread trailing comma followed by a newline block is valid JS, but
    // the source-only rest validator cannot distinguish that boundary yet.
    // Keep it as a clean rejection until the parser retains the needed context.
    rejects(`let n = (...x) => x.length
      export let f = () => { n(...[],)\n{}\nreturn 1 }`, 'rest parameter')
})

test('early errors: erased lexical spellings are validated from source text', () => {
    rejects('export let f = () => 1__0', 'separator')
    rejects('export let f = () => 01n', 'leading zero')
    rejects('export let f = () => /a/gg', 'duplicate regular expression flag')
    rejects('export let f = () => /(?<x>a)(?<x>b)/', 'duplicate regular expression group')
    rejects('export let f = () => `\\xZ`', 'template escape')
    rejects('export let f = a => a?.x`tag`', 'optional chain')
    is(jz('export let f = () => 1_000 + 0xFF').exports.f(), 1255)
    is(jz('export let f = () => `line 1\nline 2`.length').exports.f(), 13)
})

test('always-reserved `const` rejected as a binding name (PARSE-6)', () => {
    rejects('export let f = () => { let const = 5; return const }', 'reserved')
    // `let` remains valid as a sloppy IdentifierReference (`for (let in o)`),
    // but it is never a legal LexicalBinding name.
    rejects('export let f = () => { let let = 5; return let }', 'lexical')
    // `const` stays usable as a property name; normal let/const declarations unaffected.
    is(jz('export let f = () => { let o = { const: 7 }; return o.const }').exports.f(), 7)
    is(jz('export let f = () => { let x = 5; const y = 7; return x + y }').exports.f(), 12)
})

test('unparenthesized unary base of ** rejected (PARSE-2, ES2016 §13.6)', () => {
    // Every UnaryExpression base is a JS SyntaxError — precedence is ambiguous.
    rejects('export let f = (x) => -x ** 2', '13.6')
    rejects('export let f = (x) => +x ** 2', '13.6')
    rejects('export let f = (x) => ~x ** 2', '13.6')
    rejects('export let f = (x) => !x ** 2', '13.6')
    rejects('export let f = (x) => typeof x ** 2', '13.6')
    rejects('export let f = (x) => void x ** 2', '13.6')
    // PARSE-2B: `delete` was the one UnaryExpression missing from the guard — it
    // silently compiled before. `delete o[k] ** 2` is a SyntaxError in every JS engine.
    rejects('export let f = (o, k) => delete o[k] ** 2', '13.6')
    // Parenthesizing either side disambiguates → valid in both JS and jz.
    is(jz('export let f = (x) => (-x) ** 2').exports.f(3), 9)
    is(jz('export let f = (x) => -(x ** 2)').exports.f(3), -9)
})

// ── subscript-10.5.0 parser-core shapes ─────────────────────────────────────
// The rewritten tokenizer core (dispatch/register descriptor machinery) exposed
// six latent jz miscompiles when the kernel self-compiled it. Each pin below is
// the ddmin-reduced shape; the kernel build (test/self-compile.js) is the
// integration-level pin for the same set.

test('i32 param narrow excludes body-mutated params', () => {
    // All-i32 callsites narrowed `a` to i32 while `a += 1` emitted through the
    // f64 assign path → wasm validation error (local.set type clash).
    for (const optimize of [false, true]) {
        is(jz('let g = (a) => { a += 1; return a }\nexport let main = () => g(1)', { optimize }).exports.main(), 2)
        is(jz('let g = (a) => { for (let i = 0; i < 3; i++) a += i; return a }\nexport let main = () => g(1)', { optimize }).exports.main(), 4)
    }
})

test('default-param closures are not double-prepped (for-init decl inside)', () => {
    // defFunc re-prepped already-prepped default values; a prepared 5-ary `for`
    // re-entering the 2-ary handler shifted init/cond/step into the wrong slots.
    const src = `const mk = (ops, fn = (a) => { for (let i = 0, d; (d = ops[i++]); ) { if (d === a) return i } return 0 }) => fn
export let main = () => mk([3,4,5])(4)`
    for (const optimize of [false, true]) is(jz(src, { optimize }).exports.main(), 2)
})

test('comma sequence carries the last value\'s ptrKind', () => {
    // `return (fn.a = 1, fn)` numeric-converted the raw heap offset — the `,`
    // emitter dropped ptrKind/ptrAux (same class the ternary tagPtr fixed).
    const src = `const mk = (k) => { const fn = (x) => x + k; return (fn.a = 1, fn.b = 2, fn) }
export let main = () => mk(5)(2)`
    for (const optimize of [false, true]) is(jz(src, { optimize }).exports.main(), 7)
    is(jz('const mk = (k) => { let o = { v: k }; return (o.a = 1, o.b = 2, o) }\nexport let main = () => mk(5).v').exports.main(), 5)
})

test('ToPropertyKey: runtime non-string keys address their string slot', () => {
    // o[97] ≡ o['97'] (spec ToPropertyKey) — writes stringified (static fold),
    // reads hashed the raw f64 → miss. Now normalized at the dyn get/set/del
    // entries, and known HASH/OBJECT receivers route non-string-key reads there.
    // (UNKNOWN receivers keep the documented lean numeric→array-index read; see
    // module/array.js's numeric-index design note.)
    is(jz('export let main = () => { const o = {}; o[97] = 5; return o["97"] }').exports.main(), 5)
    is(jz('export let main = () => { const o = { x: 1 }; o["97"] = 5; let k = 97; return o[k] === undefined ? 0 : 1 }').exports.main(), 1)
    is(jz('export let main = () => { const o = JSON.parse(\'{"97":5}\'); let k = 97; return o[k] }').exports.main(), 5)
})

test('own prop shadows array builtin on unknown receiver (d.map)', () => {
    // `d.map(a)` on a statically-unknown receiver was hijacked by
    // Array.prototype.map — subscript's descriptor mapper is literally `map`.
    const src = `const find = (ops) => { const d = ops[0]; return d.map(1) }
export let main = () => find([{ op: 'a', map: (x) => x + 41 }])`
    for (const optimize of [false, true]) is(jz(src, { optimize }).exports.main(), 42)
    // real arrays keep the builtin
    is(jz('const f = (a) => a.map((x) => x * 2)\nexport let main = () => f([1,2,3])[2]').exports.main(), 6)
})

test('flattenFuncNamespaces rewrites fn.defaults too (parse.id through dispatch)', () => {
    // The func-prop SRoA dissolved `parse.id` writes into a module global but
    // missed reads inside DEFAULT-PARAM closures → the read stayed on the
    // dyn-table path → undefined → subscript's word-guard collapsed and `init`
    // lexed as `in`+`it`. Three-module shape: define+expando, rewrap, dispatch.
    const code = `import { parse, lookup, binary } from './m1.js'
import './m2.js'
export let main = () => {
  parse('init()')
  const h = lookup[105]
  const r = h ? h('x', 0, 0) : -1
  return r === undefined ? 0 : (Array.isArray(r) ? 100 : 1)
}`
    const modules = {
        './m1.js': `export let idx = 0, cur = ''
export const parse = (s) => { cur = s; idx = 0; return 0 }
parse.id = c => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 36 || c == 95
export const lookup = [], prec = {}
const token = (op, p, map, c = op.charCodeAt(0)) => register({
  op, l: op.length, p: prec[op] = !lookup[c] && prec[op] || p, map,
  word: op.toUpperCase() !== op, kw: false
})
export const binary = (op, p) => token(op, p, (a, b) => a && (b = 777) && [op, a, b])
const dispatch = (ops, tail, fn = (a, curPrec, curOp, from = idx, r, d, i) => {
  for (i = 0; (d = ops[i++]);) {
    if (d.kw && a) continue;
    if (curOp ? d.op !== curOp :
      !((d.l < 2 || (d.op.charCodeAt(1) === cur.charCodeAt(idx + 1) && (d.l < 3 || cur.substr(idx, d.l) === d.op))) &&
        (!d.word || !parse.id(cur.charCodeAt(idx + d.l))) &&
        (curOp = d.op))) continue;
    if (curPrec >= d.p) continue;
    idx += d.l;
    if (r = d.map(a)) return r;
    idx = from, curOp = 0;
  }
  return tail ? tail(a, curPrec, curOp) : undefined;
}) => (fn.ops = ops, fn.tail = tail, fn)
const register = (d, c = d.op.charCodeAt(0), fn = lookup[c]) =>
  lookup[c] = (fn && fn.ops) ? dispatch([d, ...fn.ops], fn.tail) : dispatch([d], fn)
binary('in', 10)
binary('instanceof', 10)`,
        './m2.js': `import { parse } from './m1.js'
const id = parse.id
parse.id = c => id(c)`,
    }
    // 0 = word-guard rejected 'in' inside 'init' (correct); 100 = the in-split bug
    is(jz(code, { modules }).exports.main(), 0)
})

test('for-in/of heads: assignment/sequence sources re-associate', () => {
    // subscript ≤10.5.0 grouped `for (s in cm = x)` as `(s in cm) = x`; the
    // statement layer re-associates (10.5.1 fixes the parser too — this pins
    // jz's own defense for the shape class).
    is(jz('export let main = () => { let cm, s, r = 0; for (s in cm = {a:1,b:2}) r++; return r * 10 + cm.a }').exports.main(), 21)
    is(jz('export let main = () => { let a, v, r = 0; for (v of a = [1,2,3]) r += v; return r + a.length }').exports.main(), 9)
    is(jz('export let main = () => { let s, k = 0, r = 0; for (s in (k = 5, {m:1,n:2})) r++; return r * 10 + k }').exports.main(), 25)
})

// ── jzify pre-prepare '[]'-tag ambiguity (self-compile typed-elem-compare hunt) ──
// A `'[]'`-tagged node means two different things before prepare() splits them
// into `'['` (array literal) / `'[]'` (element access): a destructure pattern
// (`[a,b] = …` → `['[]', commaSeqOrSingleElem]`, length ≤ 2) and an element
// write (`arr[i] = …` → `['[]', receiver, index]`, ALWAYS length 3). jzify's
// `isDestructurePat` checked only the tag, so `arr[i] = v` — any bracket
// assignment, any receiver (array/typed array/plain object) — misclassified as
// a destructuring assignment and was walked as a pattern instead of falling
// through to the plain-assignment path.

test('isDestructurePat: element-access target is not a destructuring pattern (arity, not tag alone)', () => {
    // The exact shape confusion: both share op '[]', disambiguated only by length.
    ok(!isDestructurePat(['[]', 'arr', [null, 0]]), 'arr[0] (element access, length 3) is not a pattern')
    ok(!isDestructurePat(['[]', 'arr', 'i']), 'arr[i] (element access, length 3) is not a pattern')
    ok(isDestructurePat(['[]', [',', 'a', 'b']]), '[a,b] (2-elem pattern, length 2) is still a pattern')
    ok(isDestructurePat(['[]', 'a']), '[a] (1-elem pattern, length 2) is still a pattern')
    ok(isDestructurePat(['{}', 'a']), '{a} (object pattern) is still a pattern — untouched by the fix')
})

test('element-assignment target is never mistaken for a destructuring pattern', () => {
    // Native jzify happened to reconstruct byte-identical IR for the simple
    // receiver-name + literal-index shape either way (the wrong pattern-walk and
    // the right generic-transform fallback are both no-ops here) — masking the
    // misclassification natively. The self-compiled kernel exercises the (wrong)
    // pattern-walk's own compiled path and throws "expected emitted IR value …
    // got empty value" (src/ir.js asF64) for ANY bracket-assignment with this
    // shape — typed array, plain array, or plain-object dynamic key alike.
    // (charter repro, minimally reduced from `samples[j] > 0`'s enclosing program)
    is(jz('export let main = () => { const s = new Float64Array(5); s[0] = 3; return s[0] }').exports.main(), 3)
    is(jz('export let main = () => { const a = [1, 2]; a[0] = 9; return a[0] }').exports.main(), 9)
    is(jz('export let main = () => { const h = {}; let k = "x"; h[k] = 9; return h[k] }').exports.main(), 9)
    is(jz('export let f = (samples, j) => samples[j] > 0\nexport let main = () => { const s = new Float64Array(5); s[0] = 3; return f(s, 0) | 0 }').exports.main(), 1)
    // Destructuring assignment (a genuine pattern target) must stay unaffected.
    is(jz('export let main = () => { let a, b; [a, b] = [1, 2]; return a * 10 + b }').exports.main(), 12)
    is(jz('export let main = () => { let a; [a] = [7]; return a }').exports.main(), 7)
})

// ── emit.js 'return' handler: ternary-duplicated emit() call (fresh-corpus invalid-wasm hunt) ──
// `dist/jz.wasm` compiled the bench corpus to genuinely INVALID wasm: "type error in
// return[0]: expected f64, got i32", identical signature on every case (mat4, json, sort,
// crc32, bitwise, callback, …). Not a narrowI32Results decision bug (both native and the
// kernel agree on which functions narrow) — the divergence is downstream, in how the
// RETURN VALUE gets reboxed once a function's result stays f64 (unnarrowed) but a return
// tail is i32-shaped (`(expr) | 0` needs `f64.convert_i32_s`). The 'return' op handler
// computed that rebox as `pk != null ? asPtrOffset(emit(expr), pk) : asParamType(emit(expr),
// rt)` — emit(expr) called separately, once inline per ternary arm, only one ever executing.
// Behaviorally identical in JS (same AST subtree, one call happens either way) — but the
// SELF-COMPILED kernel, at every self-compile build level (0/1/2) and every runtime optimize
// level, drops the rebox on the taken arm's result. compile/index.js's sibling call site
// (`const ir = emit(body); … ptrKind != null ? asPtrOffset(ir, …) : asParamType(ir, …)`)
// already materializes the call to a local first and was never affected — mirroring that
// shape in emit.js's 'return' handler is the fix.
test('return-statement rebox: i32 tail in an unnarrowed (mixed-tail) function converts to f64', () => {
    // Mixed return kinds (one f64 tail, one i32-shaped `|0` tail) is the natural way a
    // function's result stays unnarrowed while still needing the i32→f64 return-site rebox —
    // no contrived call-graph tricks required.
    is(jz('export let f = (x, c) => { if (c) return x; return (x * 1000) | 0 }').exports.f(3.5, 0), 3500)
    is(jz('export let f = (x, c) => { if (c) return x; return (x * 1000) | 0 }').exports.f(3.5, 1), 3.5)
    // NOTE: a bare `return;` on one path (hasBareReturn) ALSO blocks narrowing the same way,
    // and is fixed the same way through THIS handler — but `export let f = (x, c) => { if
    // (c) return; return (x*1000)|0 }` still traps ("memory access out of bounds") through
    // the kernel at runtime level 2, on the untouched pre-fix kernel too (confirmed via a
    // clean A/B) — a separate, deeper, PRE-EXISTING self-compile bug in the level-2 inliner's
    // interaction with the boundary i64-carrier wrapper for a 2nd exported param, not this
    // session's fix or regression. Left OPEN — tracked in .work/archive/todo.md (self-compile groundtruth archive).
    // charter repro: minimally reduced from bench/mat4 + bench/_lib/benchlib.js's `medianUs`/
    // `printResult` pair — a same-named PARAMETER elsewhere in the program (`printResult`'s
    // `medianUs` param, used in a template literal) marks the top-level `medianUs` function
    // the address-taken census (scope-blind name match, a separate harmless pessimization),
    // so its `(expr) | 0` tail stays unnarrowed exactly like the mixed-tail case above.
    is(jz(`
        const medianUs = (samples) => { return samples[0] | 0 }
        const printResult = (medianUs) => String(medianUs)
        export let main = () => medianUs([3.5])
    `).exports.main(), 3)
})

test('?.() on a statically-lifted func-prop direct-calls (dead-write-drop pair)', () => {
    // The drop-dead-write plan assumes `f.prop(...)` call sites lower to direct
    // calls; the `?.()` emitter lacked that static arm, so the write was dropped
    // AND the read went to the never-written dyn table → undefined.
    const src = `const p = (s) => s
p.step = (x) => x * 2
export let main = () => p.step?.(21)`
    for (const optimize of [false, true]) is(jz(src, { optimize }).exports.main(), 42)
    // nullish/unknown shapes keep short-circuiting
    is(jz('const p = (s) => s\nexport let main = () => p.nope?.(1) === undefined ? 1 : 0').exports.main(), 1)
    is(jz('let f = null\nexport let main = () => f?.() === undefined ? 1 : 0').exports.main(), 1)
})

test('shadow contract: schema-slot writes stay visible to dyn reads (loop-minted closures)', () => {
    // Was KNOWN GAP (2026-07-12), root-caused and FIXED 2026-07-13. The whole
    // pinned closure family (this + the two below) was ONE bug: when a module
    // contains any dynamic key access (`x[expr]`), object literals are minted
    // with a props sidecar seeded per schema key (needsDynShadow), and
    // __dyn_get probes that sidecar BEFORE the schema slots. emit-assign's
    // ptrAux and chained-receiver arms stored schema slots WITHOUT mirroring
    // into __dyn_set, so later dyn reads (e.g. fetching `p.then` at an
    // imprecisely-kinded call site) served the STALE mint-time copy — the
    // subscription silently vanished. The "loop", "export", and "optimizer"
    // deltas never mattered; they only shifted which read sites went dynamic.
    // Both arms now honor the shadow contract (mirror when needsDynShadow).
    const src = (settleBody) => `
        let mt = []
        let mk = () => { let p = { st: 0, val: undefined, cbs: [], then: undefined }; p.then = (ok) => { let q = mk(); if (p.st > 0) { let v = p.val; mt.push(() => { q.st = 1; q.val = ok(v) }) } else p.cbs.push((v) => { q.st = 1; q.val = ok(v) }); return q }; return p }
        let settle = (p, v) => { ${settleBody} }
        let g = () => { let p = mk(); settle(p, 4); return p }
        export let f = () => { let q = g().then((v) => v + 1); while (mt.length > 0) { let cb = mt.shift(); cb() } return q.val }`
    // control: no loop-minted closure
    is(jz(src('p.st = 1; p.val = v')).exports.f(), 5)
    // regression pin: identical flow + a (never-entered) loop minting closures
    is(jz(src('p.st = 1; p.val = v; let cbs = p.cbs; for (let i = 0; i < cbs.length; i++) { let cb = cbs[i]; mt.push(() => cb(v)) }')).exports.f(), 5)
})

test('shadow contract: exported state-mutating closure keeps sibling closures fresh', () => {
    // Was KNOWN GAP — same single root cause as above; fixed 2026-07-13.
    const src = (kw) => `
        let mt = []
        let sq = []
        ${kw} let drain = () => { while (mt.length > 0 || sq.length > 0) { while (mt.length > 0) { let cb = mt.shift(); cb() } if (sq.length > 0) { let p = sq.shift(); let cbs = p.cbs; p.cbs = []; let st = p.st; let v = p.val; for (let i = 0; i < cbs.length; i++) { let cb = cbs[i]; cb(st, v) } } } }
        let mkp = () => { let p = { pp: 1, st: 0, val: undefined, cbs: [], then: undefined }; p.then = (ok) => { let q = mkp(); sub(p, (st, v) => { q.st = 1; q.val = ok(v) }); return q }; return p }
        let sub = (p, h) => { if (p.st > 0) { let st = p.st, v = p.val; mt.push(() => h(st, v)) } else p.cbs.push(h) }
        let settle = (p, st, v) => { if (p.st > 0) return; p.st = st; p.val = v; if (p.cbs.length > 0) sq.push(p) }
        let res = (v) => { let p = mkp(); settle(p, 1, v); return p }
        export let f = () => { let q = res(4).then((v) => v + 1); drain(); return q.val }`
    is(jz(src('')).exports.f(), 5)       // unexported drain
    is(jz(src('export')).exports.f(), 5) // exported drain — was undefined before the fix
})

test('shadow contract: async modules with an indexed array loop survive the optimizer', () => {
    // Was KNOWN GAP ("optimizer round-trip / closure-slot divergence") — same
    // single root cause; the O0/O1 table-size delta was a symptom of stale
    // sidecar reads, not a pass bug. Fixed 2026-07-13.
    const SRC = `let hitFlag = 0
let mark = (e) => { hitFlag = 1 }
export let check = () => hitFlag
let cmp = (a, b, m) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw m }
export let go = () => { (async () => 42)().then((v) => { mark() }, mark); return 1 }`
    for (const optimize of [false, 1, true]) {
        const inst = jz(SRC, { optimize })
        inst.exports.go()
        is(inst.exports.check(), 1, `optimize:${optimize}`)
    }
})

test('shadow contract: string-index assign of a schema key mirrors for prehashed dot reads', () => {
    // Was KNOWN GAP — FIXED 2026-07-13: the literal-string INDEX assign
    // (`it['@@iterator'] = fn`) resolved the schema slot and stored WITHOUT
    // the __dyn_set mirror (the third arm violating the shadow contract, after
    // the dot-path ptrAux/chained arms). It now mirrors when needsDynShadow,
    // so prehashed dot reads (`v[Symbol.iterator]` → dot '@@iterator') see
    // the write on imprecisely-kinded receivers.
    const src = (assign) => `
        let mk = (nx) => {
          let it = { next: nx, '@@iterator': undefined, map: undefined }
          ${assign}
          it.map = (f) => mk((v) => { let r = it.next(v); if (r.done) return r; return { value: f(r.value), done: false } })
          return it
        }
        let dyn = (o, k) => o[k]
        let mkg = () => { let i = 0; return mk((v) => { i++; if (i <= 2) return { value: i, done: false }; return { value: undefined, done: true } }) }
        export let f = () => {
          let v = mkg().map((x) => x + 1)
          let u = v[Symbol.iterator]()
          return '' + (u === v) + '|' + (u != null && u.next != null)
        }`
    is(jz(src('it[Symbol.iterator] = () => it')).exports.f(), 'true|true')   // dot-canonical write
    is(jz(src("it['@@iterator'] = () => it")).exports.f(), 'true|true')       // index write — was false|false before the fix
})

test('param narrowing: pointer-carrying i32 args are not integer evidence', () => {
    // Was KNOWN GAP ("@@iterator method literal invisible post-init") — FIXED
    // 2026-07-13. Root: the call-site `wasm` lattice counted an i32-lane
    // POINTER argument (a caller local/param already narrowed to an unboxed
    // offset) as plain-integer evidence, so the callee's param narrowed to
    // numeric i32 and every read widened the raw offset with f64.convert_i32_s
    // — the object arrived as a small NUMBER and every prop probe missed
    // (Promise.any(obj) → __p_any → __p_list never saw @@iterator). argWasmType
    // now reports the boxed f64 lane for pointer-kinded bare-name args; only
    // applyPointerParamAbi (which stamps ptrKind/ptrAux so reads REBOX) may
    // unbox pointer params.
    // control: the same read shape WITHOUT the async runtime — correct.
    is(jz(`
        let dyn = (o, k) => o[k]
        let read = (w) => w['@@iterator'] != null && typeof w['@@iterator'] === 'function' ? w['@@iterator']() : 'missing'
        export let f = () => {
          let callCount = 0
          let obj = { [Symbol.iterator]() { callCount++; return 42 } }
          let r = read(obj)
          return '' + r + '|' + callCount
        }`, { jzify: true }).exports.f(), '42|1')
    // broken: identical read via the async runtime's __p_list (GetIterator).
    const code = `
        let st0 = '@pending'
        let done = (m) => { st0 = m }
        export let check = () => st0
        let callCount = 0
        let obj = { [Symbol.iterator]() { callCount++; return false } }
        let go = () => { Promise.any(obj).then(() => done('resolved'), (e) => done('cc=' + callCount)) }
        export let _run = () => { go(); return 1 }`
    const inst = jz(code, { jzify: true })
    inst.exports._run()
    let st = inst.exports.check()
    for (let i = 0; i < 100 && st === '@pending'; i++) st = inst.exports.check()
    is(st, 'cc=1')  // was cc=0 before the fix (@@iterator never called)

    // jzify runtime-splice quiescence: ASYNC_RUNTIME's own transform wraps
    // `__p_try`'s `fn(...aa)` in `__it_drain` AFTER the linear splice chain
    // already checked the drain flag — the reference was left a FREE NAME and
    // emitted `local.get $__it_drain` (undeclared local, zero-init garbage →
    // call_indirect table[0]; masked because the path was dead here). The
    // splice loop now re-checks to quiescence: every referenced runtime helper
    // must be DEFINED in the module, not merely referenced. `__p_try` is
    // `Promise.try`'s helper, so the program must use it for the helper to be
    // reachable at all: analysis and emission follow ProgramIndex
    // reachability, and a dead runtime helper leaves no trace at any tier.
    const codeTry = code.replace('go(); return 1', 'go(); Promise.try(() => 0); return 1')
    const wat0 = compile(codeTry, { jzify: true, wat: true, optimize: 0 })
    ok(wat0.includes('(func $__it_drain'), 'async-runtime-introduced drain helper is spliced at O0 (defined, not a free name)')
    ok(!wat0.includes('local.get $__it_drain'), 'no free-name drain reference at O0')
    const watS = compile(code, { jzify: true, wat: true })
    ok(!watS.includes('local.get $__it_drain'), 'no free-name drain reference survives at the default tier (inline/treeshake of the DEFINED helper is fine)')
})

test('pointer-ABI params: body-reassigned params stay boxed (reassigned-param kind bug)', () => {
    // Was the last recorded dyn-read residue — FIXED 2026-07-13. Root: the
    // pointer-param ABI passes (applyPointerParamAbi / applyTypedPointerParamAbi)
    // narrowed params to unboxed i32 offsets WITHOUT the body-write guard the
    // wasm-type narrowing applies — a body reassignment (`v = v['@@iterator']()`)
    // then stored a boxed f64 into the i32 local: mixed views, wasm validation
    // failure ("i64.reinterpret_f64[0] expected type f64"). Both passes now
    // skip body-mutated params, so the natural param-reassign drain idiom works.
    const src = `
        let mk = () => ({ next: () => ({ value: 7, done: true }) })
        let drain = (v) => {
          if (typeof v === 'object' && v['@@iterator'] != null) v = v['@@iterator']()
          if (typeof v !== 'object' || v.next == null) return 'no-next'
          return v.next().value
        }
        export let f = () => {
          let o = { [Symbol.iterator]() { return mk() } }
          return drain(o)
        }`
    is(jz(src, { jzify: true }).exports.f(), 7)
    // typed-array leg: reassigned typed param keeps the boxed lane too
    const src2 = `
        let scale = (a) => { if (a.length === 0) a = new Float64Array(1); return a[0] * 2 }
        export let f = () => { let t = new Float64Array([21]); return scale(t) }`
    for (const optimize of [false, true]) is(jz(src2, { optimize }).exports.f(), 42)
})

// ── test262 negative-parse residual closures (fix/parser-residuals) ────────
// Each rejects() pins a family the accepted-negative ledger (test262-neg-
// accepts.json) used to carry; each is paired with a positive twin proving
// the nearby VALID construct still compiles — the exact-set ledger's own
// guard against a rule that's merely narrow instead of sound.

test('using declaration: var/using name conflict at the same scope (using-declaration-context)', () => {
    // `using` is lexically scoped like let/const — declaration() previously
    // didn't recognize the tag at all, so validateScopeNames' var/lexical
    // conflict scan never saw a using-bound name.
    rejects(`export let f = () => { { using x = null; var x; return x } }`, 'conflicts with var')
    is(jz('export let f = () => { using x = null; return 1 }').exports.f(), 1)
    is(jz('export let f = () => { using x = null, y = null; return 1 }').exports.f(), 1)
})

test('for-of: unparenthesized comma expression as the iterated source (other-jessie-context-loss)', () => {
    // for-of's source is an AssignmentExpression (no bare `,`); for-in's is a
    // full Expression, where a top-level comma is legal — the two must not
    // share one check.
    rejects('export let f = () => { for (const x of [1], [2]) return x }', 'comma expression')
    rejects('export let f = () => { let x; for (x of [1], [2]) return x }', 'comma expression')
    rejects('export let f = () => { for (var x of [1], [2]) return x }', 'comma expression')
    is(jz('export let f = () => { let s = 0; for (const x of ([1,2], [3,4])) s += x; return s }').exports.f(), 7)
    is(jz('export let f = () => { let s = 0; for (const x of [3,4]) s += x; for (const y in {a:1,b:2}) s += 1; return s }').exports.f(), 9)
})

test('sole-statement position excludes Declaration, except a safe let-ASI escape hatch (asi-and-line-terminator-context)', () => {
    // if/while/do/for bodies and label targets fill Statement, which excludes
    // Declaration outright — `const`/`class` have no other parse (both are
    // unconditionally reserved words), but bare `let` is a valid sloppy
    // IdentifierReference, so `let` followed by a genuine LineTerminator can
    // ASI-split into a reference statement plus a separate one — EXCEPT
    // `let [`, which ExpressionStatement's own grammar excludes
    // unconditionally (no "[no LineTerminator here]" on it), so it has no
    // fallback parse regardless of what follows.
    rejects('export let f = () => { if (true) let\n[x] = 0; return 1 }', 'block in statement position')
    rejects('export let f = () => { while (false) let\n[x] = 0; return 1 }', 'block in statement position')
    rejects('let g = () => { do\n  let\n  [x] = 0\nwhile (false) }', 'block in statement position')
    rejects('export let f = () => { for (;false;) let\n[x] = 0; return 1 }', 'block in statement position')
    rejects('export let f = () => { if (true) const x = 1; return 1 }', 'block in statement position')
    rejects('export let f = () => { if (true) class C {}; return 1 }', 'block in statement position')
    // valid neighbours: braced declarations, and the let-as-bare-identifier
    // ASI escape hatch (jz's own parser folds these into one 'let' AST node
    // spanning the newline rather than truly ASI-splitting them, so this
    // pins "must stay accepted", not "parses with let-as-identifier semantics").
    is(jz('export let f = () => { if (true) { let x = 1; return x } return 0 }').exports.f(), 1)
})

test('object literal item shape: allowlist, not a blocklist (other-jessie-context-loss)', () => {
    // A bare object-literal item is only ever key:value/method, spread, or a
    // getter/setter (rejected downstream by prepare/index.js with its own
    // message) — any other node shape has no valid meaning here.
    rejects('export let f = () => { let o = {[0]}; return 1 }', 'shorthand/initialized')
    rejects('export let f = () => { let x = 1; for (x in {y;}) return x; return 0 }', 'shorthand/initialized')
    // import/export specifier lists reuse the same '{}' tag with an `as`
    // rename shape that must NOT be run through the object-literal check.
    is(jz("import { a as b } from './m.js'\nexport let f = () => b", {
      modules: { './m.js': 'export let a = 42' } }).exports.f(), 42)
    is(jz('export let f = () => { let x = 5; return { x, y: 2 }.x + { x, y: 2 }.y }').exports.f(), 7)
})

test('computed member-access target inside a destructuring pattern validates its key (destructuring-cover-grammar)', () => {
    // `receiver[key]` (arity 3) shares the raw '[]' tag with a single-element
    // array pattern (arity 2) — patternItems must not conflate them (an
    // earlier attempt infinite-looped: unwrapping an arity-3 node returned
    // itself as its own "one item"). Once correctly treated as a leaf, the
    // key sits in full expression position and gets its one provable
    // restriction: bare `yield` can't be an identifier reference in strict
    // code outside a real generator.
    rejects("'use strict'; export let f = () => { let x = {}; [x[yield]] = [1]; return 1 }", 'identifier reference')
    rejects("'use strict'; export let f = () => { let x = {}; for ([x[yield]] in [[]]) return 1; return 0 }", 'identifier reference')
    // valid neighbours: plain computed-member destructuring targets, and a
    // real yield-expression key inside an actual generator (never ambiguous
    // with an identifier reference there, so it must stay accepted — parses
    // clean here; running it is generators.js/destruct.js's job, not this
    // early-error pin's).
    ok(compile('export let f = () => { let s = new Float64Array(4); [s[1]] = [4]; return s[1] }') instanceof Uint8Array,
      'a plain computed-member destructuring target still compiles (parses clean; codegen for this exact combination is a separate, pre-existing concern outside this early-error pin)')
    is(jz('export let f = () => { let a, b; [a, b] = [1, 2]; return a * 10 + b }').exports.f(), 12)
    // jzify's generator lowering doesn't yet reach yield inside an
    // assignment RHS ('yield inside `=` is not supported yet', a separate
    // pre-existing limitation) — parse() is the layer this fix touches, so
    // pin at that layer rather than through the full compile() pipeline.
    ok(Array.isArray(parse("'use strict'; function* g() { let x = {}; [x[yield]] = [1] }")),
      'a real yield-expression key inside a generator is not an identifier-reference violation')
})

test('anonymous function expression cannot lead a statement or export default (other-jessie-context-loss / module-goal-and-export-context)', () => {
    // ExpressionStatement's grammar excludes a leading `function` token by
    // lookahead — `function(){}()`/`function(){}.m()` at statement start can
    // ONLY be FunctionDeclaration, which requires a name; an anonymous one
    // has no fallback to the AssignmentExpression reading regardless of what
    // a call/member/tag chain does with the result afterward. export
    // default's own AssignmentExpression alternative carries the identical
    // lookahead exclusion.
    rejects('function(){}();', 'statement')
    rejects('function(){}.call();', 'statement')
    rejects('export default function() {}();', 'statement')
    rejects('export default function* () {}();', 'statement')
    // valid neighbours: parenthesizing escapes the lookahead entirely, and a
    // NAMED function has a legal FunctionDeclaration parse even though
    // jessie's own AST merges it with the following chain regardless
    // (confirmed live) — so only the anonymous case is rejected.
    is(jz('export let f = () => (function(){ return 5 })()').exports.f(), 5)
    ok(compile('function fn() {}[];') instanceof Uint8Array, 'a named function followed by a chain keeps its pre-existing (if odd) parse')
})

test('a bare `*` class-body element is never valid (class-element-token-boundaries)', () => {
    // A generator-method/constructor's `*` marker is only ever valid
    // attached to a following name in the SAME class element; jessie's
    // class-body parser instead splits `* constructor(){}`/`static *
    // prototype(){}` into a spurious bare-`*` (optionally `static`-prefixed)
    // element plus an unmarked method, losing the '*' attachment — no valid
    // PropertyName spells as a bare `*`, so this shape is always invalid,
    // regardless of the (also-lost) 'static'/generator-ness it obscures.
    rejects('class C {\n  * constructor() {}\n}', 'class body')
    rejects('class C {\n  static * prototype() {}\n}', 'class body')
    // real generator/static-generator methods (name unrelated to '*'/
    // 'constructor'/'prototype') still compile — generator *runtime*
    // semantics (the method returns an iterator, not a synchronous result)
    // are generators.js's concern, not this early-error pin's.
    ok(compile('class C {\n  *m() {}\n}') instanceof Uint8Array)
    ok(compile('class C {\n  static *m() {}\n}') instanceof Uint8Array)
})

test('arrow function: no line terminator between ArrowParameters and => (asi-and-line-terminator-context)', () => {
    // ArrowFunction's own grammar carries a "[no LineTerminator here]"
    // between ArrowParameters and `=>` with no ASI fallback (nothing valid
    // can follow a bare ArrowParameters list as a separate statement) —
    // jessie does not enforce it at all.
    rejects('var af = x\n=> x;', 'arrow function')
    rejects('var af = ()\n=> {};', 'arrow function')
    rejects('var af = (x, y)\n=> x + y;', 'arrow function')
    is(jz('export let f = (x) => x + 1').exports.f(1), 2)
    is(jz('export let f = () =>\n  1 + 1').exports.f(), 2)
    is(jz('export let f = (\n  x,\n  y\n) => x + y').exports.f(1, 2), 3)
})

test("a GeneratorDeclaration's own name inherits the ENCLOSING scope's generator-ness, not its own (async-generator-and-parameter-context)", () => {
    // GeneratorExpression's BindingIdentifier is parameterized [+Yield]
    // unconditionally (its own generator-ness); GeneratorDeclaration's
    // instead inherits the enclosing scope's [Yield] — `function*
    // yield(){}` as a plain top-level declaration is fine outside a
    // generator (matches test262's own positive corpus), forbidden nested
    // inside one, while the expression form is always forbidden.
    rejects('var g = function* yield() {};', 'bound')
    rejects('function* outer() { function* yield(){} }', 'bound')
    is(jz('function* yield() { return 1 }\nexport let f = () => 1').exports.f(), 1)
    is(jz('function outer() { function* yield(){ return 1 } return 1 }\nexport let f = () => outer()').exports.f(), 1)
})

test('escaped reserved word cannot be a bare identifier reference used as a whole statement (other-jessie-context-loss)', () => {
    // walk()'s per-child loop validates escaped-reserved-word identifiers
    // that are CHILDREN of some parent node, but a lone identifier used as
    // an entire statement (`f\u{61}lse;`) IS the node, not a listed child —
    // that call site the per-child loop covers never sees it. Scoped
    // narrowly to this one unambiguous IdentifierReference position
    // (checkIdentifierRef), not folded into walk()'s general dispatch,
    // which also reaches property names and import/export specifier
    // externals through the same bare-string shape.
    // (A for-in/of target — `for (let in o)` in strict mode — is the exact
    // same kind of gap and checkIdentifierRef closes it natively too, but a
    // confirmed self-host-only divergence there (the self-compiled kernel
    // accepts it regardless) means that specific wiring stays reverted —
    // see early-errors.js's own NOTE at the for-in/of head handler.)
    rejects('export let f = () => { f\\u{61}lse; return 1 }', 'escaped reserved word')
    rejects('export let f = () => { tru\\u{65}; return 1 }', 'escaped reserved word')
    rejects('export let f = () => { n\\u{75}ll; return 1 }', 'escaped reserved word')
    is(jz('export let f = () => { let x = 5; x; return x }').exports.f(), 5)
    is(jz('export let f = () => { let o = { a: 1 }; for (let in o) { } return 1 }').exports.f(), 1)
})

test('lexical-risk pre-filter reaches unterminated comments, dot-adjacent separators, and raw newlines in quotes (other-jessie-context-loss / nested-strict-legacy-escape)', () => {
    // Three independent gaps in sourceHasLexicalRisk's fast pre-filter, each
    // starving validateLexicalSource's (already-correct) scanner of a
    // reason to run: an unterminated block comment anywhere in the source
    // (`src.includes('/*')`); a numeric separator directly after the
    // decimal point (`10._1` — the existing digit-before-underscore pattern
    // never anchors on a DOT before the underscore); and a raw LineTerminator
    // inside a single/double-quoted string (hasNewlineInQuote, a tight
    // quote-tracking scan — anchoring only on "quote+newline+quote" would
    // false-positive on any file with 2+ same-line-separated strings).
    // (a trailing unterminated comment at true top level — nested inside an
    // unclosed brace, subscript's own bracket matcher reports first instead)
    rejects('export let f = () => 1;\n/*unterminated', 'unterminated block comment')
    rejects('export let f = () => 10._1', 'separator')
    rejects('export let f = () => 10._', 'separator')
    rejects('export let f = () => "\n"', 'line terminator')
    is(jz('export let f = () => { /* fine */ return 1 }').exports.f(), 1)
    is(jz('export let f = () => 10.5').exports.f(), 10.5)
    is(jz('export let f = () => { let o = { _private: 1 }; return o._private }').exports.f(), 1)
    is(jz('export let f = () => "a" + "b"').exports.f(), 'ab')
})

test('yield/await as a binding name admits no trailing operand (nested-strict-legacy-escape sibling / async-generator-and-parameter-context)', () => {
    // `let yield;`/`let await;` tokenize with a null operand (a bare binding
    // name); a real trailing expression (`let\nawait 0;`) means the source
    // held a unary yield/await-EXPRESSION, which is never a valid pattern —
    // validatePatternTree's yield/await arm only ever checked the binding-
    // name legality, never whether a second token had actually arrived.
    rejects('function f() {\n  let\n  yield 0\n}', 'binding position')
    rejects('function f() {\n  let\n  await 0\n}', 'binding position')
    is(jz('export let f = () => { let yield; return 5 }').exports.f(), 5)
    is(jz('export let f = () => { let await; return 6 }').exports.f(), 6)
})

test('expression-only grammar slots retain their statement/list context (destructuring-cover-grammar / asi / other-jessie-context-loss)', () => {
    // Jessie reuses the same nodes for parenthesized statement lists and
    // expressions, array elisions and argument lists, and object literals and
    // statement-leading blocks. The surrounding grammar slot disambiguates
    // each pair without rejecting the valid sibling shape.
    rejects('f(1,,2)', 'arguments')
    rejects('if (false) f(,1)', 'arguments')
    rejects('(debugger)', 'statement')
    rejects('if (false) (debugger)', 'statement')
    rejects('({};) * 1', 'parenthesized expression')
    rejects('{} * 1', 'block statement')
    rejects('{} = 1', 'block statement')
    rejects('() => {} = 1', 'arrow function block')
    rejects('let f = () => {} * 1', 'arrow function block')

    is(jz('export let f = () => { let g = (a) => a; return g(7,) }').exports.f(), 7)
    is(jz('export let f = () => [1,,3].length').exports.f(), 3)
    is(jz('debugger; export let f = () => 1').exports.f(), 1)
    is(jz('export let f = () => ({ a: 4 }).a').exports.f(), 4)
    ok(Array.isArray(parse('({} = o)')), 'a parenthesized object assignment remains syntactically valid')
    ok(Array.isArray(parse('{} + 1')), 'a block may be followed by a unary-plus sibling without a semicolon')
    ok(Array.isArray(parse('{}\n[1]')), 'a block may be followed by an array-expression sibling across ASI')
    ok(Array.isArray(parse('for (let i = 0; i < 1; i++) { ; }')), 'semicolons remain valid in control parens and blocks')
})

test('for headers keep classic clauses separate from for-in/of heads (asi-and-line-terminator-context / other-jessie-context-loss)', () => {
    // Newlines never replace either of a classic for header's two semicolons.
    // Conversely, top-level in/of commits to the iteration grammar and cannot
    // coexist with classic clauses. Header slots are expressions/declarations,
    // not blocks or a StatementList.
    rejects('for () {}', 'semicolons')
    rejects('for (false\n;\n) {}', 'semicolons')
    rejects('for (false\nfalse\nfalse) {}', 'semicolons')
    rejects('export let f = () => { for (let x = 3 in {}) {} }', 'uninitialized binding')
    rejects('export let f = () => { for (let x, y = 4 in {}) {} }', 'uninitialized binding')
    rejects("'use strict'; let o = {}; for (let in o) {}", 'strict mode')
    rejects('for (true ? 0 : 0 in {}; false; ) ;', 'classic for initializer')
    rejects('export let f = () => { for (let i = 0; i < 1; { i++; }) {} }', 'object literal')
    rejects('export let f = () => { for ({ let i = 0; } i < 1; i++) {} }', 'object literal')

    is(jz('export let f = () => { let n = 0; for (let i = 0; i < 4; i++) n += i; return n }').exports.f(), 6)
    is(jz('export let f = () => { let n = 0; for (;;) { n++; break } return n }').exports.f(), 1)
    is(jz('export let f = () => { let o = { a: 1 }; for (let in o) { } return 1 }').exports.f(), 1)
    is(jz('export let f = () => { let n = 0; for (const x of [2,3]) n += x; return n }').exports.f(), 5)
    ok(Array.isArray(parse("for (let seen = ('x' in {x:1}); !seen; ) {}")),
      'parenthesized in remains a valid classic-for initializer')
    ok(Array.isArray(parse('for (let of = 0; of < 1; of++) {}')),
      "the contextual word 'of' remains a valid classic-for binding")
    ok(Array.isArray(parse('for (let of of [1]) {}')),
      "a binding named 'of' is distinct from the following for-of keyword")
    ok(Array.isArray(parse("'use strict'; let x, o = {}; for (x in o) {}")),
      'strict for-in remains valid with an ordinary assignment target')
})

test('restricted statement boundaries honor ASI and every line terminator (asi-and-line-terminator-context)', () => {
    rejects('export let f = () => { let x = 0; if (false) { x\n++ } return x }', 'without an operand')
    rejects('let x = 0; x\n--', 'without an operand')
    rejects('let x = 0; x /*\n*/ ++;', 'without an operand')
    rejects('do {};\nwhile (false)', 'between a do body and while')
    rejects('//\rthis text is not one expression', 'this')

    is(jz('export let f = () => { let x = 0; x++; return x }').exports.f(), 1)
    is(jz('export let f = () => { let x = 0; do { x++ } while (x < 1); return x }').exports.f(), 1)
    is(jz('// lone CR ends this comment\rexport let f = () => 7').exports.f(), 7)
    is(jz('export let f = () => "a\\\rb"').exports.f(), 'ab')
    ok(Array.isArray(parse('let x = 0, y = 0; x\n++y;')),
      'a newline before ++ remains valid when the prefix-update fallback has an operand')
    ok(Array.isArray(parse('do { { } }\nwhile (false)')),
      'a do block is followed directly by while, including nested sibling blocks')
})

test('adjacent string literals require a real statement boundary (other-jessie-context-loss)', () => {
    rejects("0;\nvar s = '''';", 'adjacent string literals')
    rejects('0;\nvar s = """";', 'adjacent string literals')
    rejects("if (false) { let s = ''/*same line*/''; }")

    is(jz("export let f = () => ''").exports.f(), '')
    is(jz("export let f = () => 'a' + 'b'").exports.f(), 'ab')
    is(jz("export let f = () => ['a', 'b'].join('')").exports.f(), 'ab')
    ok(Array.isArray(parse("'a'\n'b'")), 'a LineTerminator can ASI-split sibling string ExpressionStatements')
    ok(Array.isArray(parse("{ 'a'; } { 'b'; }")), 'sibling block scopes keep independent string statements')
})

test('async contextual keywords retain arrow/method line boundaries (async-generator-and-parameter-context / other-jessie-context-loss)', () => {
    rejects('async\n(x) => x', 'async')
    rejects('if (false) { let f = async /*\n*/ () => 1 }', 'async')
    rejects('\\u0061sync () => {}', 'arrow parameters')
    rejects('({ async\nmethod() {} })', 'object method')

    ok(compile('export let f = async (x) => x + 1') instanceof Uint8Array,
      'same-line async arrow parameters still compile')
    ok(compile('export let f = async /* no newline */ (x) => x') instanceof Uint8Array,
      'a same-line comment does not violate the async boundary')
    ok(Array.isArray(parse('({ async method() {} })')), 'same-line async object methods remain syntactically valid')
    ok(Array.isArray(parse('class C { async\nmethod() {} }')),
      'a class field named async may ASI-split from an ordinary method')
    ok(Array.isArray(parse('{}() => 1')),
      'a leading block and following zero-param arrow remain separate valid statements')
})

test('class element modifiers and field boundaries survive jessie splitting (class-element-token-boundaries)', () => {
    rejects('class C {\n static async m() { var await; }\n}', 'await')
    rejects('class C {\n static async #m() { var \\u0061wait; }\n}', 'await')
    rejects('class C {\n static async prototype() {}\n}', 'prototype')
    rejects('class C {\n field method() {}\n}', 'same line')
    rejects('class C {\n field = 1 /* no ASI */ method() {}\n}', 'same line')
    rejects('class C {\n x y\n}', 'same line')
    rejects('class C {\n #x #y\n}', 'same line')
    rejects('class C {\n \\u0061sync method() {}\n}', 'same line')
    rejects('class C {\n st\\u0061tic method() {}\n}', 'same line')

    ok(Array.isArray(parse('class C {\n field\n method() {}\n}')),
      'a LineTerminator separates a field from a method')
    ok(Array.isArray(parse('class C {\n field = 1; method() {}\n}')),
      'an explicit semicolon separates an initialized field')
    ok(Array.isArray(parse('class C {\n x\n #y\n}')),
      'bare public/private fields ASI-split across lines')
    ok(Array.isArray(parse('class C {\n static async m() { var x; }\n}')),
      'a real static async method with a legal body remains valid')
    ok(Array.isArray(parse('class C {\n static async\n prototype() {}\n}')),
      'a newline after async makes it a static field plus ordinary method')
    ok(Array.isArray(parse('class C {\n *g() {} static *h() {} get x() {} set x(v) {}\n}')),
      'generator/static/accessor method prefixes retain their own boundaries')
    ok(Array.isArray(parse('class A { x } class B { y }')),
      'sibling class scopes do not share field-boundary state')
})

test('rest trailing commas depend on assignment-pattern context (destructuring-cover-grammar)', () => {
    rejects('0, [...x,] = []', 'trailing comma')
    rejects('0, {...x,} = {}', 'trailing comma')
    rejects('for ([...x,] in [[]]) ;', 'trailing comma')
    rejects('for ([...x,] of [[]]) ;', 'trailing comma')
    rejects('export let f = () => { if (false) { 0, [...x,] = [] } return 1 }', 'trailing comma')

    ok(Array.isArray(parse('0, [...x] = []')), 'assignment rest without a trailing comma remains valid')
    ok(Array.isArray(parse('for ([...x] of [[]]) ;')), 'for-of assignment rest without the comma remains valid')
    ok(Array.isArray(parse('let a = [...x,]')), 'array-literal spread still permits a trailing comma')
    ok(Array.isArray(parse('let o = {...x,}')), 'object-literal spread still permits a trailing comma')
    ok(Array.isArray(parse('{ 0, [...x] = []; } { let y = [...x,]; }')),
      'sibling block scopes keep pattern and literal contexts independent')
})

test('semicolon-sensitive export forms cannot absorb a same-line literal sibling (module-goal-and-export-context)', () => {
    rejects('0;\nexport default null null;', 'export declaration')
    rejects("0;\nexport * from 'x' null;", 'export declaration')
    rejects("0;\nexport * as ns from 'x' null;", 'export declaration')
    rejects("0;\nexport {} from 'x' null;", 'export declaration')
    rejects('0;\nexport {} null;', 'export declaration')

    ok(Array.isArray(parse('export default null; null;')), 'an explicit semicolon separates export-default expression')
    ok(Array.isArray(parse('export default null\nnull;')), 'a LineTerminator supplies export-default ASI')
    ok(Array.isArray(parse("export * from 'x'; null;")), 'export-from accepts an explicit boundary')
    ok(Array.isArray(parse('export {}\nnull;')), 'a named export accepts a newline boundary')
    ok(Array.isArray(parse('export default function() {} 0;')),
      'exported function declarations need no separator before a sibling statement')
    ok(Array.isArray(parse('export default class {} 0;')),
      'exported class declarations keep their declaration boundary')
})

test('an own strict directive validates every raw string in its Directive Prologue (nested-strict-legacy-escape)', () => {
    rejects('function f() { "\\1"; "use strict"; }', 'legacy escape')
    rejects('(function() { "\\052"; "use strict"; });', 'legacy escape')
    rejects('function f() { "use strict"; "\\8"; }', 'legacy escape')
    rejects('function outer() { function inner() { "\\9"; "use strict"; } }', 'legacy escape')

    ok(Array.isArray(parse('function f() { "\\1"; }')), 'the same legacy escape remains legal in a sloppy function')
    ok(Array.isArray(parse('if (true) { "\\1"; "use strict"; }')),
      'a string in an ordinary block is not a directive')
    ok(Array.isArray(parse('function a() { "\\1"; } function b() { "ok"; "use strict"; }')),
      'a strict sibling does not retroactively make a sloppy sibling strict')
    ok(Array.isArray(parse('function f() { "plain"; "use strict"; }')),
      'an escape-free directive prologue remains valid')
})

test('explicit sourceType preserves Script and Module parse-goal early errors', () => {
    const rejectsGoal = (src, sourceType, match) => {
      let error
      try { compile(src, { sourceType }) } catch (e) { error = e }
      ok(error, `${sourceType} goal should reject: ${src}`)
      ok(error.message.includes(match), `error should mention '${match}': ${error && error.message}`)
    }

    rejectsGoal('export default null', 'script', 'sourceType: module')
    rejectsGoal('var f; function f() {}', 'module', 'module top level')
    rejectsGoal('var await;', 'module', 'await')
    rejectsGoal('class await {}', 'module', 'await')
    ok(compile('export let f = () => 1', { sourceType: 'jz' }) instanceof Uint8Array,
      'the default jz export-as-ABI goal remains available explicitly')
    ok(compile('let x = 1', { sourceType: 'script' }) instanceof Uint8Array,
      'ordinary Script source remains valid')
})

test('else boundaries distinguish ASI, empty statements, and IdentifierName properties', () => {
    rejects('if (false) x = 1 else x = -1', 'before else')
    rejects('if (false) {}; else {}', 'between an if consequent and else')

    ok(Array.isArray(parse('if (false) x = 1; else x = -1')), 'an explicit terminator before else remains valid')
    ok(Array.isArray(parse('if (false) x = 1\nelse x = -1')), 'a LineTerminator may supply ASI')
    ok(Array.isArray(parse('if (false) {} else {}')), 'a block consequent needs no semicolon')
    ok(Array.isArray(parse('if (x) if (y) a(); else b();')), 'dangling else still binds to the nearest if')
    ok(Array.isArray(parse('let o = { else: 1, else() {} }; o.else')), '`else` remains an IdentifierName in properties')
    ok(Array.isArray(parse('class C { get else() { return 1 } set else(v) {} }')),
      '`else` remains an IdentifierName in class methods')
})
