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
