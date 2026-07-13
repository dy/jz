import test from 'tst'
import jz, { compile } from '../index.js'
import { is, ok } from 'tst/assert.js'
import { isDestructurePat } from '../jzify/hoist-vars.js'

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

test('always-reserved `const` rejected as a binding name (PARSE-6)', () => {
    rejects('export let f = () => { let const = 5; return const }', 'reserved')
    // `let` is only *strict-mode* reserved — a valid identifier in sloppy JS, so jz
    // must accept it (test262 let-non-strict-*); only the always-reserved `const` is rejected.
    is(jz('export let f = () => { let let = 5; return let }').exports.f(), 5)
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
// six latent jz miscompiles when the kernel self-hosted it. Each pin below is
// the ddmin-reduced shape; the kernel build (test/selfhost.js) is the
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

// ── jzify pre-prepare '[]'-tag ambiguity (self-host typed-elem-compare hunt) ──
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
    // misclassification natively. The self-hosted kernel exercises the (wrong)
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
// SELF-HOSTED kernel, at every self-host build level (0/1/2) and every runtime optimize
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
    // clean A/B) — a separate, deeper, PRE-EXISTING self-host bug in the level-2 inliner's
    // interaction with the boundary i64-carrier wrapper for a 2nd exported param, not this
    // session's fix or regression. Left OPEN — tracked in .work/todo.md (self-host groundtruth archive).
    // charter repro: minimally reduced from bench/mat4 + bench/_lib/benchlib.js's `medianUs`/
    // `printResult` pair — a same-named PARAMETER elsewhere in the program (`printResult`'s
    // `medianUs` param, used in a template literal) marks the top-level `medianUs` function
    // valueUsed (scope-blind name match — a separate, harmless pessimization, not this bug),
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

test('KNOWN GAP: loop-minted closure in a writer fn breaks captured-object prop visibility', () => {
    // Surfaced building the async runtime (2026-07-12). A fn that (a) writes
    // props through an object param AND (b) mints a closure INSIDE a for-loop
    // body capturing the body-let — makes prop READS through the factory's
    // OTHER closures see stale values. One delta: inline the write (or call
    // the loop's closures directly) and it heals. The async runtime dodges it
    // (settled-queue + direct-call drain); fix belongs in the closure-env /
    // schema aliasing analysis. Pinned to CURRENT (wrong) behavior — flips
    // loudly when fixed.
    const src = (settleBody) => `
        let mt = []
        let mk = () => { let p = { st: 0, val: undefined, cbs: [], then: undefined }; p.then = (ok) => { let q = mk(); if (p.st > 0) { let v = p.val; mt.push(() => { q.st = 1; q.val = ok(v) }) } else p.cbs.push((v) => { q.st = 1; q.val = ok(v) }); return q }; return p }
        let settle = (p, v) => { ${settleBody} }
        let g = () => { let p = mk(); settle(p, 4); return p }
        export let f = () => { let q = g().then((v) => v + 1); while (mt.length > 0) { let cb = mt.shift(); cb() } return q.val }`
    // control: no loop-minted closure — correct
    is(jz(src('p.st = 1; p.val = v')).exports.f(), 5)
    // the gap: identical flow + a (never-entered!) loop minting closures
    const broken = jz(src('p.st = 1; p.val = v; let cbs = p.cbs; for (let i = 0; i < cbs.length; i++) { let cb = cbs[i]; mt.push(() => cb(v)) }')).exports.f()
    is(broken, undefined)  // WRONG — should be 5; flips when the aliasing gap is fixed
})

test('KNOWN GAP: exporting a state-mutating closure breaks sibling closures of the same state', () => {
    // Same session. `export let drain = () => {…mutates module arrays…}` makes
    // reads through OTHER closures of that shared state stale — remove the
    // `export` and it heals. The async runtime exports thin forwarders instead.
    const src = (kw) => `
        let mt = []
        let sq = []
        ${kw} let drain = () => { while (mt.length > 0 || sq.length > 0) { while (mt.length > 0) { let cb = mt.shift(); cb() } if (sq.length > 0) { let p = sq.shift(); let cbs = p.cbs; p.cbs = []; let st = p.st; let v = p.val; for (let i = 0; i < cbs.length; i++) { let cb = cbs[i]; cb(st, v) } } } }
        let mkp = () => { let p = { pp: 1, st: 0, val: undefined, cbs: [], then: undefined }; p.then = (ok) => { let q = mkp(); sub(p, (st, v) => { q.st = 1; q.val = ok(v) }); return q }; return p }
        let sub = (p, h) => { if (p.st > 0) { let st = p.st, v = p.val; mt.push(() => h(st, v)) } else p.cbs.push(h) }
        let settle = (p, st, v) => { if (p.st > 0) return; p.st = st; p.val = v; if (p.cbs.length > 0) sq.push(p) }
        let res = (v) => { let p = mkp(); settle(p, 1, v); return p }
        export let f = () => { let q = res(4).then((v) => v + 1); drain(); return q.val }`
    is(jz(src('')).exports.f(), 5)              // unexported drain — correct
    is(jz(src('export')).exports.f(), undefined) // WRONG — should be 5; flips when fixed
})

test('KNOWN GAP: optimizer round-trip breaks async modules containing an indexed array loop', () => {
    // Minimal pair (2026-07-12, found wiring the async test262 pool): a module
    // with the async promise runtime AND any sibling fn looping `a[i]` over
    // `a.length` — microtask callbacks queued via .then never run after the
    // optimizer pipeline touches the module. O0 is correct; at L1 EACH of the
    // three enabled passes ALONE (fusedRewrite / sortLocalsByUse / treeshake)
    // breaks it — implicating shared infrastructure, not one pass.
    // DIAGNOSIS (2026-07-13): emit-time closure-slot divergence — the same
    // source emits __jz_table size 30 at O0 vs 27 at O1 (3 closures lose
    // their funcref slots) and every static-data offset shifts; a stale index
    // survives somewhere, so queued callbacks dispatch into wrong slots.
    // Async-runtime modules only (a sync closure-queue module holds 3/3).
    // The test262 runner pins asyncDone tests at optimize:false meanwhile.
    const SRC = `let hitFlag = 0
let mark = (e) => { hitFlag = 1 }
export let check = () => hitFlag
let cmp = (a, b, m) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw m }
export let go = () => { (async () => 42)().then((v) => { mark() }, mark); return 1 }`
    const ok = jz(SRC, { optimize: false })
    ok.exports.go()
    is(ok.exports.check(), 1)                    // O0 correct
    const bad = jz(SRC, { optimize: 1 })
    bad.exports.go()
    is(bad.exports.check(), 0)                   // WRONG — flips to 1 when the round-trip bug is fixed
})
