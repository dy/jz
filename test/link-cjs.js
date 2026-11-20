// esbuild's CommonJS modules, linked at compile time (jzify/link-cjs.js). esbuild keeps
// each CommonJS module a function it calls at the module's first require; a class in one
// was a class of closures and a class deriving another module's built its instance from a
// base it could not name: 27 times Node's time on a bundle of two modules, where the same
// classes written as one module take 2 to 3. A module required only as its requirers
// start is linked: its statements the module's own, its exports consts. Every program
// here answers as Node at the levels a leg owns, linked or kept; `kept` names the modules
// the advisory (`module-kept`) must name, and no other.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { levels } from './_matrix.js'
import { oracle, jz, compile as compileWat } from './util.js'

// The helper as esbuild 0.28 writes it, and as it wrote it before its `try`.
const HELPER = `var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
`
const HELPER_PLAIN = `var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
`
const wrap = (name, body, params = 'exports, module') => `var require_${name} = __commonJS({\n  "src/${name}.js"(${params}) {\n    "use strict";\n${body}\n  }\n});\n`
const bundle = (mods, tail, helper = HELPER) => helper + Object.entries(mods).map(([n, b]) => Array.isArray(b) ? wrap(n, b[1], b[0]) : wrap(n, b)).join('') + tail

const SHAPE = `var Shape = class {
      constructor(k) { this.k = k; }
      area() { return 0; }
      twice() { return this.area() * 2 + this.k; }
    };`
const PROGRAMS = {
  'exports.k, taken by a pattern': { mods: {
    shape: `${SHAPE}\n    exports.Shape = Shape;`,
    main: `var { Shape } = require_shape();\n    var Sq = class extends Shape { constructor(s) { super(1); this.s = s; } area() { return this.s * this.s; } };\n    exports.make = (s) => new Sq(s);` },
    tail: `var make = require_main().make;\nexport let t0 = (x) => make(x).twice();` },
  'module.exports = { k }, taken under another name': { mods: {
    shape: `${SHAPE}\n    module.exports = { Shape, unit: 7 };`,
    main: `var { Shape: Base, unit } = require_shape();\n    var Sq = class extends Base { constructor(s) { super(unit); this.s = s; } area() { return this.s * this.s; } };\n    module.exports = { make: (s) => new Sq(s) };` },
    tail: `var { make } = require_main();\nexport let t0 = (x) => make(x).twice();` },
  'module.exports = a class, the whole module its requirer\'s base': { mods: {
    shape: `${SHAPE}\n    module.exports = Shape;`,
    main: `var Shape = require_shape();\n    var Sq = class extends Shape { constructor(s) { super(2); this.s = s; } area() { return this.s * this.s; } };\n    module.exports = Sq;` },
    tail: `var Sq = require_main();\nexport let t0 = (x) => new Sq(x).twice();` },
  'a whole module read by its members': { mods: {
    util: `var base = 10;\n    function add(a, b) { return a + b + base; }\n    var Acc = class _Acc { constructor() { this.n = 0; } static of(n) { const a = new _Acc(); a.n = n; return a; } put(v) { this.n = add(this.n, v); return this; } };\n    exports.add = add;\n    exports.Acc = Acc;`,
    main: `var util = require_util();\n    exports.run = (x) => util.Acc.of(x).put(1).put(2).n + util.add(x, 1);` },
    tail: `var run = require_main().run;\nexport let t0 = (x) => run(x);` },
  'a whole module under a name another body binds for itself': { mods: {
    util: `exports.inc = (a) => a + 1;`,
    main: `var util = 5;\n    exports.k = (util2) => util + util2;\n    exports.j = (util) => util * 2;` },
    tail: `var util = require_util();\nvar { k, j } = require_main();\nexport let t0 = (x) => util.inc(x) * 100 + k(1) * 10 + j(x);` },
  'a member read that the module does not make': { mods: {
    m: `exports.a = 4;` },
    tail: `var m = require_m();\nexport let t0 = (x) => m.a + (m.zz === undefined ? 10 : 0) + x;` },
  'a constructor function and its prototype, a module\'s own': { mods: {
    body: `function Body(x, v) { this.x = x; this.v = v; }\n    Body.prototype.step = function (dt) { this.x += this.v * dt; return this; };\n    Body.prototype.at = function () { return this.x; };\n    exports.Body = Body;`,
    main: `var { Body } = require_body();\n    exports.run = (n) => { const b = new Body(1, 2); for (let i = 0; i < n; i += 1) b.step(0.5); return b.at(); };` },
    tail: `var { run } = require_main();\nexport let t0 = (x) => run(x);` },
  'keys that are no names: the object is the module\'s one value': { mods: {
    m: `module.exports = { 'a-b': 3, 7: 4, c: 5 };` },
    tail: `var m = require_m();\nexport let t0 = (x) => m['a-b'] + m[7] + m.c + x;` },
  'one export picked off the require': { mods: {
    util: `exports.inc = (a) => a + 1;\n    exports.dec = (a) => a - 1;` },
    tail: `var inc = require_util().inc;\nvar dec = require_util().dec;\nexport let t0 = (x) => inc(inc(x)) * 10 + dec(x);` },
  'three modules deep, one required by two': { mods: {
    count: `var n = 0;\n    exports.next = () => { n += 1; return n; };`,
    a: `var { next } = require_count();\n    var first = next();\n    exports.a = () => first * 100 + next();`,
    b: `var { next } = require_count();\n    var first = next();\n    exports.b = () => first * 100 + next();` },
    tail: `var { a } = require_a();\nvar { b } = require_b();\nexport let t0 = (x) => a() * 10000 + b() + x;` },
  'the order the bodies run in': { mods: {
    log: `var seen = [];\n    exports.note = (v) => { seen.push(v); };\n    exports.all = () => seen.join('');`,
    one: `var { note } = require_log();\n    note('1');\n    var two = require_two();\n    note('3');\n    exports.v = two.v + 1;`,
    two: `var { note } = require_log();\n    note('2');\n    exports.v = 20;` },
    tail: `var log = require_log();\nlog.note('0');\nvar { v } = require_one();\nlog.note('4');\nexport let t0 = (x) => log.all() + v + x;` },
  'the same names in two bodies': { mods: {
    a: `var limit = 3;\n    function clamp(v) { return v > limit ? limit : v; }\n    var Box = class { constructor(v) { this.v = clamp(v); } };\n    exports.Box = Box;`,
    b: `var limit = 50;\n    function clamp(v) { return v > limit ? limit : v; }\n    var Box = class { constructor(v) { this.v = clamp(v) + 1000; } };\n    exports.Box = Box;` },
    tail: `var A = require_a();\nvar B = require_b();\nvar limit = 7;\nexport let t0 = (x) => new A.Box(x * 9).v + new B.Box(x * 9).v + limit;` },
  'a body\'s name that another body reads as a global': { mods: {
    a: `var Map = class { constructor() { this.size = 41; } };\n    exports.mine = () => new Map().size;`,
    b: `exports.theirs = (k) => { const m = new Map(); m.set(k, 1); m.set(k + 1, 2); return m.size; };` },
    tail: `var { mine } = require_a();\nvar { theirs } = require_b();\nexport let t0 = (x) => mine() * 10 + theirs(x);` },
  'a module nothing requires does not run': { mods: {
    log: `var n = 5;\n    exports.bump = () => { n += 100; };\n    exports.n = () => n;`,
    loud: `var { bump } = require_log();\n    bump();\n    exports.x = 1;`,
    main: `var { n } = require_log();\n    exports.n = n;` },
    tail: `var { n } = require_main();\nexport let t0 = (x) => n() + x;` },
  'instanceof and statics across modules': { mods: {
    shape: `var Shape = class _Shape { static made = 0; constructor() { _Shape.made += 1; } };\n    exports.Shape = Shape;`,
    main: `var { Shape } = require_shape();\n    var Sq = class extends Shape {};\n    exports.Sq = Sq;\n    exports.Shape = Shape;` },
    tail: `var { Sq, Shape } = require_main();\nexport let t0 = (x) => { const s = new Sq(); new Shape(); return (s instanceof Shape ? 100 : 0) + (new Shape() instanceof Sq ? 10 : 0) + Shape.made + x; };` },
  'a function declared after the class it makes': { mods: {
    m: `function make(v) { return new Cell(v); }\n    var Cell = class { constructor(v) { this.v = v; } get() { return this.v + 1; } };\n    exports.make = make;` },
    tail: `var { make } = require_m();\nexport let t0 = (x) => make(x).get();` },
  'the helper without its try': { helper: HELPER_PLAIN, mods: {
    shape: `${SHAPE}\n    exports.Shape = Shape;`,
    main: `var { Shape } = require_shape();\n    var Sq = class extends Shape { constructor(s) { super(1); this.s = s; } area() { return this.s * this.s; } };\n    exports.make = (s) => new Sq(s);` },
    tail: `var make = require_main().make;\nexport let t0 = (x) => make(x).twice();` },
  'a module of one parameter and of none': { mods: {
    a: [`exports`, `exports.v = 4;`], b: [``, `var side = 1;`], c: [`exports`, `var { v } = require_a();\n    require_b();\n    exports.w = v + 1;`] },
    tail: `var { w } = require_c();\nexport let t0 = (x) => w + x;` },
}
// What keeps a module a function, each still answering as Node.
const KEPT = {
  'required inside a function': { kept: ['lazy'], mods: {
    lazy: `var n = 0;\n    n += 7;\n    exports.n = () => n;`,
    main: `exports.get = () => require_lazy().n();` },
    tail: `var { get } = require_main();\nexport let t0 = (x) => get() + x;` },
  'required under a condition': { kept: ['opt'], mods: {
    opt: `exports.v = 9;` },
    tail: `var v = 1;\nif (v > 0) v = require_opt().v;\nexport let t0 = (x) => v + x;` },
  // (b holds a's exports while a still fills them: `late` is there by the time it is called)
  'two modules that require each other': { kept: ['a', 'b'], mods: {
    a: `exports.early = 1;\n    var b = require_b();\n    exports.late = () => 5;\n    exports.sum = () => b.viaLate() + 10;`,
    b: `var a = require_a();\n    exports.viaLate = () => a.late() + a.early;` },
    tail: `var a = require_a();\nexport let t0 = (x) => a.sum() + x;` },
  'its exports read back': { kept: ['m'], mods: {
    m: `exports.a = 3;\n    exports.b = exports.a + 1;` },
    tail: `var m = require_m();\nexport let t0 = (x) => m.a * 10 + m.b + x;` },
  'a member stored on module.exports': { kept: ['m'], mods: {
    m: `module.exports = { a: 3 };\n    module.exports.b = 4;` },
    tail: `var m = require_m();\nexport let t0 = (x) => m.a * 10 + m.b + x;` },
  'the whole module stored into by its requirer': { kept: ['m'], mods: {
    m: `exports.a = 3;\n    exports.get = () => exports.a;` },
    tail: `var m = require_m();\nm.a = 8;\nexport let t0 = (x) => m.get() + x;` },
  'the whole module passed on': { kept: ['m'], mods: {
    m: `exports.a = 3;` },
    tail: `var m = require_m();\nvar keys = (o) => Object.keys(o).length;\nexport let t0 = (x) => keys(m) + m.a + x;` },
  'a binding read before its require': { kept: ['m'], mods: {
    m: `exports.f = () => 5;` },
    tail: `var before = typeof f;\nvar { f } = require_m();\nexport let t0 = (x) => before.length + f() + x;` },
  'a body that returns': { kept: ['m'], mods: {
    m: `var done = true;\n    exports.a = 1;\n    if (done) return;\n    exports.b = 2;` },
    tail: `var m = require_m();\nexport let t0 = (x) => m.a + (m.b === undefined ? 10 : 0) + x;` },
  'a body that reads its arguments': { kept: ['m'], mods: {
    m: `var n = arguments.length;\n    exports.n = () => n;` },
    tail: `var { n } = require_m();\nexport let t0 = (x) => n() + x;` },
  'an export taken that is not made': { kept: ['m'], mods: {
    m: `exports.a = 1;` },
    tail: `var { a, b } = require_m();\nexport let t0 = (x) => a + (b === undefined ? 10 : 0) + x;` },
  'a kept module keeps what it requires': { kept: ['dep', 'lazy'], mods: {
    dep: `exports.v = 6;`,
    lazy: `var { v } = require_dep();\n    exports.w = v + 1;`,
    main: `exports.get = () => require_lazy().w;` },
    tail: `var { get } = require_main();\nexport let t0 = (x) => get() + x;` },
}

const run = (name, { mods, tail, helper, kept = [] }) => {
  // two calls of a fresh instance: a module's state is its own
  const src = bundle(mods, tail, helper), node = oracle(src).t0, want = `${node(3)} ${node(4)}`
  for (const optimize of levels(false, true, 'size', 'speed')) {
    const got = jz(src, { optimize }).exports.t0
    is(`${got(3)} ${got(4)}`, want, `${name} @${optimize}`)
  }
  const warnings = []
  compileWat(src, { warnings: w => warnings.push(w), optimize: 2 })
  const named = warnings.filter(e => e.code === 'module-kept').map(e => /module src\/(\w+)\.js/.exec(e.message)?.[1]).sort()
  is(named.join(' '), [...kept].sort().join(' '), `${name}: the modules kept`)
  return warnings
}

test('link-cjs: a module required as its requirers start stands at the module level', () => {
  for (const [name, p] of Object.entries(PROGRAMS)) {
    const warnings = run(name, p)
    is(warnings.filter(e => e.code === 'class-generic').length, 0, `${name}: every class a schema`)
  }
})

test('link-cjs: a module anything else is done with stays a function, and answers the same', () => {
  for (const [name, p] of Object.entries(KEPT)) run(name, p)
})

// A bundle that is none of esbuild's CommonJS keeps every statement: a helper of another body is no helper.
test('link-cjs: a helper of another body is left alone', () => {
  const src = `var __commonJS = (cb, mod) => function __require() { return mod || (mod = { exports: {} }, cb.run(mod.exports, mod), mod.exports); };
var require_a = __commonJS({ run(exports) { exports.v = 5; } });
var { v } = require_a();
export let t0 = (x) => v + x;`
  for (const optimize of levels(false, true)) is(jz(src, { optimize }).exports.t0(3), oracle(src).t0(3), `@${optimize}`)
})

// The bundle as esbuild itself writes it today: its helper is recognized by its text, so a
// release that words it otherwise leaves every module a function, and fails here.
test('link-cjs: esbuild\'s own bundle of CommonJS modules is linked', async () => {
  const { build } = await import('esbuild')
  const files = {
    'shape.js': `'use strict';\nclass Shape { constructor(k) { this.k = k } area() { return 0 } twice() { return this.area() * 2 + this.k } static unit() { return new Shape(1) } }\nmodule.exports = { Shape };\n`,
    'util.js': `'use strict';\nconst base = 10;\nfunction add(a, b) { return a + b + base }\nexports.add = add;\n`,
    'main.js': `'use strict';\nconst { Shape } = require('./shape');\nconst util = require('./util');\nclass Sq extends Shape { constructor(s) { super(Shape.unit().k); this.s = s } area() { return util.add(this.s * this.s, 0) } }\nexports.make = (s) => new Sq(s);\n`,
  }
  const mem = { name: 'mem', setup(b) {
    b.onResolve({ filter: /.*/ }, a => ({ path: a.path.replace(/^\.\//, '').replace(/(\.js)?$/, '.js'), namespace: 'mem' }))
    b.onLoad({ filter: /.*/, namespace: 'mem' }, a => ({ contents: files[a.path], loader: 'js' }))
  } }
  const out = await build({ stdin: { contents: `export const make = require('./main').make`, loader: 'js' }, plugins: [mem],
    bundle: true, format: 'esm', platform: 'node', target: 'es2020', write: false, minify: false, legalComments: 'none', logLevel: 'silent' })
  const src = out.outputFiles[0].text.replace(/\nexport \{[^}]*\};?\s*$/, '\n') + `export let t0 = (x) => make(x).twice();\n`
  ok(/__commonJS/.test(src), 'esbuild wraps the modules')
  const warnings = []
  compileWat(src, { warnings: w => warnings.push(w), optimize: 2 })
  is(warnings.filter(e => e.code === 'module-kept').map(e => e.message).join('; '), '', 'no module is left a function')
  is(warnings.filter(e => e.code === 'class-generic').length, 0, 'every class a schema')
  const want = oracle(src).t0(3)
  for (const optimize of levels(false, true, 'size', 'speed')) is(jz(src, { optimize }).exports.t0(3), want, `@${optimize}`)
})
