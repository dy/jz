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

test('Date object: no-arg constructor uses current time', () => {
  const before = Date.now()
  const actual = run('export let f = () => { let d = new Date(); return d.getTime() }')
  const after = Date.now()
  ok(actual >= before && actual <= after)
})

test('Date object: date-only string constructor', () => {
  same(run('export let f = () => { let d = new Date("2024-06-05"); return d.getTime() }'), Date.UTC(2024, 5, 5))
  same(run('export let f = () => { let d = new Date("2024-06-05"); return d.getUTCDay() }'), 3)
  same(run('export let f = () => { let d = new Date("not a date"); return d.getTime() }'), NaN)
})

test('Date object: multi-arg constructor uses UTC-backed fields', () => {
  same(run('export let f = () => { let d = new Date(2025, 0, 15, 10, 30); return d.getTime() }'), Date.UTC(2025, 0, 15, 10, 30))
  same(run('export let f = () => { let d = new Date(70, 0, 1); return d.getTime() }'), Date.UTC(70, 0, 1))
})

test('Date UTC getters', () => {
  const r = run(`export let f = () => {
    let d = new Date(Date.UTC(2025, 0, 15, 10, 30, 45, 123))
    return [
      d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCDay(),
      d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()
    ]
  }`)
  same(r[0], 2025)
  same(r[1], 0)
  same(r[2], 15)
  same(r[3], 3)
  same(r[4], 10)
  same(r[5], 30)
  same(r[6], 45)
  same(r[7], 123)
})

test('Date UTC getters: NaN date', () => {
  const r = run(`export let f = () => {
    let d = new Date(NaN)
    return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCDay()]
  }`)
  ok(Number.isNaN(r[0]))
  ok(Number.isNaN(r[1]))
  ok(Number.isNaN(r[2]))
  ok(Number.isNaN(r[3]))
})

test('Date local getters: UTC-backed aliases', () => {
  const r = run(`export let f = () => {
    let d = new Date(Date.UTC(2025, 0, 15, 10, 30, 45, 123))
    return [d.getFullYear(), d.getMonth(), d.getDate(), d.getDay()]
  }`)
  same(r[0], 2025)
  same(r[1], 0)
  same(r[2], 15)
  same(r[3], 3)
})

test('Date object: relational comparison uses time value', () => {
  same(run('export let f = () => { let a = new Date(0); let b = new Date(1); return a < b ? 1 : 0 }'), 1)
  same(run('export let f = () => { let a = new Date(2); let b = new Date(1); return a > b ? 1 : 0 }'), 1)
})

test('Date UTC setters: time components', () => {
  const r = run(`export let f = () => {
    let d = new Date(Date.UTC(2025, 0, 15, 10, 30, 45, 123))
    let ret = d.setUTCHours(5)
    let h = d.getUTCHours()
    d.setUTCMinutes(15)
    let m = d.getUTCMinutes()
    d.setUTCSeconds(30)
    let s = d.getUTCSeconds()
    d.setUTCMilliseconds(500)
    let ms = d.getUTCMilliseconds()
    return [ret, h, m, s, ms]
  }`)
  same(r[0], Date.UTC(2025, 0, 15, 5, 30, 45, 123))
  same(r[1], 5)
  same(r[2], 15)
  same(r[3], 30)
  same(r[4], 500)
})

test('Date UTC setters: date components', () => {
  const r = run(`export let f = () => {
    let d = new Date(Date.UTC(2025, 0, 15, 10, 30, 45, 123))
    d.setUTCDate(20)
    let day = d.getUTCDate()
    d.setUTCMonth(5)
    let m = d.getUTCMonth()
    d.setUTCFullYear(2030)
    let y = d.getUTCFullYear()
    return [day, m, y]
  }`)
  same(r[0], 20)
  same(r[1], 5)
  same(r[2], 2030)
})

test('Date UTC setters: optional args and defaults', () => {
  const r = run(`export let f = () => {
    let d = new Date(Date.UTC(2025, 0, 15, 10, 30, 45, 123))
    d.setUTCHours(5, 15)
    return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()]
  }`)
  same(r[0], 5)
  same(r[1], 15)
  same(r[2], 45)
  same(r[3], 123)
})

test('Date UTC setters: setUTCFullYear resets NaN to 0', () => {
  const r = run(`export let f = () => {
    let d = new Date(NaN)
    d.setUTCFullYear(2025)
    return [d.getTime(), d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]
  }`)
  same(r[0], Date.UTC(2025, 0, 1, 0, 0, 0, 0))
  same(r[1], 2025)
  same(r[2], 0)
  same(r[3], 1)
})

test('Date UTC setters: NaN propagation', () => {
  same(run('export let f = () => { let d = new Date(0); return d.setUTCHours(NaN) }'), NaN)
  same(run('export let f = () => { let d = new Date(0); d.setUTCHours(NaN); return d.getTime() }'), NaN)
})

test('Date toISOString', () => {
  same(run('export let f = () => { let d = new Date(Date.UTC(2025, 0, 15, 10, 30, 45, 123)); return d.toISOString() }'), '2025-01-15T10:30:45.123Z')
  same(run('export let f = () => { let d = new Date(0); return d.toISOString() }'), '1970-01-01T00:00:00.000Z')
  same(run('export let f = () => { let d = new Date(NaN); return d.toISOString() }'), '')
})

test('Date toUTCString', () => {
  same(run('export let f = () => { let d = new Date(Date.UTC(2025, 0, 15, 10, 30, 45, 0)); return d.toUTCString() }'), 'Wed, 15 Jan 2025 10:30:45 GMT')
  same(run('export let f = () => { let d = new Date(0); return d.toUTCString() }'), 'Thu, 01 Jan 1970 00:00:00 GMT')
  same(run('export let f = () => { let d = new Date(NaN); return d.toUTCString() }'), '')
})

test('Date toUTCString: leap year', () => {
  same(run('export let f = () => { let d = new Date(Date.UTC(2024, 1, 29, 0, 0, 0, 0)); return d.toUTCString() }'), 'Thu, 29 Feb 2024 00:00:00 GMT')
})
