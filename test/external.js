import test from 'tst'
import { is, ok, throws } from 'tst/assert.js'
import jz, { compile } from '../index.js'
import { onWasi } from './_matrix.js'

// Helper: compile and run
function run(code, imports = {}) {
  return jz(code, { ...imports }).exports
}

test('Read property from external object', () => {
  if (onWasi()) return  // wasi: external object
  const { getProp } = run(`
    export const getProp = (obj) => {
      return obj.nodeType
    }
  `)

  const mockNode = { nodeType: 1, nodeName: 'DIV' }
  // JZ returns floats or pointers, so we might not be able to just pass 'mockNode' cleanly unless the test sets up externref or something.
  is(getProp(mockNode), 1)
})

test('Read property from external object via literal bracket key', () => {
  if (onWasi()) return  // wasi: external object
  // Regression: `obj['nodeType']` IS `obj.nodeType` — both must reach the
  // host-external read path. The `[]` emitter used to fall to `__dyn_get`
  // (internal HASH only, no external support), so a literal-key bracket read
  // on a host object silently returned undefined while dot access worked.
  const { getDot, getBracket } = run(`
    export const getDot = (obj) => obj.nodeType
    export const getBracket = (obj) => obj['nodeType']
  `)
  const mockNode = { nodeType: 1, nodeName: 'DIV' }
  is(getDot(mockNode), 1, 'dot access (control)')
  is(getBracket(mockNode), 1, 'literal-key bracket access must match dot')
})

test('Read nested property from external object via bracket keys', () => {
  if (onWasi()) return  // wasi: external object
  const { f } = run(`
    export const f = (obj) => obj['a']['b']
  `)
  is(f({ a: { b: 42 } }), 42, 'chained literal-key bracket reads match dot chain')
})

test('Literal-key bracket on a primitive arg stays undefined (no narrowing)', () => {
  if (onWasi()) return
  // The delegation must preserve polymorphism: a number/string receiver has no
  // such property → undefined, NOT a reinterpret of its bits as an object pointer.
  const { f } = run(`export const f = (x) => x['foo']`)
  is(f(42), undefined, 'number arg → undefined')
  is(f({ foo: 7 }), 7, 'object arg → property value')
})

test('Call method on external object', () => {
  if (onWasi()) return  // wasi: external object
  const { callMethod } = run(`
    export const callMethod = (obj) => {
      return obj.getAttribute('id').length
    }
  `)

  const mockNode = { 
    id: 'main',
    getAttribute(name) { return this[name] }
  }
  is(callMethod(mockNode), 4)
})

test('Set property on external object', () => {
  if (onWasi()) return  // wasi: external object
  const { setProp } = run(`
    export const setProp = (obj, val) => {
      obj.innerHTML = val
    }
  `)

  const mockNode = { innerHTML: '' }
  setProp(mockNode, 'Hello')
  is(mockNode.innerHTML, 'Hello')
})

test('Return external object from JZ', () => {
  if (onWasi()) return  // wasi: external object
  const instance = jz(`
    export const createNode = (doc) => {
      return doc.createElement('div')
    }
  `)
  const mockDoc = {
    createElement(name) { return { nodeName: name.toUpperCase() } }
  }
  const divPtr = instance.exports.createNode(mockDoc)
  const div = instance.memory.read(divPtr)
  is(div.nodeName, 'DIV')
})

// An indexed write through a dynamic property chain on an EXTERNAL object —
// `o.field[i] = v` where `o` is a plain host object passed as an argument — was a
// silent no-op: each `.field` read materializes an independent copy (`__ext_prop`
// → interop.js `wrapVal` deep-copies a container into fresh wasm memory — no
// identity preserved with the host), so the index-store mutated a copy nobody
// kept — the host object's actual property was never touched. Whole-field
// reassignment (`o.field = arr`) and scalar field writes (`o.gain = v`) worked
// correctly (a direct, non-indexed property SET, not a read-then-mutate). NOT
// the same root cause as the superficially similar "typedArray.set() into a
// dynamically-added struct field" no-op (test/array-methods.js, a DISPATCH gap —
// vt-unknown receivers never reached ANY `.typed:*` emitter at all) — this one is
// a marshaling-identity gap, fixed differently: emitElementAssign
// (src/compile/emit-assign.js) now special-cases `obj.prop[idx] = val` when
// `obj`'s type is unresolved — performs the normal (copy-based) element write,
// then writes the resulting (possibly-relocated) container back onto the SAME
// property via `__hash_set`, whose existing type guard already dispatches
// EXTERNAL receivers to `__ext_set` (and is a same-pointer no-op for a genuinely
// native OBJECT/HASH receiver, whose property read was never a copy to begin
// with). `mem.read` (interop.js) already recursively decodes an ARRAY pointer
// back into a real JS array, so the round-trip is correct including one level of
// array-of-arrays nesting (see test/objects.js's two sibling fixes, same root
// cause). Live instance: noise-reduction/deplosive.js `params._lfDetS[0] = lfEnv`
// — envelope-detector state never survived a streaming chunk boundary, silently
// restarting from zero each call.
test('indexed write through an external-object field persists', () => {
  if (onWasi()) return  // wasi: external object
  const { step } = run(`
    export const step = (o) => {
      if (!o._s) o._s = [0, 0]
      let v = o._s[0] + 21
      o._s[0] = v
      return v
    }
  `)
  const o = {}
  is(step(o), 21)
  is(step(o), 42)  // must see persisted o._s[0] = 21 from the first call
  is(o._s[0], 42)  // and the host-side object must hold the written value
})

// A typed array stored onto an EXTERNAL object was a LIVE VIEW into the module's
// own linear memory, not a host-owned copy (interop.js `mem.read`'s TYPED branch:
// `new Ctor(mem.buffer, off, len)`). When a later call grows memory (the bump
// allocator never frees), Memory.grow() detaches the old ArrayBuffer; the next
// read-back of that field re-marshaled the stale view and jz's fast-path bulk copy
// threw a raw uncaught TypeError ("...detached ArrayBuffer"). Real hazard for any
// streaming DSP that stashes typed-array state on a params object across chunks
// (noise-reduction gate.js `params._lab` — crashes on the call where cumulative
// allocation first crosses a page). Fixed narrowly at `__ext_set` (interop.js) —
// NOT in `mem.read` itself, which stays a live view for its other callers (a
// function-return-value peek, or explicit `instance.memory.read(ptr)`, where a
// live view is the documented, intentional behavior — test/external.js's own
// "Return external object from JZ" above relies on it). `__ext_set` specifically
// persists onto a REAL, long-lived host object property, so it now `.slice()`s
// any decoded TypedArray view into an independent, host-owned copy before
// storing it — TypedArray's own same-ctor copy, exactly `new Ctor(view)` with no
// manual size/offset bookkeeping, and a no-op for every other decoded value shape.
test('typed-array field on an external object survives memory growth', () => {
  if (onWasi()) return  // wasi: external object
  const { step } = run(`
    export const step = (o, growBy) => {
      let junk = new Float64Array(growBy)
      junk[0] = 1
      if (!o.buf) o.buf = new Float32Array(4)
      let b = o.buf
      return b.length
    }
  `)
  const o = {}
  is(step(o, 10), 4)
  is(step(o, 200000), 4)  // forces Memory.grow(); read-back of o.buf must not throw or see a detached view
})
