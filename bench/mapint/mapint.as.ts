// mapint.as.ts – AssemblyScript translation of bench/mapint/mapint.js.
//
// Graph analytics over sparse integer ids with integer-keyed maps: adjacency
// lists keyed by 30-bit node id, the degree histogram, and a breadth-first
// search per source with its distance map, from four sources.
// AssemblyScript's idiomatic answer is Map<i32, T>. Map folds are sums; a
// search visits neighbors in insertion order, as the JavaScript does.
//
// Reports: median ms across N_RUNS, throughput in edges/µs, FNV-1a checksum
// over the degree histogram and the searches.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const NODES: u32 = 1 << 12
const EDGES: i32 = 3 * NODES
const SOURCES: i32 = 4
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

@inline
function mix(h: i32, x: i32): i32 {
  return (h ^ x) * 0x01000193
}

// a node number to its id: a bijective scramble of 30 bits
function idOf(n: u32): i32 {
  let x: u32 = ((n + 1) * 0x2c1b3c6d) & 0x3fffffff
  x ^= x >>> 15
  return <i32>((x * 0x297a2d39) & 0x3fffffff)
}

class Result {
  constructor(public nodes: i32, public degrees: Map<i32, i32>, public searches: Array<i32>) {}
}

function buildEdges(src: Int32Array, dst: Int32Array): void {
  let s: u32 = 0x2545f491
  for (let i = 0; i < EDGES; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const a: u32 = (s >>> 2) & (NODES - 1)
    let b: u32 = (s & 1) == 0 ? (s >>> 16) & 1023 : (s >>> 16) & (NODES - 1)
    if (b == a) b = (a + 1) & (NODES - 1)
    unchecked(src[i] = idOf(a))
    unchecked(dst[i] = idOf(b))
  }
}

function analyze(src: Int32Array, dst: Int32Array): Result {
  const adj = new Map<i32, Array<i32>>()
  for (let i = 0; i < src.length; i++) {
    const a = unchecked(src[i]), b = unchecked(dst[i])
    if (!adj.has(a)) adj.set(a, new Array<i32>())
    adj.get(a).push(b)
    if (!adj.has(b)) adj.set(b, new Array<i32>())
    adj.get(b).push(a)
  }
  const degrees = new Map<i32, i32>()
  const lists = adj.values()
  for (let k = 0; k < lists.length; k++) {
    const d = unchecked(lists[k]).length
    degrees.set(d, (degrees.has(d) ? degrees.get(d) : 0) + 1)
  }
  const searches = new Array<i32>()
  const queue = new Array<i32>()
  for (let k = 0; k < SOURCES; k++) {
    const root = unchecked(src[(k * 6151) % src.length])
    const dist = new Map<i32, i32>()
    dist.set(root, 0)
    queue.length = 0
    queue.push(root)
    let sum: i32 = 0
    for (let head = 0; head < queue.length; head++) {
      const v = unchecked(queue[head])
      const d = dist.get(v) + 1
      const list = adj.get(v)
      for (let j = 0; j < list.length; j++) {
        const w = unchecked(list[j])
        if (!dist.has(w)) { dist.set(w, d); sum += d; queue.push(w) }
      }
    }
    searches.push(dist.size)
    searches.push(sum)
  }
  return new Result(adj.size, degrees, searches)
}

function checksum(r: Result): u32 {
  let h = mix(<i32>0x811c9dc5, r.nodes)
  let acc: i32 = 0
  const keys = r.degrees.keys()
  for (let k = 0; k < keys.length; k++) acc += mix(keys[k], r.degrees.get(keys[k]))
  h = mix(mix(h, r.degrees.size), acc)
  for (let i = 0; i < r.searches.length; i++) h = mix(h, r.searches[i])
  return <u32>h
}

export function main(): void {
  const src = new Int32Array(EDGES), dst = new Int32Array(EDGES)
  buildEdges(src, dst)
  let r = analyze(src, dst)
  for (let i: i32 = 1; i < N_WARMUP; i++) r = analyze(src, dst)

  const samples = new Float64Array(N_RUNS)
  for (let i: i32 = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    r = analyze(src, dst)
    unchecked(samples[i] = perfNow() - t0)
  }

  for (let i: i32 = 1; i < N_RUNS; i++) {
    const v = unchecked(samples[i])
    let j = i - 1
    while (j >= 0 && unchecked(samples[j]) > v) {
      unchecked(samples[j + 1] = samples[j])
      j--
    }
    unchecked(samples[j + 1] = v)
  }
  logLine(<i32>(unchecked(samples[(N_RUNS - 1) >> 1]) * 1000.0), checksum(r), EDGES, 3, N_RUNS)
}
