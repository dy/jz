// The wrong-code family corpus (test/self-families.js): ordinary JS around the
// fresh self gate's reds, each case with its calls and the results JS gives
// (a `{ throws }` expects that error class, a `{ thrown }` the primitive the
// host receives as `Error.thrown`). The authored results are checked against
// Node before any compiler is judged. `red` names the legs known red, so a
// failure reads as the recorded defect or as a new one.
export const FAMILIES = [
  { family: 'typeof guards: expression vs statement', cases: [
    { name: 'statement guard', src: `export const addr = (idx) => { if (typeof idx === "number") return idx * 8; return idx }\nexport let f = () => addr(2)`, calls: [['f', [], 16]] },
    { name: 'expression guard', src: `export const addr = (idx) => typeof idx === "number" ? idx * 8 : idx\nexport let f = () => addr(2)`, calls: [['f', [], 16]],
      red: { hosted: 'emitFuncs: Cannot mix BigInt (layout.js i64Hex, .work/optimizer-review/checkpoint-45868ec5.md)' } },
    { name: 'guard arms for every kind but null', src: `const kind = (v) => typeof v === "string" ? 1 : typeof v === "undefined" ? 2 : typeof v === "bigint" ? 3 : typeof v === "object" ? 4 : 0\nexport let f = () => kind("s") * 1000 + kind(undefined) * 100 + kind(5n) * 10 + kind({})`, calls: [['f', [], 1234]] },
    { name: 'typeof null is "object" in a guard', src: `const expr = (v) => typeof v === "object" ? 4 : 0\nconst stmt = (v) => { if (typeof v === "object") return 4; return 0 }\nconst neg = (v) => typeof v !== "object" ? 1 : 0\nexport let f = () => expr(null) * 100 + stmt(null) * 10 + neg(null)\nexport let t = () => typeof null`, calls: [['f', [], 440], ['t', [], 'object']],
      red: { native: 'every level: the guard is false for null in both forms while `typeof null` itself is "object" (src/compile/emit/comparisons.js, the TYPEOF.object arm)' } },
  ] },
  { family: 'BigInt across an internal call boundary, then a typed store', cases: [
    { name: 'read through a call, or-assign, typed store', src: `const buf = new BigInt64Array(2)\nconst rd = (i) => buf[i]\nexport let f = (n) => { buf[0] = BigInt(n); let v = rd(0); v |= 0x100n; buf[1] = v; return Number(buf[1]) }`, calls: [['f', [5], 261], ['f', [256], 256]],
      red: { native: 'O0 O1: the store writes the box, not the value (D receipt reduction)', hosted: 'the same' } },
    { name: 'read through a call, add-assign, Number()', src: `const buf = new BigInt64Array(1)\nconst rd = () => buf[0]\nexport let g = (n) => { buf[0] = BigInt(n); let v = rd(); v += 1n; return Number(v) }`, calls: [['g', [5], 6]],
      red: { native: 'O0 O1: Number() of the box', hosted: 'the same' } },
    { name: 'no call boundary', src: `const buf = new BigInt64Array(2)\nexport let f = (n) => { buf[0] = BigInt(n); let v = buf[0]; v |= 0x100n; buf[1] = v; return Number(buf[1]) }`, calls: [['f', [5], 261]] },
    { name: 'shift through a call, stored directly', src: `const buf = new BigInt64Array(2)\nconst rd = (i) => buf[i]\nexport let h = (n) => { buf[0] = BigInt(n); const v = rd(0) << 4n; buf[1] = v; return Number(buf[1]) }`, calls: [['h', [3], 48]] },
    { name: 'internal shift by a BigInt parameter', src: `const shl = (b, k) => b << k\nexport let f = (n) => Number(shl(BigInt(n), 3n))`, calls: [['f', [3], 24]] },
  ] },
  { family: 'Number/BigInt/Boolean/nullish call boundaries', cases: [
    { name: 'nullish BigInt default', src: `const pick = (x) => x ?? 0n\nexport let f = (a) => { const v = pick(a === 0 ? null : 5n); return Number(v + 1n) }`, calls: [['f', [0], 1], ['f', [1], 6]] },
    { name: 'Boolean into arithmetic', src: `const flag = (x) => x > 2\nexport let f = (a) => { const b = flag(a); return b + 1 }\nexport let g = (a) => Number(flag(a)) * 2 + (flag(a) ? 1 : 0)`, calls: [['f', [1], 1], ['f', [3], 2], ['g', [3], 3]] },
    { name: 'a helper returning BigInt or Number', src: `const z = (x) => x ? 1n : 0\nexport let f = (a) => typeof z(a)`, calls: [['f', [0], 'number'], ['f', [1], 'bigint']] },
    { name: 'nullish and falsy Numbers', src: `const d = (x) => x ?? 7\nexport let f = (a) => d(a === 1 ? undefined : a === 2 ? null : a) + 1\nexport let g = (a) => (a || 0) + (a ?? 9)`, calls: [['f', [1], 8], ['f', [2], 8], ['f', [3], 4], ['g', [0], 0], ['g', [5], 10]] },
    { name: 'negative zero, a subnormal, absence', src: `const id = (x) => x\nexport let f = () => Object.is(id(-0), -0) ? 1 : 0\nexport let g = () => id(5e-324) * 2 === 1e-323 ? 1 : 0\nexport let h = () => 1 / id(-0) < 0 ? 1 : 0\nexport let k = () => { const m = new Map(); m.set(0, 'z'); return m.get(-0) === 'z' ? 1 : 0 }\nexport let a = (x) => x === undefined ? 1 : 0`, calls: [['f', [], 1], ['g', [], 1], ['h', [], 1], ['k', [], 1], ['a', [], 1], ['a', [0], 0]] },
  ] },
  { family: 'reassigned encoder inputs', cases: [
    { name: 'a string parameter reassigned', src: `const clean = (n) => { n = n.replaceAll('_', ''); if (n[0] === '+') n = n.slice(1); return n }\nexport let f = (s) => clean(s).length\nexport let g = (s) => { let x = s; x = x + x; x = x.slice(1); return x }`, calls: [['f', ['+1_000'], 4], ['g', ['ab'], 'bab']] },
    { name: 'a number parameter reassigned in a LEB loop', src: `const enc = (v, out) => { v = v < 0 ? -v * 2 - 1 : v * 2; while (v >= 128) { out.push((v & 127) | 128); v = Math.floor(v / 128) } out.push(v); return out.length }\nexport let f = (v) => { const out = []; enc(v, out); return out.join(',') }`, calls: [['f', [300], '216,4'], ['f', [-5], '9'], ['f', [0], '0']] },
    { name: 'a BigInt parameter reassigned in a LEB loop', src: `const enc = (n) => { let out = ''; n = BigInt.asIntN(64, n); while (true) { const b = Number(n & 0x7fn); n >>= 7n; if ((n === 0n && (b & 0x40) === 0) || (n === -1n && (b & 0x40) !== 0)) { out += b + ','; break } out += (b | 0x80) + ',' } return out }\nexport let f = (v) => enc(BigInt(v))`, calls: [['f', [300], '172,2,'], ['f', [-5], '123,'], ['f', [0], '0,']] },
  ] },
  { family: 'vectorized receiver and callback evaluation', cases: [
    { name: 'forEach closure over an outer accumulator', src: `export let f = () => { let s = 0; [1,2,3,4].forEach(x => s += x); return s }`, calls: [['f', [], 10]],
      red: { hosted: 'O2: the level-2 inliner (test/self-compile.js)' } },
    { name: 'typed map with a counting callback', src: `export let g = (n) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = i; let c = 0; const r = a.map(x => { c++; return x * 2 }); return r[n - 1] + c }`, calls: [['g', [4], 10], ['g', [0], NaN]] },
    { name: 'the receiver evaluates once', src: `let calls = 0\nconst arr = () => { calls++; return [3, 1, 2] }\nexport let f = () => { const s = arr().map(x => x + 1).reduce((a, b) => a + b, 0); return s * 10 + calls }`, calls: [['f', [], 91]] },
  ] },
  { family: 'strings: escapes and code units', cases: [
    { name: 'hex and unicode escapes equal their characters', src: `export let f = () => "\\xff" === "ÿ" ? 1 : 0\nexport let k = () => "\\uD83D\\uDE00" === "😀" ? 1 : 0\nexport let u = () => "\\u{1F600}" === "😀" ? 1 : 0`, calls: [['f', [], 1], ['k', [], 1], ['u', [], 1]],
      red: { hosted: 'the kernel decodes \\xHH and \\uHHHH above 0x7f through String.fromCharCode (A receipt)' } },
    { name: 'String.fromCharCode above 0xff', src: `export let h = () => String.fromCharCode(0x100).charCodeAt(0)\nexport let a = () => String.fromCharCode(65, 66)`, calls: [['h', [], 256], ['a', [], 'AB']],
      red: { native: 'every level: the runtime writes one byte (0)' } },
  ] },
  { family: 'error arms', cases: [
    { name: 'thrown classes and primitives', src: `export let f = (x) => { try { if (x === 1) throw new TypeError('t'); if (x === 2) throw 5; if (x === 3) throw 'str'; return 0 } catch (e) { return e instanceof TypeError ? 1 : typeof e === 'number' ? e : typeof e === 'string' ? e.length : -1 } }\nexport let g = (x) => { if (x) throw new RangeError('r'); return 1 }\nexport let h = (x) => { if (x) throw 42; return 1 }`,
      calls: [['f', [0], 0], ['f', [1], 1], ['f', [2], 5], ['f', [3], 3], ['g', [1], { throws: 'RangeError' }], ['g', [0], 1], ['h', [1], { thrown: 42 }]] },
  ] },
]
