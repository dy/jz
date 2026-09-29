// A module name that holds one regular expression for good is that expression
// where a method of it is called (src/compile/plan/scope.js holdModuleRegexes).
// jz compiles a regular expression where its literal is known; a library hands
// its patterns on through a function that returns the literal, a name, and a
// member of the function (stdlib's regexp/function-name, read by
// utils/constructor-name). Every form answers what the host answers.
import test from 'tst'
import { is, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { levels } from './_matrix.js'
import { oracle } from './util.js'

const WORDS = ['function abc(x) {}', '  function  named () {}', 'FUNCTION Up() {}', 'nope', '', 'function (x) {}']
// [source]: `f( s )` answers the first group, or what the program makes of a miss
const programs = {
  'a function that returns the literal': `function reName() { return /^\\s*function\\s*([^(]*)/i }
    var RE = reName()
    export let f = (s) => { const m = RE.exec(s); return m ? m[1] : 'none' }`,
  'through a second name': `function reName() { return /^\\s*function\\s*([^(]*)/i }
    var RE_NAME = reName()
    var RE = RE_NAME
    export let f = (s) => { const m = RE.exec(s); return m ? m[1] : 'none' }`,
  'through a member of the function': `function reName() { return /^\\s*function\\s*([^(]*)/i }
    var RE_NAME = reName()
    reName.REGEXP = RE_NAME
    var RE = reName.REGEXP
    export let f = (s) => { const m = RE.exec(s); return m ? m[1] : 'none' }`,
  'an arrow that is the literal': `const reName = () => /^\\s*function\\s*([^(]*)/i
    const RE = reName()
    export let f = (s) => RE.test(s) ? 'yes' : 'no'`,
  'a pattern with a cursor, through names': `var RE_G = /o/g
    var RE = RE_G
    export let f = (s) => { RE.lastIndex = 0; let n = 0; while (RE.exec(s)) n++; return 'n' + n }`,
}
const library = {
  './main.js': 'function reFunctionName() {\n\treturn /^\\s*function\\s*([^(]*)/i;\n}\nexport default reFunctionName;',
  './regexp.js': "import reFunctionName from './main.js'\nvar RE_FUNCTION_NAME = reFunctionName();\nexport default RE_FUNCTION_NAME;",
  './index.js': "import main from './main.js'\nimport REGEXP from './regexp.js'\nmain.REGEXP = (REGEXP );\nexport default main;",
  './ctor.js': "import __r0 from './index.js'\nvar RE = __r0.REGEXP;\nfunction name(s) { var match = RE.exec(s); if (match) { return match[1] } return 'none' }\nexport default name",
}

test('held regex: a name that holds a regular expression runs it', () => {
  for (const [name, src] of Object.entries(programs)) {
    const host = oracle(src)
    for (const optimize of levels(0, 2, 3)) {
      const m = jz(src, { optimize }).exports
      for (const w of WORDS) is(m.f(w), host.f(w), `${name} at ${optimize}: f(${JSON.stringify(w)})`)
    }
  }
})

test('held regex: across the modules of a library', () => {
  const src = "import name from './ctor.js'\nexport let f = (s) => name(s)"
  const want = WORDS.map(w => { const m = /^\s*function\s*([^(]*)/i.exec(w); return m ? m[1] : 'none' })
  for (const optimize of levels(0, 2, 3)) {
    const m = jz(src, { modules: library, optimize }).exports
    WORDS.forEach((w, i) => is(m.f(w), want[i], `at ${optimize}: f(${JSON.stringify(w)})`))
  }
})

test('held regex: a name that may hold another, or a cursor a call makes anew, is not held', () => {
  const open = {
    // it ran the pattern registered last, whatever the name held
    'a second store, in a function': 'function reName() { return /a/ }\nvar RE = reName()\nexport let set = () => { RE = /b/ }\nexport let f = (s) => RE.test(s)',
    'a second literal, in a function': 'var RE = /a/\nexport let set = () => { RE = /b/ }\nexport let f = (s) => RE.test(s)',
    'a second literal, in an arm': 'export let f = (s, c) => { let r = /a/; if (c) r = /b/; return r.test(s) }',
    'a store in an arm': 'function reName() { return /a/ }\nvar RE\nif (reName) RE = reName()\nexport let f = (s) => RE.test(s)',
    'a function of a parameter': 'function reName(i) { return i ? /a/ : /b/ }\nvar RE = reName(1)\nexport let f = (s) => RE.test(s)',
    'a pattern with a cursor a function returns': 'function reName() { return /a/g }\nvar RE = reName()\nexport let f = (s) => RE.test(s)',
  }
  for (const [name, src] of Object.entries(open)) throws(() => compile(src), /regex|literal/, name)
  // the same literal stored again is the expression the name held
  const same = 'export let f = (s, c) => { let r = /a/i; if (c) r = /a/i; return r.test(s) }'
  for (const optimize of levels(0, 2, 3)) is(jz(same, { optimize }).exports.f('A', 1), true, `the same literal twice at ${optimize}`)
})
