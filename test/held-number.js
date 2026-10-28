// A module name that holds one number for good reads as that number
// (src/summary `held`, src/compile/plan/scope.js foldModuleConstants): a name
// assigned once where no read finds it unassigned, a name declared with another
// such name, a field of an object literal the program only reads. A function's
// own binding of the same name is another binding (prepare names it apart). A
// name with a second write, a write the walk cannot value, a read that can come
// first, or an export the host can store to keeps its global.
import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'

// These probes inspect the in-process summary; runtime checks still use the matrix target.
import { ctx } from '../src/ctx.js'
import { belowOpt, levels, onWasi } from './_matrix.js'
import { funcWat, oracle, run, wat, compileInProcess as compile } from './util.js'

// The number the compiler folds `name` to; null when it reads the global.
const folded = (src, name, opts) => {
  compile(src, { ...opts, optimize: 0 })
  return ctx.scope.constNums?.get(name) ?? null
}
// jz and the host on a sequence of calls: [export, ...args] each, results compared in order.
const agreeCalls = (src, calls, label, opts) => {
  const host = oracle(src)
  const want = calls.map(([f, ...args]) => host[f](...args))
  for (const optimize of levels(0, 2, 3)) {
    const m = run(src, { ...opts, optimize })
    calls.forEach(([f, ...args], i) => is(m[f](...args), want[i], `${label} at ${optimize}: ${f}(${args.join(', ')}) #${i}`))
  }
}

const held = {
  'assigned once in the arm a constant test takes': ['const LE = true\nlet HIGH\nif (LE === true) { HIGH = 1 } else { HIGH = 0 }\nexport let f = (x) => x + HIGH', 'HIGH', 1],
  'declared with a name that holds one': ['const LE = true\nlet H\nif (LE === true) { H = 1 } else { H = 0 }\nconst high = H\nexport let f = (x) => x + high', 'high', 1],
  'a field of a literal only read': ['const idx = { HIGH: 1, LOW: 0 }\nconst H = idx.HIGH, L = idx.LOW\nexport let f = (x) => x * H + L', 'H', 1],
  'a field through a second name of the literal': ['let HIGH, LOW\nconst LE = true\nif (LE === true) { HIGH = 1; LOW = 0 } else { HIGH = 0; LOW = 1 }\nconst words = { HIGH: HIGH, LOW: LOW }\nconst idx = words\nconst H = idx.HIGH\nexport let f = (x) => x + H', 'H', 1],
  'a fraction': ['let STEP\nSTEP = 0.125\nexport let f = (x) => x * STEP', 'STEP', 0.125],
  'an index of a typed array': ['const LE = true\nlet HIGH\nif (LE === true) { HIGH = 1 } else { HIGH = 0 }\nconst F = new Float64Array(1), U = new Uint32Array(F.buffer)\nexport let f = (x) => { F[0] = x; return U[HIGH] }', 'HIGH', 1],
  'a negative zero': ['const LE = true\nlet Z\nif (LE === true) { Z = -0 } else { Z = 0 }\nexport let f = (x) => x / Z', 'Z', -0],
  'beside a parameter of its name': ['let K\nK = 4\nconst g = (K) => K + 1\nexport let f = (x) => g(x) * 100 + K', 'K', 4],
  'beside a local of its name': ['let K\nK = 4\nconst g = (v) => { let K = v * 2; K += 1; return K }\nexport let f = (x) => g(x) * 100 + K', 'K', 4],
  'beside a loop counter of its name': ['let K\nK = 4\nconst g = (v) => { let s = 0; for (let K = 0; K < v; K++) s += K; return s }\nexport let f = (x) => g(x) * 100 + K', 'K', 4],
  'beside a closure\'s parameter of its name': ['let K\nK = 4\nexport let f = (x) => { const g = (K) => K * 2; return g(x) * 100 + K }', 'K', 4],
  // an exact function of `Math`: the single nearest a literal, as a library declares its float constants
  'a single of a literal': ['const PI32 = Math.fround(3.141592653589793)\nexport let f = (x) => x * PI32', 'PI32', Math.fround(3.141592653589793)],
  'through a name that holds the function': ['var fround = typeof Math.fround === "function" ? Math.fround : null\nvar f32 = fround\nvar PI32 = f32(3.141592653589793)\nvar HALF = PI32\nexport let f = (x) => f32(f32(x) * HALF)', 'HALF', Math.fround(3.141592653589793)],
  'a floor, a root and a greater of held numbers': ['const A = 10.75, B = Math.floor(A), C = Math.sqrt(16), D = Math.max(B, C, 3)\nexport let f = (x) => x * B + C + D', 'D', 10],
  // a table's length read before anything can resize it, the table passed on and its sibling pushed to
  'the length of a table declared before it': ['const T = [0, 0, 6, 0, 6, 3, 5, 3]\nconst N = T.length / 2\nconst U = []\nfor (let i = 0; i < 4; i++) U.push(i * 0.5, i)\nconst sum = (v, n) => { let s = 0; for (let i = 0; i < n; i++) s += v[i * 2] * v[i * 2 + 1]; return s }\nexport let f = (x) => x * N + sum(T, N) + sum(U, 4)', 'N', 4],
  'the length of a table past numbers declared between': ['const T = [1, 2, 3]\nconst K = 2, M = K * 3 + -1\nconst W = [K, M]\nconst N = T.length + W.length * M\nexport let f = (x) => x + N', 'N', 13],
}

test('held number: a name that holds one number for good reads as it', () => {
  for (const [name, [src, binding, value]] of Object.entries(held)) {
    is(folded(src, binding), value, `${name}: ${binding} folds`)
    agreeCalls(src, [['f', 1.5], ['f', -3], ['f', 7], ['f', 1e3]], name)
  }
})

test('held number: its reads leave no global read', () => {
  if (belowOpt(2)) return
  for (const [name, [src, binding]] of Object.entries(held))
    ok(!new RegExp(`global\\.get \\$${binding}\\b`).test(funcWat(wat(src, { optimize: 3 }), 'f')), `${name}: f reads no $${binding}`)
})

// [source, the binding, the calls]
const open = {
  'a second assignment in a function': ['let K = 1\nexport let set = (v) => { K = v; return K }\nexport let get = () => K', 'K', [['get'], ['set', 5], ['get']]],
  'an assignment in a function alone': ['let K\nexport let init = (v) => { K = v; return 1 }\nexport let get = () => K === undefined ? -1 : K', 'K', [['get'], ['init', 5], ['get']]],
  'an increment': ['let K = 1\nexport let bump = () => { K++; return K }\nexport let get = () => K', 'K', [['get'], ['bump'], ['get']]],
  'a compound assignment in a closure': ['let K = 1\nconst add = (v) => () => { K += v; return K }\nexport let bump = (v) => add(v)()\nexport let get = () => K', 'K', [['get'], ['bump', 2], ['get']]],
  'a read that comes before the assignment': ['let K\nfunction peek() { return K === undefined ? -1 : K }\nconst early = peek()\nK = 3\nexport let get = () => early * 10 + peek()', 'K', [['get']]],
  'an assignment one arm makes': ['let K\nconst pick = (v) => v > 0\nif (pick(0)) { K = 1 }\nexport let get = () => K === undefined ? -1 : K', 'K', [['get']]],
  'a loop that assigns': ['let K = 0\nfor (let i = 0; i < 3; i++) { K = i }\nexport let get = () => K', 'K', [['get']]],
  'a module loop counter': ['let K = 0\nfor (K = 0; K < 3; K++) { }\nexport let get = () => K', 'K', [['get']]],
  'a pattern assignment': ['let A = 1, B = 2\nexport let swap = () => { [A, B] = [B, A]; return A * 10 + B }\nexport let get = () => A * 10 + B', 'A', [['get'], ['swap'], ['get']]],
  'a field stored after the read': ['const idx = { HIGH: 1 }\nconst H = idx.HIGH\nidx.HIGH = 5\nexport let get = () => H * 10 + idx.HIGH', 'H', [['get']]],
  'a field stored before the read': ['const idx = { HIGH: 1 }\nidx.HIGH = 5\nconst H = idx.HIGH\nexport let get = () => H', 'H', [['get']]],
  'a literal a function may write': ['const idx = { HIGH: 1 }\nconst poke = (o) => { o.HIGH = 7; return o }\npoke(idx)\nconst H = idx.HIGH\nexport let get = () => H', 'H', [['get']]],
  'a literal a computed key writes': ['const idx = { HIGH: 1 }\nconst key = (v) => v > 0 ? "HIGH" : "LOW"\nidx[key(1)] = 9\nconst H = idx.HIGH\nexport let get = () => H', 'H', [['get']]],
  'a table pushed to before its length is read': ['const T = [1, 2]\nT.push(3)\nconst N = T.length\nexport let get = () => N', 'N', [['get']]],
  'a table a call between may resize': ['const T = [1, 2]\nconst grow = () => { T.push(3); return 1 }\nconst G = grow()\nconst N = T.length\nexport let get = () => N * 10 + G', 'N', [['get']]],
  'a table read past an object\'s conversion': ['const T = [1, 2]\nconst o = { valueOf() { T.push(9); return 1 } }\nconst V = o * 2\nconst N = T.length\nexport let get = () => N * 10 + V', 'N', [['get']]],
  'a table a loop between may resize': ['const T = [1, 2]\nfor (let i = 0; i < 2; i++) T.push(i)\nconst N = T.length\nexport let get = () => N', 'N', [['get']]],
}

test('held number: a name with another write or an earlier read keeps its global', () => {
  for (const [name, [src, binding, calls]] of Object.entries(open)) {
    is(folded(src, binding), null, `${name}: ${binding} does not fold`)
    agreeCalls(src, calls, name)
  }
})

// A `var` exists from the start of the module: a read ahead of its assignment finds undefined.
const early = {
  'a read through a function': ['function peek() { return K === undefined ? -1 : K }\nvar early = peek()\nvar K = 3\nexport let get = () => early * 10 + peek()', 'K'],
  'a read in a statement': ['var early = K === undefined ? -1 : K\nvar K = 3\nexport let get = () => early * 10 + K', 'K'],
  'a read in a closure': ['var g = () => K === undefined ? -1 : K\nvar early = g()\nvar K = 3\nexport let get = () => early * 10 + g()', 'K'],
  'a read ahead of an arm\'s assignment': ['function peek() { return K === undefined ? -1 : K }\nvar early = peek()\nvar K\nvar LE = true\nif (LE === true) { K = 1 } else { K = 0 }\nexport let get = () => early * 10 + peek()', 'K'],
  'a read ahead of a literal\'s field': ['function peek() { return H === undefined ? -1 : H }\nvar early = peek()\nvar idx = { HIGH: 1 }\nvar H = idx.HIGH\nexport let get = () => early * 10 + peek()', 'H'],
}

test('held number: a var a read can find unassigned keeps its global', () => {
  for (const [name, [src, binding]] of Object.entries(early)) {
    is(folded(src, binding, { jzify: true }), null, `${name}: ${binding} does not fold`)
    agreeCalls(src, [['get']], name, { jzify: true })
  }
})

// An exported binding is a live binding the host reads and cannot assign, as
// an importer of an ES module (interop.js jz:values): the module's value stands.
test('held number: an exported name reads as the binding, which the host cannot store into', () => {
  if (onWasi()) return
  const src = 'export let K = 1\nexport let get = () => K + 1\nexport let set = (v) => { K = v }'
  for (const optimize of levels(0, 2, 3)) {
    const m = run(src, { optimize })
    is([m.K, m.get()], [1, 2], `before a store at ${optimize}`)
    throws(() => { m.K = 7 }, TypeError, `the host's store is refused at ${optimize}`)
    is([m.K, m.get()], [1, 2], `after the host's refused store at ${optimize}`)
    m.set(7)
    is([m.K, m.get()], [7, 8], `after the module's store at ${optimize}`)
  }
})
