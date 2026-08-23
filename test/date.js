import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz from '../index.js'
import { onWasi } from './_matrix.js'

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

test('Date.parse: date strings', () => {
  same(run('export let f = () => Date.parse("2024-01-01T00:00:00Z")'), 1704067200000)
  same(run('export let f = () => Date.parse("2024-06-05")'), Date.UTC(2024, 5, 5))
  same(run('export let f = () => Date.parse("not a date")'), NaN)
})

test('Date object: getTime and valueOf', () => {
  same(run('export let f = () => { let d = new Date(0); return d.getTime() }'), 0)
  same(run('export let f = () => { let d = new Date(12345); return d.getTime() }'), 12345)
  same(run('export let f = () => { let d = new Date(0); return d.valueOf() }'), 0)
  same(run('export let f = () => { let d = new Date(NaN); return d.getTime() }'), NaN)
})

test('Date object: proven-receiver .valueOf()/.getTime() compares correctly against a NUMBER literal', () => {
  // kind-traits.js methodValType's `.valueOf() -> receiver kind` rule is
  // right for every OTHER type (jz's valueOf is a receiver passthrough,
  // module/string.js) but wrong for Date: `.valueOf()` returns the
  // timestamp, a NUMBER, never the receiver. Pre-existing and independent of
  // the unresolved-dispatch pins below — a PROVEN Date never reaches the
  // unresolved path at all (tryStaticDispatch's `.date:valueOf` dispatches
  // it directly) — so `d.valueOf() === n` folded unsound (false) even for a
  // fully statically-known Date, on EVERY optimize level, until
  // kind-traits.js's own VAL.DATE carve-out landed.
  is(run('export let f = () => { let d = new Date(1234567890000); return d.valueOf() === 1234567890000 }'), true)
  is(run('export let f = () => { let d = new Date(1234567890000); return d.getTime() === 1234567890000 }'), true)
})

test('Date object: unresolved-vt receiver .valueOf() discriminates Date from plain object/array (.work/printer-trio.md residual)', () => {
  // The printer-trio fix (module/date.js) deleted date.js's flat `.valueOf`
  // override so every OTHER unresolved-type receiver's `.valueOf()` stopped
  // reading garbage (array[0]'s bits as f64) — but left an
  // unresolved-but-ACTUALLY-Date receiver undiscriminated: `.valueOf()` fell
  // through to string.js's identity fallback (the Date itself, not its
  // timestamp). Date shares PTR.OBJECT's coarse tag with plain
  // objects/arrays, so a runtime ptr-TYPE fork alone can't tell them apart —
  // the fix (emit.js dateAuxFallback, wired into both trySidecarToPrimitive
  // and tryRuntimePtrTypeFork) additionally tests the receiver's own `aux`
  // field against ctx.schema.dateSid (a schema registered under a
  // NUL-prefixed property name, `'\x00time'`, no real object literal can
  // ever alias — a sound, cheap discriminator, no extra heap load beyond the
  // existing `$__ptr_type` read).
  //
  // Heterogeneous-array-element shape, mirroring the ORIGINAL kernel-parity
  // repro exactly (watr's print.js `node[i]?.valueOf?.()`): vt is genuinely
  // unresolved at every optimize level, immune to inlining resolving the
  // ambiguity away (a single named-function call site, by contrast, can get
  // specialized per call site once inlined — see the pin below for that
  // shape instead).
  const src = `
    export let f = (which) => {
      let items = [new Date(1234567890000), {}, [7, 8, 9]]
      let x = items[which]
      return x.valueOf()
    }
    export let isIdentity = (which) => {
      let items = [new Date(1234567890000), {}, [7, 8, 9]]
      let x = items[which]
      return x.valueOf() === x
    }
  `
  const { exports: e } = jz(src)
  is(e.f(0), 1234567890000, 'unresolved-but-actually-Date: valueOf() returns the timestamp, not identity')
  is(e.isIdentity(1), true, 'unresolved-but-actually-object: valueOf() still returns identity')
  is(e.isIdentity(2), true, 'unresolved-but-actually-array: valueOf() still returns identity')
})

test('Date object: unresolved-vt receiver .valueOf() via a shared dispatch function', () => {
  // Same discrimination, named-helper-function shape: a function called with
  // BOTH a Date and a plain object at different call sites keeps its
  // parameter's vt genuinely unresolved inside the function body. This
  // specific shape reaches trySidecarToPrimitive (the ctx.closure.call-gated
  // fork that runs AHEAD of tryRuntimePtrTypeFork whenever the compiled
  // program has any function at all — the common case) rather than
  // tryRuntimePtrTypeFork itself, so both forks needed the same aux guard.
  const src = `
    function unresolvedValueOf(x) { return x.valueOf() }
    export let f = () => {
      let d = new Date(1234567890000)
      let o = {}
      return unresolvedValueOf(d) === 1234567890000 && unresolvedValueOf(o) === o
    }
  `
  is(jz(src).exports.f(), true)
})

test('Date object: unresolved .getTime() discriminates Date and rejects non-Date receivers', () => {
  const src = `
    export let f = (which) => {
      let items = [new Date(1234567890000), [111, 222, 333]]
      let x = items[which]
      return x.getTime()
    }
  `
  for (const optimize of [false, 2, 3]) {
    const { exports: e } = jz(src, { optimize })
    is(e.f(0), 1234567890000, `O${optimize || 0}: unresolved runtime Date takes the aux-discriminated emitter`)
    throws(() => e.f(1), err => err instanceof TypeError, `O${optimize || 0}: unresolved runtime array throws instead of reading element 0`)
  }
})

test('Date object: guarded no-arg Date methods preserve ignored argument effects', () => {
  const src = `
    let n = 0
    function bump() { n = n + 1; return 7 }
    export let f = (which) => {
      let items = [new Date(1234567890000), [111, 222, 333], null]
      let x = items[which]
      try { x.getTime(bump()) } catch (e) {}
      return n
    }
  `
  for (const optimize of [false, 2, 3]) {
    const { f } = jz(src, { optimize }).exports
    is(f(0), 1, `O${optimize || 0}: Date branch evaluates ignored args once`)
    is(f(1), 2, `O${optimize || 0}: non-callable branch evaluates args before throwing`)
    is(f(2), 2, `O${optimize || 0}: nullish property read throws before evaluating args`)

    const proven = jz(`let n = 0; function bump() { n++; return 1 }
      export let f = () => { let d = new Date(0); d.getTime(bump()); return n }`, { optimize }).exports
    is(proven.f(), 1, `O${optimize || 0}: statically-proven Date also evaluates ignored args once`)

    const spread = jz(`let n = 0; function bump() { n++; return 1 }
      export let f = () => { let d = new Date(0); d.getTime(...[bump()]); return n }`, { optimize }).exports
    is(spread.f(), 1, `O${optimize || 0}: ignored spread is iterated once`)
  }
})

test('Date object: every zero-arg Date-only flat emitter uses the aux guard', () => {
  const src = `export let f = (which) => {
    let items = [new Date(0), [2024]]
    let x = items[which]
    return x.getUTCFullYear()
  }`
  const { f } = jz(src).exports
  is(f(0), 1970)
  throws(() => f(1), err => err instanceof TypeError)
})

test('Date object: unresolved host Date falls through to external method dispatch', () => {
  if (onWasi()) return
  const { f } = jz('export let f = x => x.getTime()').exports
  is(f(new Date(321)), 321)
})

test('Date object: unresolved argument-taking Date methods preserve args and discriminate', () => {
  throws(() => jz.compile('export let f = (x, args) => x.setTime(...args)'),
    /Spread arguments on Date method \.setTime/, 'dynamic setter spread rejects instead of guessing optional-argument arity')
  const src = `export let f = (which, n) => {
    let items = [new Date(0), [111]]
    let x = items[which]
    return x.setTime(n)
  }`
  for (const optimize of [false, 2, 3]) {
    const { f } = jz(src, { optimize }).exports
    is(f(0, 999), 999, `O${optimize || 0}: runtime Date setter receives its argument`)
    throws(() => f(1, 999), err => err instanceof TypeError,
      `O${optimize || 0}: non-Date setter receiver throws after argument evaluation`)
  }
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
  // On wasi the wasm reads `clock_time_get` — a different clock from the host's
  // Date.now() — and the skew between them can exceed this µs-scale bracket, so
  // sanity-check a plausible current epoch-ms (≈2024–2096) instead. On the JS host
  // both sides share one clock, so the exact bracket holds.
  if (onWasi()) ok(actual > 1.7e12 && actual < 4e12)
  else ok(actual >= before && actual <= after)
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

test('Date UTC full year compile includes transitive date helpers', () => {
  ok(jz.compile('export let f = () => new Date(0).getUTCFullYear()'))
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

test('Date local time getters: UTC-backed aliases', () => {
  const r = run(`export let f = () => {
    let d = new Date(Date.UTC(2025, 0, 15, 10, 30, 45, 123))
    return [d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]
  }`)
  same(r[0], 10)
  same(r[1], 30)
  same(r[2], 45)
  same(r[3], 123)
})

test('Date local time getters: epoch zero does not throw', () => {
  same(run('export let f = () => { let d = new Date(0); return d.getHours() }'), 0)
  same(run('export let f = () => { let d = new Date(0); return d.getUTCHours() }'), 0)
  same(run('export let f = () => { let d = new Date(0); return d.getMinutes() }'), 0)
  same(run('export let f = () => { let d = new Date(0); return d.getSeconds() }'), 0)
  same(run('export let f = () => { let d = new Date(0); return d.getMilliseconds() }'), 0)
})

test('Date local time getters: NaN date propagates NaN', () => {
  const r = run(`export let f = () => {
    let d = new Date(NaN)
    return [d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]
  }`)
  ok(Number.isNaN(r[0]))
  ok(Number.isNaN(r[1]))
  ok(Number.isNaN(r[2]))
  ok(Number.isNaN(r[3]))
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

test('Date toISOString: expanded years (sign + 6 digits)', () => {
  // spec DateString: years outside [0, 9999] carry an explicit sign and 6-digit padding
  same(run('export let f = () => new Date(8640000000000000).toISOString()'), '+275760-09-13T00:00:00.000Z')
  same(run('export let f = () => new Date(-8640000000000000).toISOString()'), '-271821-04-20T00:00:00.000Z')
  same(run('export let f = () => new Date(Date.UTC(-1, 11, 31, 23, 59, 59, 999)).toISOString()'), '-000001-12-31T23:59:59.999Z')
})

test('Date toJSON', () => {
  same(run('export let f = () => { let d = new Date(Date.UTC(2025, 0, 15, 10, 30, 45, 123)); return d.toJSON() }'), '2025-01-15T10:30:45.123Z')
  same(run('export let f = () => new Date(NaN).toJSON()'), null)
  same(run('export let f = () => JSON.stringify(new Date(NaN).toJSON())'), 'null')
})

test('Date toDateString / toTimeString', () => {
  same(run('export let f = () => new Date(Date.UTC(2025, 0, 15, 10, 30, 45, 123)).toDateString()'), 'Wed Jan 15 2025')
  same(run('export let f = () => new Date(Date.UTC(2025, 0, 5)).toDateString()'), 'Sun Jan 05 2025')
  same(run('export let f = () => new Date(8640000000000000).toDateString()'), 'Sat Sep 13 275760')
  same(run('export let f = () => new Date(Date.UTC(-1, 11, 31)).toDateString()'), 'Fri Dec 31 -0001')
  same(run('export let f = () => new Date(NaN).toDateString()'), 'Invalid Date')
  same(run('export let f = () => new Date(Date.UTC(2025, 0, 15, 10, 30, 45, 123)).toTimeString()'), '10:30:45 GMT+0000 (Coordinated Universal Time)')
  same(run('export let f = () => new Date(0).toTimeString()'), '00:00:00 GMT+0000 (Coordinated Universal Time)')
  same(run('export let f = () => new Date(NaN).toTimeString()'), 'Invalid Date')
})
