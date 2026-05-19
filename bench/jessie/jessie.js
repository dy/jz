import { parse } from '../../node_modules/subscript/feature/jessie.js'
import { medianUs, mix, printResult } from '../_lib/benchlib.js'

// Parser bench: drive the jessie (subscript) JS-subset Pratt parser over a
// realistic source corpus. `parse` walks the char stream, dispatches operator
// handlers through the `lookup` closure-chain registry, and builds a nested
// array AST — branch-heavy, allocation-heavy, recursion-heavy work that stresses
// exactly the paths a real compiler front-end hits. This is the workload jz
// must out-run V8 on.
//
// The corpus avoids `true` / `false` / `null` / `undefined` literals on
// purpose: jz models every value as an f64, so a boolean leaf would hash
// differently than V8's `true`. With only string and integer leaves the AST is
// bit-identical across engines and the checksum stays a real cross-engine
// correctness gate.

const N_RUNS = 21
const N_WARMUP = 5
const N_REPEAT = 64

const BLOCK = `let total = 0
const limit = 64
function step(a, b) { return a * b + (a - b) }
const scale = (x) => x * 3 + 1
for (let i = 0; i < limit; i = i + 1) {
  let v = step(i, i + 2)
  if (v > 100) { total = total + scale(v) } else { total = total - i }
  while (v > 0) { v = v - 7 }
}
const data = [1, 2, 3, 4, 5]
let acc = data[0] + data[1] * data[2]
const obj = { x: acc, y: total, z: limit }
total = obj.x + obj.y - obj.z
`

const makeSource = () => {
  let s = ''
  for (let i = 0; i < N_REPEAT; i++) s = s + BLOCK
  return s
}

// Structural FNV-1a hash over the AST: array length + recursion, string
// length + char codes, integer leaf values. Deterministic and engine-agnostic
// for a corpus of string/number leaves only — see the note above.
const hashNode = (node, h) => {
  if (Array.isArray(node)) {
    h = mix(h, node.length)
    for (let i = 0; i < node.length; i++) h = hashNode(node[i], h)
    return h
  }
  if (typeof node === 'string') {
    h = mix(h, node.length + 256)
    for (let i = 0; i < node.length; i++) h = mix(h, node.charCodeAt(i))
    return h
  }
  if (typeof node === 'number') return mix(h, node | 0)
  return mix(h, 7)
}

export let main = () => {
  const src = makeSource()
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = hashNode(parse(src), 0x811c9dc5 | 0) >>> 0

  // Time `parse` alone; hash the AST outside the timed region so the result
  // stays live (no DCE) without charging traversal cost to the parser.
  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    const ast = parse(src)
    samples[i] = performance.now() - t0
    cs = hashNode(ast, 0x811c9dc5 | 0) >>> 0
  }
  printResult(medianUs(samples), cs, src.length, 1, N_RUNS)
}
