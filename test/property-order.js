import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { oracle, funcWat } from './util.js'

const snapshot = `function snapshot(o) {
  let loop = ''
  for (const k in o) loop += k + ','
  return JSON.stringify([Object.keys(o), Object.values(o), Object.entries(o), loop, JSON.stringify(o)])
}`
const check = (src, inputs) => {
  for (const optimize of [0, 2, 3, 'size']) {
    const got = jz(snapshot + src, { optimize }).exports, want = oracle(snapshot + src)
    for (const k of inputs) is(got.f(k), want.f(k), `O${optimize}, input ${k}`)
  }
}

test('property order: merge schema and computed numeric keys', () => {
  check(`export function f(k) {
    const o = { 1: 'one', 10: 'ten', a: 3 }
    o[k] = 'computed'
    return snapshot(o)
  }`, [2, 0, 20, 2, 2, 1])
})

test('property order: merge init and runtime keys with authoritative values', () => {
  check(`
    const o = { 1: 'one', 10: 'ten', a: 1 }
    for (const k of ['5', 'before', '3']) o[k] = 'init'
    export function f(k) {
      o[k] = 'runtime'
      o['after' + ''] = 7
      o['before' + ''] = 'overwritten'
      return snapshot(o)
    }
  `, [2, 2])
})

test('property order: empty, deleted, undefined, boundary and nested properties', () => {
  check(`export function f(k) {
    const o = { 1: 'one', a: undefined }
    const names = ['0', '4294967294', '4294967295', '01', '-1', '']
    for (let i = 0; i < names.length; i++) o[names[i]] = i
    const key = k ? '1' : 'a'
    delete o[key]
    const before = snapshot(o)
    o[key] = undefined
    return before + '|' + snapshot(o) + '|' + snapshot({}) + '|' + JSON.stringify({ nested: o })
  }`, [0, 0, 1])
})

test('property order: heap-string duplicates and durable schema reinsertion', () => {
  check(`
    const o = { schema_property_long: 1, z: 2 }
    const initial = 'dynamic_property_long'
    o[initial] = 3
    export function f(suffix) {
      o['dynamic_property_' + suffix] = 4
      const before = snapshot(o)
      const key = 'schema_property_' + suffix
      delete o[key]
      o[key] = undefined
      return before + '|' + snapshot(o)
    }
  `, ['long', 'long', 'other'])
})

test('collection order: Map and Set keep insertion order through deletion and copies', () => {
  check(`export function f(k) {
    const m = new Map(), s = new Set()
    for (let i = k; i > 0; i--) { m.set(i, i * 2); s.add(i) }
    m.delete(2); s.delete(2)
    if (k) { m.set(2, 99); s.add(2) }
    return JSON.stringify([[...m.keys()], [...m.values()], [...s], [...new Map(m)], [...new Set(s)]])
  }`, [0, 5, 5, 0, 1])
})

test('property order: reinsertion and later writes keep slot values and invalidate cached keys', () => {
  check(`export function f(k) {
    const o = { a: 1, b: 2, c: 3 }
    o['extra' + k] = 4
    const before = snapshot(o)
    delete o[k]
    const absent = snapshot(o)
    o.a = undefined
    const restored = snapshot(o)
    o.a = 9
    const updated = snapshot(o)
    delete o[k]
    o.a = 10
    return before + '|' + absent + '|' + restored + '|' + updated + '|' + snapshot(o)
  }`, ['a', 'a', 'c'])
})

test('collection order: nested empty and populated collections retain outer bounds', () => {
  check(`export function f(k) {
    const outer = new Map(), inner = new Map()
    if (k) { inner.set(2, 'two'); inner.set(1, 'one') }
    outer.set('first', inner); outer.set('empty', new Map()); outer.set('last', inner)
    const copy = structuredClone(outer), out = []
    for (const [key, value] of copy) out.push([key, [...value]])
    return JSON.stringify(out)
  }`, [0, 2, 2, 0])
})

test('collection order: insertion-only traversal uses one slot-offset buffer', () => {
  const wat = compile('export const f = n => { const m = new Map(); for(let i=0;i<n;i++)m.set(i,i); return [...m.keys()].length }', { optimize: 0, wat: true })
  const body = funcWat(wat, '__coll_order')
  ok(body.length > 0, 'ordering helper is present')
  is((body.match(/call \$__alloc\b/g) || []).length, 2, 'empty return and one 4N-byte offset buffer; no rank allocation')
  ok(!body.includes('$__str_index_key'), 'Map ordering does not parse property indices')
})
