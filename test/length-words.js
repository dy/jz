// A length store of an integer word resizes by the word (emit-assign.js
// lengthWord, module/array.js __arr_set_len): ArraySetLength's two ToNumber
// conversions and its integer test have nothing to convert. A scratch list sized
// to another's count each pass is the shape, a literal clear (`a.length = 0`)
// another. A word below zero is the RangeError the test throws.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { belowOpt, levels } from './_matrix.js'
import { oracle, jz, wat, funcWat } from './util.js'

const agree = (src, calls) => {
  const host = oracle(src)
  for (const optimize of levels(0, 1, 2, 3, 'size')) {
    const mod = jz(src, { optimize }).exports
    for (const [name, ...args] of calls) {
      let want, got
      try { want = JSON.stringify(host[name](...args)) } catch (e) { want = e.name }
      try { got = JSON.stringify(mod[name](...args)) } catch (e) { got = e.name }
      is(got, want, `${name}(${args}) at ${JSON.stringify(optimize)}`)
    }
  }
}

// a port's scratch lists, sized to its connections each tick, then cleared
const scratch = `const port = { connections: [], scratch: null, bufs: null }
export let tick = (n, rounds) => {
  port.connections.length = 0
  for (let i = 0; i < n; i++) port.connections.push({ v: i * 3 })
  let h = 0
  for (let r = 0; r < rounds; r++) {
    const conns = port.connections, count = conns.length - (r % 2)
    const src = port.scratch || (port.scratch = [])
    src.length = count
    for (let i = 0; i < count; i++) src[i] = conns[i]
    const bufs = port.bufs || (port.bufs = [])
    bufs.length = count
    for (let i = 0; i < count; i++) bufs[i] = src[i].v + r
    h = (h * 31 + bufs.length + (count > 0 ? bufs[count - 1] : 7)) | 0
    src.length = 0
    h = (h + src.length + bufs.length) | 0
  }
  return h
}`

test('length words: a scratch list sized to a count, then cleared', () => {
  agree(scratch, [['tick', 0, 3], ['tick', 1, 4], ['tick', 5, 6], ['tick', 40, 9]])
})

test('length words: growth fills holes, truncation drops, a negative word throws', () => {
  agree(`export let grow = (k) => { const a = [1, 2, 3], n = k | 0; a.length = n; return [a.length, a[1], 1 in a, n - 1 in a, a.indexOf(undefined)] }
export let set = (k) => { const a = [1, 2, 3]; const n = (k | 0) - 5; const v = (a.length = n); return [v, a.length] }
export let zero = () => { const a = [1, 2, 3]; const v = (a.length = 0); a.push(4); return [v, a.length, a[0]] }
export let negZero = () => { const a = [1, 2]; const v = (a.length = -0); return [Object.is(v, -0), a.length] }
export let other = (k) => { const a = k > 0 ? [1, 2] : { length: 7, x: 1 }; a.length = k | 0; return [a.length, Array.isArray(a)] }`,
  [['grow', 0], ['grow', 2], ['grow', 3], ['grow', 9], ['set', 8], ['set', 5], ['set', 2], ['zero'], ['negZero'], ['other', 3], ['other', 0], ['other', -4]])
})

test('length words: the store of a count resizes without converting it', () => {
  if (belowOpt(2)) return
  const body = funcWat(wat(scratch, { optimize: 2 }), 'tick')
  ok(body, 'tick is a function')
  // (a loop's version over Numbers keeps the count a Number there: that store converts it)
  ok((body.match(/call \$__arr_set_len\b/g) || []).length >= 2, 'the counts resize by their words')
})
