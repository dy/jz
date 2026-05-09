import test from 'tst'
import { is, ok } from 'tst/assert.js'
import jz from '../index.js'

const run = code => jz(code).exports.f()
const same = (actual, expected) => {
  if (Number.isNaN(expected)) return ok(Number.isNaN(actual))
  return is(actual, expected)
}

test('Date.UTC: default fields and year offset', () => {
  same(run('export let f = () => Date.UTC(1970)'), 0)
  same(run('export let f = () => Date.UTC(2016, 6, 5, 15, 34, 45, 876)'), 1467732885876)
  same(run('export let f = () => Date.UTC(70, 0)'), 0)
  same(run('export let f = () => Date.UTC(100, 0)'), -59011459200000)
})

test('Date.UTC: overflow and non-integer values', () => {
  same(run('export let f = () => Date.UTC(2016, 12, 1)'), 1483228800000)
  same(run('export let f = () => Date.UTC(2016, -1, 1)'), 1448928000000)
  same(run('export let f = () => Date.UTC(1970.9, 0.9, 1.9, 0.9, 0.9, 0.9, 0.9)'), 0)
  same(run('export let f = () => Date.UTC(-1970.9, -0.9, -0.9, -0.9, -0.9, -0.9, -0.9)'), -124334438400000)
})

test('Date.UTC: NaN and TimeClip', () => {
  same(run('export let f = () => Date.UTC()'), NaN)
  same(run('export let f = () => Date.UTC(NaN, 0)'), NaN)
  same(run('export let f = () => Date.UTC(1970, NaN)'), NaN)
  same(run('export let f = () => Date.UTC(275760, 8, 13, 0, 0, 0, 0)'), 8640000000000000)
  same(run('export let f = () => Date.UTC(275760, 8, 13, 0, 0, 0, 1)'), NaN)
})

test('Date object: getTime and valueOf', () => {
  same(run('export let f = () => { let d = new Date(0); return d.getTime() }'), 0)
  same(run('export let f = () => { let d = new Date(12345); return d.getTime() }'), 12345)
  same(run('export let f = () => { let d = new Date(0); return d.valueOf() }'), 0)
  same(run('export let f = () => { let d = new Date(NaN); return d.getTime() }'), NaN)
})

test('Date object: setTime', () => {
  same(run('export let f = () => { let d = new Date(0); d.setTime(999); return d.getTime() }'), 999)
  same(run('export let f = () => { let d = new Date(0); return d.setTime(999) }'), 999)
  same(run('export let f = () => { let d = new Date(0); d.setTime(NaN); return d.getTime() }'), NaN)
  same(run('export let f = () => { let d = new Date(0); d.setTime(8640000000000000); return d.getTime() }'), 8640000000000000)
  same(run('export let f = () => { let d = new Date(0); d.setTime(8640000000000001); return d.getTime() }'), NaN)
})

test('Date object: TimeClip in constructor', () => {
  same(run('export let f = () => { let d = new Date(8640000000000001); return d.getTime() }'), NaN)
  same(run('export let f = () => { let d = new Date(-8640000000000001); return d.getTime() }'), NaN)
})
