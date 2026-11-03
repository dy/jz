// mapobj.as.ts – AssemblyScript translation of bench/mapobj/mapobj.js.
//
// A build tool's pass over a module graph with object-keyed maps: in-degree
// and reverse edges, Kahn's topological order with each module's depth, then
// a deep copy through a memo map that keeps shared dependencies shared and a
// Set that counts the distinct copies. AssemblyScript's Map and Set take a
// class reference as the key and hash its address: identity, as in
// JavaScript.
//
// Reports: median ms across N_RUNS, throughput in modules/µs, FNV-1a checksum
// over the order, depths and copy counts.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 4096               // modules
const ENTRIES: i32 = 64           // entry points copied from the end of the order
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

const NAMES: StaticArray<string> = ['react', 'lodash', 'util', 'core', 'events', 'buffer', 'path', 'stream', 'zlib', 'url']

@inline
function mix(h: i32, x: i32): i32 {
  return (h ^ x) * 0x01000193
}

class Module {
  deps: Array<Module> = new Array<Module>()
  constructor(public id: i32, public name: string, public size: i32) {}
}

class Result {
  constructor(public order: Array<Module>, public depth: Map<Module, i32>,
    public copies: i32, public distinct: i32, public bytes: i32) {}
}

let seed: u32 = 0x9e3779b9
function next(): u32 {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return seed
}

function buildGraph(): Array<Module> {
  const modules = new Array<Module>()
  for (let i = 0; i < N; i++) {
    const deps = new Array<Module>()
    const nDeps = i == 0 ? 0 : <i32>(next() % 5)
    for (let k = 0; k < nDeps; k++) deps.push(modules[<i32>(next() % <u32>i)])
    const name = NAMES[<i32>(next() % 10)]
    const m = new Module(i, name, 100 + <i32>(next() % 9900))
    m.deps = deps
    modules.push(m)
  }
  return modules
}

let memo = new Map<Module, Module>()
function copy(m: Module): Module {
  if (memo.has(m)) return memo.get(m)
  const c = new Module(m.id, m.name, m.size)
  memo.set(m, c)
  for (let k = 0; k < m.deps.length; k++) c.deps.push(copy(unchecked(m.deps[k])))
  return c
}

function plan(modules: Array<Module>): Result {
  const indeg = new Map<Module, i32>()
  const users = new Map<Module, Array<Module>>()
  for (let i = 0; i < modules.length; i++) {
    const m = unchecked(modules[i])
    if (!indeg.has(m)) indeg.set(m, 0)
    for (let k = 0; k < m.deps.length; k++) {
      const d = unchecked(m.deps[k])
      indeg.set(m, indeg.get(m) + 1)
      if (!users.has(d)) users.set(d, new Array<Module>())
      users.get(d).push(m)
    }
  }
  const depth = new Map<Module, i32>()
  const order = new Array<Module>()
  for (let i = 0; i < modules.length; i++) {
    const m = unchecked(modules[i])
    if (indeg.get(m) == 0) { order.push(m); depth.set(m, 0) }
  }
  for (let head = 0; head < order.length; head++) {
    const m = unchecked(order[head])
    if (!users.has(m)) continue
    const u = users.get(m)
    const d = depth.get(m) + 1
    for (let k = 0; k < u.length; k++) {
      const v = unchecked(u[k])
      if (!depth.has(v) || depth.get(v) < d) depth.set(v, d)
      const left = indeg.get(v) - 1
      indeg.set(v, left)
      if (left == 0) order.push(v)
    }
  }
  memo = new Map<Module, Module>()
  const seen = new Set<Module>()
  const stack = new Array<Module>()
  let bytes: i32 = 0
  for (let e = order.length - ENTRIES; e < order.length; e++) {
    stack.push(copy(unchecked(order[e])))
    while (stack.length > 0) {
      const c = stack.pop()
      if (seen.has(c)) continue
      seen.add(c)
      bytes += c.size
      for (let k = 0; k < c.deps.length; k++) stack.push(unchecked(c.deps[k]))
    }
  }
  return new Result(order, depth, memo.size, seen.size, bytes)
}

function checksum(r: Result): u32 {
  let h: i32 = <i32>0x811c9dc5
  for (let i = 0; i < r.order.length; i++) h = mix(mix(h, r.order[i].id), r.depth.get(r.order[i]))
  return <u32>mix(mix(mix(h, r.copies), r.distinct), r.bytes)
}

export function main(): void {
  const modules = buildGraph()
  let r = plan(modules)
  for (let i: i32 = 1; i < N_WARMUP; i++) r = plan(modules)

  const samples = new Float64Array(N_RUNS)
  for (let i: i32 = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    r = plan(modules)
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
  logLine(<i32>(unchecked(samples[(N_RUNS - 1) >> 1]) * 1000.0), checksum(r), N, 3, N_RUNS)
}
