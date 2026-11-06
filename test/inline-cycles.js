// A function with a loop that reaches itself through the functions it calls
// (`a` → `b` → `a`, a tree walk split in two) stays a function
// (src/compile/plan/inline.js): each splice of it carries the cycle's call, so
// splicing it nests its loop a level per round, and the interval proofs over
// those nests compiled for minutes. Every value is a differential against the host.
import test from 'tst'
import { ok } from 'tst/assert.js'
import { agree, wat } from './util.js'
import { belowOpt, levels } from './_matrix.js'

const pair = `function a(node, fn) { node = fn(node); if (Array.isArray(node)) for (let i = 0; i < node.length; i++) node[i] = b(node[i], fn); return node }
function b(node, fn) { if (Array.isArray(node)) for (let i = 0; i < node.length; i++) node[i] = a(node[i], fn); return node }
export let run = (n) => { const t = [1, [2, [3, [n]]], 5]; a(t, x => typeof x === 'number' ? x + 1 : x); return JSON.stringify(t) }`

test('inline cycles: a loop in a cycle of calls keeps its function', () => {
  for (const optimize of levels(0, 2, 3, 'speed')) agree(pair, 'run', [4], { optimize }, `run at ${optimize}`)
  if (belowOpt(2)) return
  for (const optimize of [2, 'speed']) {
    // the pair's two loops, each once: b may splice into a, which then calls itself
    const loops = wat(pair, { optimize }).split(/\n(?=  \(func )/).filter(f => /^  \(func \$[ab][\s\n]/.test(f))
      .reduce((n, f) => n + (f.match(/\(loop/g) || []).length, 0)
    ok(loops === 2, `two loops at ${optimize}, ${loops} found`)
  }
})
