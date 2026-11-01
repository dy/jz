// Keyed recurrences (src/compile/loop-recurrence.js carryKeys): a loop whose
// scalar reads a table at a key of itself and the iteration's input, keeping the
// rest of itself by xor (a byte-wise CRC), carries the next key, the next input
// mixed into what the scalar keeps while the read is in flight. Every kernel runs
// against the host at every level and with the pass off: the CRCs of each width
// and bit order, a table of unsigned words, a key past the table, a scalar that
// starts undefined, and trip counts that leave the paired loop a tail.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'
import { ctx } from '../src/ctx.js'
import { T, walkAst } from '../src/ast.js'
import { onKernel, levels } from './_matrix.js'
import { oracle, compileInProcess } from './util.js'

const OFF = { level: 'speed', carryKeys: false }
// the bytes and the table a kernel reads: `b` of n bytes, `t` the reflected CRC-32 table of `ctor`
const DATA = (ctor) => `
const table = (poly) => { const t = new ${ctor}(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? poly ^ (c >>> 1) : c >>> 1; t[n] = c }
  return t }
const bytes = (n) => { const b = new Uint8Array(n); let x = 0x12345678; for (let i = 0; i < n; i++) { x = Math.imul(x, 1103515245) + 12345 | 0; b[i] = x >>> 16 } return b }`

const CASES = {
  // the reflected CRC-32 of zlib and PNG
  reflected: `${DATA('Int32Array')}
    const crc = (b, t, n) => { let c = -1; for (let i = 0; i < n; i++) c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0 }
    export let f = (n) => crc(bytes(n), table(0xEDB88320), n)`,
  // the operands the other way round, a table of unsigned words
  swapped: `${DATA('Uint32Array')}
    const crc = (b, t, n) => { let c = 0xffffffff; for (let i = 0; i < n; i++) c = (c >>> 8) ^ t[(b[i] ^ c) & 255]; return c >>> 0 }
    export let f = (n) => crc(bytes(n), table(0xEDB88320), n)`,
  // most significant bit first (CRC-32/MPEG-2): the key's scalar under a shift
  msbFirst: `${DATA('Int32Array')}
    const crc = (b, t, n) => { let c = -1; for (let i = 0; i < n; i++) c = t[((c >>> 24) ^ b[i]) & 0xff] ^ (c << 8); return c >>> 0 }
    export let f = (n) => crc(bytes(n), table(0x04C11DB7), n)`,
  // a 16-bit CRC: the update under a mask, the key's scalar under an arithmetic shift
  crc16: `${DATA('Uint16Array')}
    const crc = (b, t, n) => { let c = 0xffff; for (let i = 0; i < n; i++) c = ((c << 8) ^ t[((c >> 8) ^ b[i]) & 0xff]) & 0xffff; return c }
    export let f = (n) => crc(bytes(n), table(0x8408), n)`,
  // a compound update, an inclusive bound by name and a range that starts at 2
  compound: `${DATA('Int32Array')}
    const crc = (b, t, n) => { let c = 7; const hi = n - 1; for (let i = 2; i <= hi; i++) c ^= t[(c ^ b[i] ^ 0x5a) & 0xff] ^ (c >>> 3) ^ c; return c }
    export let f = (n) => crc(bytes(n + 2), table(0xEDB88320), n)`,
  // a key past the table's end reads undefined, a 0 in the xor
  pastEnd: `${DATA('Int32Array')}
    const crc = (b, t, n) => { let c = 0; for (let i = 0; i < n; i++) c = t[(c ^ b[i]) & 0x1ff] ^ (c >>> 8); return c }
    export let f = (n) => crc(bytes(n), table(0xEDB88320), n)`,
  // a scalar declared without a value starts undefined
  undef: `${DATA('Int32Array')}
    const crc = (b, t, n) => { let c; for (let i = 0; i < n; i++) c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8); return c }
    export let f = (n) => crc(bytes(n), table(0xEDB88320), n)`,
  // the byte a temporary of the body, the bound a declaration of the head
  temp: `${DATA('Int32Array')}
    const crc = (b, t) => { let c = -1; for (let i = 0, n = b.length; i < n; i++) { const x = b[i]; c = (c >>> 8) ^ t[(c ^ x) & 0xff] } return (c ^ -1) >>> 0 }
    export let f = (n) => crc(bytes(n), table(0xEDB88320))`,
}
const NS = [0, 1, 2, 3, 4, 5, 63, 64, 65]

test('keyed recurrences: every CRC answers what the host does, at every level', () => {
  for (const [name, src] of Object.entries(CASES)) {
    const native = oracle(src).f
    for (const optimize of [...levels(0, 2, 'size'), 'speed', OFF]) {
      const wasm = jz(src, { optimize }).exports.f
      for (const n of NS) is(wasm(n), native(n), `${name} ${JSON.stringify(optimize)}: f(${n})`)
    }
  }
})

// An export the host hands its input: the bytes are of no kind the compiler
// knows, read where they were, the bound the input's length.
const HOSTED = `const t = new Int32Array(256)
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c }
export let crc = (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ t[(c ^ buf[i]) & 0xff]; return (c ^ -1) >>> 0 }`
test('keyed recurrences: an input of any kind the host passes', () => {
  const native = oracle(HOSTED).crc
  const inputs = () => [new Uint8Array([]), new Uint8Array([1]), new Uint8Array([49, 50, 51, 52, 53, 54, 55, 56, 57]),
    [1, 2, 3, 250, 255], new Float64Array([0.5, 300.7, -1, 1e10]), new Int16Array([-1, 1000, -32768])]
  for (const optimize of [...levels(0, 2), 'speed', OFF]) {
    const wasm = jz(HOSTED, { optimize }).exports.crc
    inputs().forEach((x, k) => is(wasm(x), native(x), `${JSON.stringify(optimize)}: input ${k}`))
  }
})

// The planned body carries the key (`<scalar>key<id>`), and its update xors the
// table word last: the next input joins what the scalar keeps first, `w = P(Q(t))
// ^ (P(Q(s)) ^ b[i])` (the key's own xor, P(Q(s)) where P(v) stood), so the read
// of the next iteration waits on one xor.
const keyUpdates = (src, optimize) => {
  compileInProcess(src, { optimize })
  const out = []
  for (const fn of ctx.funcs.list) walkAst(fn.body, { enter: (n, parent) => {
    if (n[0] === '=' && parent?.[0] !== 'let' && typeof n[1] === 'string' && new RegExp(T + 'key\\d+$').test(n[1])) out.push(n[2])
  } })
  return out
}
const mentionsRead = (n) => Array.isArray(n) && (n[0] === '[]' || n.some((c, k) => k > 0 && mentionsRead(c)))
test('keyed recurrences: the loop carries the key, the input off the chain', () => {
  if (onKernel()) return
  const srcs = { ...CASES, hosted: HOSTED }
  for (const name of ['reflected', 'swapped', 'msbFirst', 'crc16', 'compound', 'temp', 'hosted']) {
    const on = keyUpdates(srcs[name], 'speed')
    ok(on.length > 0, `${name}: the key is carried at speed`)
    ok(on.every(e => e[0] === '^' && !mentionsRead(e[1]) && Array.isArray(e[2]) && e[2][0] === '^' && mentionsRead(e[2])),
      `${name}: the table word joins the next input last`)
    is(keyUpdates(srcs[name], OFF).length, 0, `${name}: no key with the pass off`)
    is(keyUpdates(srcs[name], 2).length, 0, `${name}: no key at the default level`)
  }
})

// Declines, each against the host: a table read with no other part of the scalar
// kept (nothing to mix the input into), a scalar that is a parameter, a table
// that is a plain array, a body of two statements, and an input that reads the scalar.
test('keyed recurrences: loops of other shapes keep their form', () => {
  const cases = {
    pearson: `${DATA('Uint8Array')}
      const h = (b, t, n) => { let c = 0; for (let i = 0; i < n; i++) c = t[(c ^ b[i]) & 0xff]; return c }
      export let f = (n) => h(bytes(n), table(0xB8), n)`,
    param: `${DATA('Int32Array')}
      const crc = (b, t, n, c) => { for (let i = 0; i < n; i++) c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8); return c }
      export let f = (n) => crc(bytes(n), table(0xEDB88320), n, -1)`,
    plain: `${DATA('Int32Array')}
      const crc = (b, t, n) => { let c = -1; for (let i = 0; i < n; i++) c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8); return c }
      export let f = (n) => crc(bytes(n), Array.from(table(0xEDB88320)), n)`,
    twoStatements: `${DATA('Int32Array')}
      const crc = (b, t, n) => { let c = -1, s = 0; for (let i = 0; i < n; i++) { c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8); s += c & 1 } return c + s }
      export let f = (n) => crc(bytes(n), table(0xEDB88320), n)`,
    selfInput: `${DATA('Int32Array')}
      const crc = (b, t, n) => { let c = -1; for (let i = 0; i < n; i++) c = t[(c ^ b[c & 7]) & 0xff] ^ (c >>> 8); return c }
      export let f = (n) => crc(bytes(n + 8), table(0xEDB88320), n)`,
  }
  for (const [name, src] of Object.entries(cases)) {
    const native = oracle(src).f
    for (const optimize of [...levels(0, 2), 'speed']) {
      const wasm = jz(src, { optimize }).exports.f
      for (const n of [0, 1, 2, 7, 20]) is(wasm(n), native(n), `${name}(${n}), O${optimize}`)
    }
    if (!onKernel()) is(keyUpdates(src, 'speed').length, 0, `${name}: no key carried`)
  }
})
