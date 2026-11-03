// mapobj.js – a build tool's pass over a module graph with object-keyed Maps:
// the modules are objects pointing at their dependencies, and every side
// table is a Map from module object: in-degree and reverse edges (get, set,
// has), Kahn's topological order with each module's depth (the longest
// dependency chain under it), then a deep copy of the graph through a memo Map
// that keeps shared dependencies shared and a Set that counts the distinct
// copies. Names repeat on purpose (two versions of one package are different
// modules), so only identity can key the tables. The shape of every bundler,
// scheduler, serializer with cycle and sharing handling, and DOM or AST side
// table.
//
// The graph is built once from XorShift32, identical per target: 4096 modules,
// each depending on up to four earlier ones. The topological queue is FIFO in
// module order and adjacency in insertion order, so the order and depths are
// fixed; every fold is over that order or a sum. Integer arithmetic only:
// bit-identical everywhere.
//
// Reports: median ms across N_RUNS, throughput in modules/µs, FNV-1a checksum
// over the order, depths and copy counts.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const N = 4096               // modules
const ENTRIES = 64           // entry points copied from the end of the order
const N_RUNS = 21
const N_WARMUP = 5

const NAMES = ['react', 'lodash', 'util', 'core', 'events', 'buffer', 'path', 'stream', 'zlib', 'url']

const buildGraph = () => {
  const modules = []
  let s = 0x9e3779b9 | 0
  const next = () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return s >>> 0
  }
  for (let i = 0; i < N; i++) {
    const deps = []
    const nDeps = i === 0 ? 0 : next() % 5
    for (let k = 0; k < nDeps; k++) deps.push(modules[next() % i])
    modules.push({ id: i, name: NAMES[next() % NAMES.length], size: 100 + next() % 9900, deps })
  }
  return modules
}

const plan = (modules) => {
  const indeg = new Map()
  const users = new Map()
  for (let i = 0; i < modules.length; i++) {
    const m = modules[i]
    if (!indeg.has(m)) indeg.set(m, 0)
    for (let k = 0; k < m.deps.length; k++) {
      const d = m.deps[k]
      indeg.set(m, indeg.get(m) + 1)
      let u = users.get(d)
      if (u === undefined) { u = []; users.set(d, u) }
      u.push(m)
    }
  }
  const depth = new Map()
  const order = []
  for (let i = 0; i < modules.length; i++) if (indeg.get(modules[i]) === 0) { order.push(modules[i]); depth.set(modules[i], 0) }
  for (let head = 0; head < order.length; head++) {
    const m = order[head]
    const u = users.get(m)
    if (u === undefined) continue
    const d = depth.get(m) + 1
    for (let k = 0; k < u.length; k++) {
      const v = u[k]
      if (!depth.has(v) || depth.get(v) < d) depth.set(v, d)
      const left = indeg.get(v) - 1
      indeg.set(v, left)
      if (left === 0) order.push(v)
    }
  }
  const memo = new Map()
  const copy = (m) => {
    let c = memo.get(m)
    if (c !== undefined) return c
    c = { id: m.id, name: m.name, size: m.size, deps: [] }
    memo.set(m, c)
    for (let k = 0; k < m.deps.length; k++) c.deps.push(copy(m.deps[k]))
    return c
  }
  const seen = new Set()
  const stack = []
  let bytes = 0
  for (let e = order.length - ENTRIES; e < order.length; e++) {
    stack.push(copy(order[e]))
    while (stack.length > 0) {
      const c = stack.pop()
      if (seen.has(c)) continue
      seen.add(c)
      bytes += c.size
      for (let k = 0; k < c.deps.length; k++) stack.push(c.deps[k])
    }
  }
  return { order, depth, copies: memo.size, distinct: seen.size, bytes }
}

const checksum = (r) => {
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < r.order.length; i++) h = mix(mix(h, r.order[i].id), r.depth.get(r.order[i]))
  return mix(mix(mix(h, r.copies), r.distinct), r.bytes) >>> 0
}

export let main = () => {
  const modules = buildGraph()
  let r = null
  for (let i = 0; i < N_WARMUP; i++) r = plan(modules)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    r = plan(modules)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksum(r), N, 3, N_RUNS)
}
