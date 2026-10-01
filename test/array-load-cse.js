import test from 'tst'
import { ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { agree, funcWat, wat } from './util.js'
import parseWat from 'watr/parse'
import { walk } from '../scripts/wat-probe.mjs'

const kernel = `const a = [1, 2, 3], out = new Float64Array(3)
export const f = (n) => {
  let s = 0
  for (let i = 0; i < n; i++) {
    out[0] = a[0] + a[1]
    out[1] = a[1] + a[2]
    out[2] = a[2] + a[0]
    s += out[0] + out[1] + out[2]
    a[0] = s * 0.001
  }
  return s
}`

test('array load cse: plain numeric elements survive writes to typed storage', () => {
  for (const optimize of levels(0, 2, 3)) agree(kernel, 'f', [7], { optimize })
  if (belowOpt(2)) return
  const loads = loadCSE => {
    // The reads alone: no store forwarded, and `out` kept in memory (a static array
    // only constants index is registers, and so is a Float64Array's constant-index
    // element a loop stores numbers into, which leaves the plain reads to any CSE).
    const text = wat(kernel, { optimize: { level: 2, loadCSE, forwardStores: false, staticScratch: false, vectorizeLaneLocal: false, promoteLoopFields: false } })
    const counts=[]
    walk(parseWat(funcWat(text, 'f$exp') || funcWat(text, 'f')),n=>{
      if(n[0]==='loop')counts.push((JSON.stringify(n).match(/f64\.load/g)||[]).length)
    })
    return counts
  }
  const cached = loads(true)
  ok(cached.length>0,'the loop paths remain present')
  for(const count of cached)ok(count <= 6, `${count} loads in one loop: the three shared plain-array reads stay eliminated`)
  ok(cached.reduce((a,b)=>a+b,0) < loads(false).reduce((a,b)=>a+b,0), 'the shared plain-array reads are eliminated before lowering')
})

test('array load cse: aliases, resizing, misses, effects and branches retain JS answers', () => {
  const rows = [
    `const a = [2, 3], b = a; const x = a[0]; b[0] = 7; return x * 10 + a[0]`,
    `const a = [2, 3], b = a; const x = a[0]; b[1] = 7; return x * 10 + a[0]`,
    `const a = [2, 3], b = a; const x = a[0]; b.length = 0; return x + a[0]`,
    `const a = [2, 3], b = a; const x = a[0]; delete b[n - 1]; return x * 10 + (a[0] === undefined ? 1 : 0)`,
    `const a = [2, 3]; const x = a[4]; a[4] = 7; return x === undefined ? a[4] : -1`,
    `const a = [2, 3]; const x = a[0]; a.push(4, 5, 6, 7, 8); return x + a[0]`,
    `const a = [2, 3]; const bump = () => { a[0] = 7; return 1 }; return a[0] + bump() + a[0]`,
    `const a = [2, 3]; const x = a[0]; if (n) a[0] = 7; return x + a[0]`,
    `const a = [2, 3]; let b = a; const x = b[0]; b = [7, 8]; return x + b[0]`,
    `let a = [2, 3]; const b = a, x = b[0]; a = [7, 8]; return x + a[0] + b[0]`,
    `const rows = [[2, 3], [7, 8]]; const a = rows[n - 1], x = a[0]; rows[n - 1] = rows[1]; const b = rows[n - 1]; return x + a[0] + b[0]`,
    `const rows = [[2, 3]]; const a = rows[n - 1], x = a[0]; const b = rows[n - 1]; b[0] = 7; return x + a[0]`,
    `const a = [2, 3]; const x = a[0]; const b = n ? (a[0] = 7) : 3; return x + a[0] + b`,
    `const a = [2, 3]; let x = 0; if (n) x = a[0]; else x = a[0] + 1; return x + a[0]`,
    `const a = [2, 3], other = [7, 8], b = n ? a : other; const x = a[0]; b[0] = 11; return x + a[0]`,
    `const a = [2n, 3n], b = [7, 8]; const x = a[n + 2]; b[0] = 2; const y = a[n + 2]; return x === y`,
  ]
  for (const body of rows) for (const optimize of levels(0, 2, 3))
    agree(`export const f = n => { ${body} }`, 'f', [1], { optimize }, `${body} at ${optimize}`)
})

test('array load cse: a missing nested receiver still throws at the first read', () => {
  const src = `const rows = [[2, 3]], out = [0]
    export const f = i => { try { const a = rows[i]; const x = a[0]; out[0] = 7; const b = rows[i]; return x + b[0] }
    catch (e) { return e.name === 'TypeError' ? 9 : 0 } }`
  for (const optimize of levels(0, 2, 3)) for (const i of [0, 1]) agree(src, 'f', [i], { optimize })
})

test('array load cse: nested receivers survive distinct scratch stores and scalar branches', () => {
  const src = `const rows = [[1, 2], [3, 4]], scratch = [0, 0]
    export const f = () => { let s = 0; for (let i = 0; i < 2; i++) {
      const p = rows[i], x = p[0]; scratch[0] = x
      let scale = 1; if (i) scale = Math.sqrt(4)
      const q = rows[i]; s += x + q[0] * scale + scratch[0]
    } return s }`
  for (const optimize of levels(0, 2, 3)) agree(src, 'f', [], { optimize })
  if (belowOpt(2)) return
  const loads = loadCSE => {
    const text = wat(src, { optimize: { level: 2, loadCSE, forwardStores: false } })
    return (funcWat(text, 'f$exp') || funcWat(text, 'f')).match(/f64\.load/g)?.length || 0
  }
  const cached = loads(true)
  ok(cached <= 6, `${cached} loads: the containing slot and its element stay shared`)
  ok(cached < loads(false), 'the two names for one element reuse its loaded value')
})
