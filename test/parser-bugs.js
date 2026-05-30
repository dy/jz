import test from 'tst'
import jz, { compile } from '../index.js'
import { is, ok } from 'tst/assert.js'

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
