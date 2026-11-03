// mapint.js – graph analytics over sparse integer ids with integer-keyed
// Maps: an edge list names nodes by 30-bit ids (database keys, hashed user
// ids), so every structure is a Map from id: the adjacency lists (get, set on
// a miss, push), the degree histogram, and per breadth-first search the
// distance map (has, set) over a queue of ids, from four sources. The sums of
// distances and the reach of each search fold into the result. The shape of
// every program that joins records by numeric key: id remapping, graph
// traversal, memo tables keyed by number.
//
// The edge list is built once from XorShift32, identical per target: 4096
// nodes, each id a scrambled 30-bit integer (small integers in every engine),
// 12288 edges, half of them ending in the first 1024 nodes. Every fold over a
// Map is a sum (order-independent); a search visits neighbors in insertion
// order, which fixes the distances. Integer arithmetic only: bit-identical
// everywhere.
//
// Reports: median ms across N_RUNS, throughput in edges/µs, FNV-1a checksum
// over the degree histogram and the searches.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const NODES = 1 << 12
const EDGES = 3 * NODES
const SOURCES = 4
const N_RUNS = 21
const N_WARMUP = 5

// a node number to its id: a bijective scramble of 30 bits
const idOf = (n) => {
  let x = Math.imul(n + 1, 0x2c1b3c6d) & 0x3fffffff
  x ^= x >>> 15
  return Math.imul(x, 0x297a2d39) & 0x3fffffff
}

const buildEdges = (src, dst) => {
  let s = 0x2545f491 | 0
  for (let i = 0; i < EDGES; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const a = (s >>> 2) & (NODES - 1)
    const b = (s & 1) === 0 ? (s >>> 16) & 1023 : (s >>> 16) & (NODES - 1)
    src[i] = idOf(a)
    dst[i] = idOf(b === a ? (a + 1) & (NODES - 1) : b)
  }
}

const analyze = (src, dst) => {
  const adj = new Map()
  for (let i = 0; i < src.length; i++) {
    const a = src[i], b = dst[i]
    let la = adj.get(a)
    if (la === undefined) { la = []; adj.set(a, la) }
    la.push(b)
    let lb = adj.get(b)
    if (lb === undefined) { lb = []; adj.set(b, lb) }
    lb.push(a)
  }
  const degrees = new Map()
  for (const [, list] of adj) degrees.set(list.length, (degrees.get(list.length) || 0) + 1)
  const searches = []
  const queue = []
  for (let k = 0; k < SOURCES; k++) {
    const root = src[(k * 6151) % src.length]
    const dist = new Map()
    dist.set(root, 0)
    queue.length = 0
    queue.push(root)
    let sum = 0
    for (let head = 0; head < queue.length; head++) {
      const v = queue[head]
      const d = dist.get(v) + 1
      const list = adj.get(v)
      for (let j = 0; j < list.length; j++) {
        const w = list[j]
        if (!dist.has(w)) { dist.set(w, d); sum += d; queue.push(w) }
      }
    }
    searches.push(dist.size, sum)
  }
  return { nodes: adj.size, degrees, searches }
}

const checksum = (r) => {
  let h = mix(0x811c9dc5 | 0, r.nodes)
  let acc = 0
  for (const [deg, count] of r.degrees) acc = (acc + mix(deg, count)) | 0
  h = mix(mix(h, r.degrees.size), acc)
  for (let i = 0; i < r.searches.length; i++) h = mix(h, r.searches[i])
  return h >>> 0
}

export let main = () => {
  const src = new Int32Array(EDGES), dst = new Int32Array(EDGES)
  buildEdges(src, dst)
  let r = null
  for (let i = 0; i < N_WARMUP; i++) r = analyze(src, dst)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    r = analyze(src, dst)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksum(r), EDGES, 3, N_RUNS)
}
