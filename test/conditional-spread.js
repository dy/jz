// Conditional-spread schema inference: `{...(cond && {k: v, …})}` (module/
// function.js bodyFn's `...(restParam && { rest: restParam })` idiom, 12
// independent instances in that one literal). resolveSchema/spreadSourceSchema
// (module/object.js) now recognize this shape — conditionalSpreadGroup — so
// the merged schema devirtualizes to a fixed-slot OBJECT instead of a runtime
// HASH (emitDynamicSpread) even though every group's presence is a runtime
// condition. Presence is signaled through the VALUE channel (the UNDEF
// sentinel — module/object.js's undefExpr/isUndef), not a separate presence
// bit: dot-access is unconditionally correct (an absent key already reads
// `undefined` in real JS too); `in`/hasOwnProperty/Object.keys/Object.values/
// Object.entries/for-in are made correct by ROUTING a conditionally-schema'd
// receiver's value-blind "in schema ⇒ present" fast folds (hasOwnProperty's
// literal-key shortcut in module/object.js, `in`'s schemaClosed fold in
// module/collection.js, Object.keys/values/entries/for-in's plain static
// fold) away from that assumption — onto either the pre-existing, already
// value-based dynamic fallback (`in`/hasOwnProperty) or a new compile-time-
// specialized, per-slot value-checked enumerator (Object.keys/values/entries/
// for-in — emitCondAwareEnumerate, module/object.js). JSON.stringify needs no
// change at all: `__json_omit` already drops any UNDEF-valued slot, and real
// JSON.stringify ALSO drops an explicit `x: undefined` property — the two
// presence models are indistinguishable on this one surface by construction.
//
// Every differential test below runs the JZ source and an IDENTICAL native
// JS closure side by side and compares results — the JS subset is valid JS,
// so the native closure IS the oracle (colorjs.io-style differential
// discipline: no hand-picked expected values for anything V8 can just answer).
import test from 'tst'
import { is } from 'tst/assert.js'
import jz from '../index.js'

// Compiles `src` at BOTH optimize 0 and optimize 3, runs `native` beside each,
// and asserts every call in `argsList` agrees — the differential vs V8 the
// task's own gate requires, pinned at both ends of the optimizer range so a
// pass that folds/moves the runtime branch can't quietly break presence.
function differential(src, native, argsList, label = '') {
  for (const optimize of [0, 3]) {
    const { f } = jz(src, { optimize }).exports
    for (const args of argsList) {
      const got = f(...args)
      const want = native(...args)
      is(got, want, `${label} optimize=${optimize} f(${args.join(',')})`)
    }
  }
}

// ============================================================================
// Dot-access: unconditionally correct (the primary devirtualization win —
// present reads the real value, absent reads `undefined`, exactly matching
// a genuinely-missing JS property read).
// ============================================================================

test('conditional-spread: dot-access reads real value when present, undefined when absent', () => {
  const src = `
    export let f = (cond) => {
      const o = { a: 1, ...(cond && { b: 2 }) }
      return o.b
    }
  `
  differential(src,
    (cond) => { const o = { a: 1, ...(cond && { b: 2 }) }; return o.b },
    [[1], [0]], 'dot-access')
})

test('conditional-spread: base props read correctly alongside a conditional group', () => {
  const src = `
    export let f = (cond) => {
      const o = { a: 1, c: 3, ...(cond && { b: 2 }) }
      return o.a + o.c
    }
  `
  differential(src,
    (cond) => { const o = { a: 1, c: 3, ...(cond && { b: 2 }) }; return o.a + o.c },
    [[1], [0]], 'base-props')
})

// ============================================================================
// Truthy/falsy conditions — every JS falsy value, not just `false`. `&&` is
// value-preserving (a falsy left operand surfaces AS-IS), so the runtime
// presence test must be "is the result a genuine object", never a specific
// sentinel-bits compare.
// ============================================================================

test('conditional-spread: every falsy condition kind yields absent, every truthy kind yields present', () => {
  const src = `
    export let f = (cond) => {
      const o = { a: 1, ...(cond && { b: 2 }) }
      return o.hasOwnProperty('b') ? 1 : 0
    }
  `
  const { f } = jz(src).exports
  // falsy: false, 0, '', null, undefined, NaN
  is(f(false), 0, 'false')
  is(f(0), 0, '0')
  is(f(''), 0, 'empty string')
  is(f(null), 0, 'null')
  is(f(undefined), 0, 'undefined')
  is(f(NaN), 0, 'NaN')
  // truthy: true, 1, 'x', {}, [], -1
  is(f(true), 1, 'true')
  is(f(1), 1, '1')
  is(f('x'), 1, 'non-empty string')
  is(f(-1), 1, '-1 (truthy number)')
})

// ============================================================================
// Presence semantics: 'in', hasOwnProperty, Object.keys/values/entries,
// JSON.stringify, for-in — differential vs native JS, truthy and falsy.
// ============================================================================

test('conditional-spread: `in` operator matches native for both branches', () => {
  const src = `
    export let f = (cond) => {
      const o = { a: 1, ...(cond && { b: 2 }) }
      return ('b' in o) ? 1 : 0
    }
  `
  differential(src,
    (cond) => (('b' in { a: 1, ...(cond && { b: 2 }) }) ? 1 : 0),
    [[1], [0]], 'in-operator')
})

test('conditional-spread: hasOwnProperty matches native for both branches', () => {
  const src = `
    export let f = (cond) => {
      const o = { a: 1, ...(cond && { b: 2 }) }
      return o.hasOwnProperty('b') ? 1 : 0
    }
  `
  differential(src,
    (cond) => ({ a: 1, ...(cond && { b: 2 }) }.hasOwnProperty('b') ? 1 : 0),
    [[1], [0]], 'hasOwnProperty')
})

test('conditional-spread: Object.keys matches native for both branches', () => {
  const src = `
    export let f = (cond) => {
      const o = { a: 1, ...(cond && { b: 2 }) }
      return Object.keys(o).join(',')
    }
  `
  differential(src,
    (cond) => Object.keys({ a: 1, ...(cond && { b: 2 }) }).join(','),
    [[1], [0]], 'Object.keys')
})

test('conditional-spread: Object.values matches native for both branches', () => {
  const src = `
    export let f = (cond) => {
      const o = { a: 1, ...(cond && { b: 2 }) }
      return Object.values(o).join(',')
    }
  `
  differential(src,
    (cond) => Object.values({ a: 1, ...(cond && { b: 2 }) }).join(','),
    [[1], [0]], 'Object.values')
})

test('conditional-spread: Object.entries matches native for both branches', () => {
  const src = `
    export let f = (cond) => {
      const o = { a: 1, ...(cond && { b: 2 }) }
      return Object.entries(o).map(e => e[0] + '=' + e[1]).join(',')
    }
  `
  differential(src,
    (cond) => Object.entries({ a: 1, ...(cond && { b: 2 }) }).map(e => e[0] + '=' + e[1]).join(','),
    [[1], [0]], 'Object.entries')
})

test('conditional-spread: JSON.stringify matches native for both branches', () => {
  const src = `
    export let f = (cond) => {
      const o = { a: 1, ...(cond && { b: 2 }) }
      return JSON.stringify(o)
    }
  `
  differential(src,
    (cond) => JSON.stringify({ a: 1, ...(cond && { b: 2 }) }),
    [[1], [0]], 'JSON.stringify')
})

test('conditional-spread: for-in matches native for both branches', () => {
  const src = `
    export let f = (cond) => {
      const o = { a: 1, ...(cond && { b: 2 }) }
      let out = ''
      for (const k in o) out += k
      return out
    }
  `
  differential(src,
    (cond) => { const o = { a: 1, ...(cond && { b: 2 }) }; let out = ''; for (const k in o) out += k; return out },
    [[1], [0]], 'for-in')
})

test('conditional-spread: for-in that ALSO reads `o[k]` inside its own loop body matches native (regression: computed READ must not fall back to the value-blind enumerator)', () => {
  // Found live: emitKeysGeneric's dyn-props gate used mayHaveDynProps (which
  // dynKeyVars flags for a computed READ, not just a WRITE), so `o[k]` inside
  // the SAME for-in loop that enumerates `o` routed key enumeration off the
  // cond-aware fast path and onto the fully value-blind runtime fallback —
  // wrongly counting an absent conditional slot. Fixed by narrowing the
  // cond-aware branch's gate to dynWriteVars (write-only), matching
  // __keys_ro's own pre-existing identical narrowing one function up.
  const src = `
    export let f = (cond) => {
      const o = { a: 1, ...(cond && { b: 2 }), c: 3 }
      let sum = 0
      for (const k in o) sum += o[k]
      return sum
    }
  `
  differential(src,
    (cond) => {
      const o = { a: 1, ...(cond && { b: 2 }), c: 3 }
      let sum = 0
      for (const k in o) sum += o[k]
      return sum
    },
    [[1], [0]], 'for-in-with-read')
})

// ============================================================================
// Nested / chained conditional spreads.
// ============================================================================

test('conditional-spread: chained guard `a && (b && {...})` matches native across all 4 branches', () => {
  const src = `
    export let f = (a, b) => {
      const o = { x: 1, ...(a && (b && { y: 2 })) }
      return Object.keys(o).join(',') + '|' + (o.y === undefined ? 'u' : o.y)
    }
  `
  const native = (a, b) => {
    const o = { x: 1, ...(a && (b && { y: 2 })) }
    return Object.keys(o).join(',') + '|' + (o.y === undefined ? 'u' : o.y)
  }
  differential(src, native, [[1,1],[1,0],[0,1],[0,0]], 'chained')
})

test('conditional-spread: multiple independent conditional groups (bodyFn shape) match native across all 8 branches', () => {
  const src = `
    export let f = (c1, c2, c3) => {
      const o = {
        name: 'fn',
        ...(c1 && { rest: 'R' }),
        ...(c2 && { defaults: 'D' }),
        ...(c3 && { boxed: 'B' }),
      }
      return Object.keys(o).join(',')
    }
  `
  const native = (c1, c2, c3) => {
    const o = {
      name: 'fn',
      ...(c1 && { rest: 'R' }),
      ...(c2 && { defaults: 'D' }),
      ...(c3 && { boxed: 'B' }),
    }
    return Object.keys(o).join(',')
  }
  const bits = [0, 1]
  const argsList = bits.flatMap(c1 => bits.flatMap(c2 => bits.map(c3 => [c1, c2, c3])))
  differential(src, native, argsList, 'multi-group')
})

test('conditional-spread: nested object VALUE inside a conditional group (not itself a spread)', () => {
  const src = `
    export let f = (cond) => {
      const o = { a: 1, ...(cond && { b: { inner: 5 } }) }
      return o.b === undefined ? -1 : o.b.inner
    }
  `
  differential(src,
    (cond) => { const o = { a: 1, ...(cond && { b: { inner: 5 } }) }; return o.b === undefined ? -1 : o.b.inner },
    [[1], [0]], 'nested-value')
})

// ============================================================================
// Shorthand property form — `{...(cond && {x})}`, the exact shape named in
// the task's own verification requirement.
// ============================================================================

test('conditional-spread: shorthand property `{...(cond && {x})}` matches native exactly', () => {
  const src = `
    export let f = (cond) => {
      const x = 7
      const o = { a: 1, ...(cond && { x }) }
      return JSON.stringify(o) + '|' + ('x' in o ? 1 : 0) + '|' + Object.keys(o).length
    }
  `
  const native = (cond) => {
    const x = 7
    const o = { a: 1, ...(cond && { x }) }
    return JSON.stringify(o) + '|' + ('x' in o ? 1 : 0) + '|' + Object.keys(o).length
  }
  differential(src, native, [[1], [0]], 'shorthand')
})

// ============================================================================
// Collision fallback: a conditional group's key clashing with another
// prop/source must bail to the dynamic path (mergeSpreadNames' collision
// bail) — still fully correct, simply not devirtualized. Differential proves
// correctness; it does not (and cannot from the outside) prove which codegen
// path fired.
// ============================================================================

test('conditional-spread: a key claimed by both a base prop and a conditional group stays correct (collision bail)', () => {
  const src = `
    export let f = (cond) => {
      const o = { a: 1, ...(cond && { a: 2 }) }
      return Object.keys(o).join(',') + '|' + o.a
    }
  `
  differential(src,
    (cond) => { const o = { a: 1, ...(cond && { a: 2 }) }; return Object.keys(o).join(',') + '|' + o.a },
    [[1], [0]], 'collision')
})

test('conditional-spread: two conditional groups claiming the same key stays correct (collision bail)', () => {
  const src = `
    export let f = (c1, c2) => {
      const o = { base: 0, ...(c1 && { x: 1 }), ...(c2 && { x: 2 }) }
      return Object.keys(o).join(',') + '|' + o.x
    }
  `
  const native = (c1, c2) => {
    const o = { base: 0, ...(c1 && { x: 1 }), ...(c2 && { x: 2 }) }
    return Object.keys(o).join(',') + '|' + o.x
  }
  differential(src, native, [[1,1],[1,0],[0,1],[0,0]], 'double-collision')
})

// ============================================================================
// Re-spread of an already-conditionally-schema'd binding: mergeSpreadNames
// bails (documented boundary — see module/object.js conditionalSpreadGroup)
// rather than silently losing the "maybe absent" fact one hop out. Must
// still be fully CORRECT, just via the dynamic path.
// ============================================================================

test('conditional-spread: re-spreading an already-conditional object stays correct', () => {
  const src = `
    export let f = (cond) => {
      const o = { a: 1, ...(cond && { b: 2 }) }
      const p = { ...o, c: 3 }
      return Object.keys(p).join(',') + '|' + (p.b === undefined ? 'u' : p.b)
    }
  `
  differential(src,
    (cond) => {
      const o = { a: 1, ...(cond && { b: 2 }) }
      const p = { ...o, c: 3 }
      return Object.keys(p).join(',') + '|' + (p.b === undefined ? 'u' : p.b)
    },
    [[1], [0]], 're-spread')
})

test('conditional-spread: Object.assign copies exactly the runtime-present keys', () => {
  // Conditional groups lower to HASH so source enumeration carries a real
  // presence bit. Object.assign's unknown-source path updates the target
  // sidecar and marks the target's later enumeration dynamic.
  const src = `
    export let f = (cond) => {
      const o = { a: 1, ...(cond && { b: 2 }) }
      const target = { c: 3 }
      Object.assign(target, o)
      return (target.b === undefined ? 1 : 0) + ',' + Object.keys(target).length
    }
  `
  const { f } = jz(src, { optimize: 0 }).exports
  const native = (cond) => {
    const o = { a: 1, ...(cond && { b: 2 }) }
    const target = { c: 3 }
    Object.assign(target, o)
    return (target.b === undefined ? 1 : 0) + ',' + Object.keys(target).length
  }
  is(f(1), native(1), 'truthy: value AND key count both match native (source genuinely has b)')
  is(f(0), native(0), 'falsy: absent key is not copied or enumerated')
})

test('conditional-spread: present undefined remains distinct from an absent group', () => {
  const src = `
    export let f = () => {
      const o = { a: 1, ...(true && { b: undefined }) }
      return (o.b === undefined ? 1 : 0) + ',' + ('b' in o ? 1 : 0) + ',' + Object.keys(o).length
    }
  `
  const { f } = jz(src).exports
  is(f(), '1,1,2', 'dot access, in, and enumeration agree on presence')
  is(({ a: 1, ...(true && { b: undefined }) }.b === undefined ? 1 : 0) + ',' +
     ('b' in { a: 1, ...(true && { b: undefined }) } ? 1 : 0) + ',' +
     Object.keys({ a: 1, ...(true && { b: undefined }) }).length, '1,1,2', 'native reference value, for contrast')
})

// ============================================================================
// optimize 0 / optimize 3 parity — folded/const-propagated conditions must
// still branch correctly (the runtime `__ptr_type` presence check must
// survive whatever the optimizer does to a provably-constant condition).
// ============================================================================

test('conditional-spread: compile-time-constant truthy/falsy conditions match native at optimize 0 and 3', () => {
  for (const optimize of [0, 3]) {
    const { fTrue, fFalse } = jz(`
      export let fTrue = () => {
        const o = { a: 1, ...(true && { b: 2 }) }
        return Object.keys(o).join(',')
      }
      export let fFalse = () => {
        const o = { a: 1, ...(false && { b: 2 }) }
        return Object.keys(o).join(',')
      }
    `, { optimize }).exports
    is(fTrue(), Object.keys({ a: 1, ...(true && { b: 2 }) }).join(','), `const-true optimize=${optimize}`)
    is(fFalse(), Object.keys({ a: 1, ...(false && { b: 2 }) }).join(','), `const-false optimize=${optimize}`)
  }
})
