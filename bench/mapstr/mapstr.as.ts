// mapstr.as.ts – AssemblyScript translation of bench/mapstr/mapstr.js.
//
// Sessionizing a request log with string-keyed maps: per event, count the
// route, find or open the user's session, drop the event while the user is
// rate-limited, ban users that exceed a burst, and every 512 events close the
// sessions idle for a window. AssemblyScript's idiomatic answer is
// Map<string, T>; it has no live iterator, so the sweep walks a snapshot of
// the keys (`keys()`). The keys are fresh strings per event. Map folds are
// sums, so iteration order changes nothing.
//
// Reports: median ms across N_RUNS, throughput in events/µs, FNV-1a checksum
// over closed-session statistics and the final maps.

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

const N: i32 = 1 << 15            // events per pass
const NUSERS: u32 = 4096
const NROUTES: u32 = 96
const WINDOW: i32 = 2048          // a session idle this many events closes
const SWEEP: i32 = 512            // events between sweeps
const BURST: i32 = 48             // hits within one session that earn a ban
const PENALTY: i32 = 1024         // events a ban lasts
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

const RESOURCES: StaticArray<string> = ['users', 'orders', 'items', 'carts', 'search', 'auth', 'images', 'reviews',
  'stock', 'prices', 'tags', 'stats']

@inline
function mix(h: i32, x: i32): i32 {
  return (h ^ x) * 0x01000193
}

class Session {
  hits: i32 = 0
  bytes: i32 = 0
  constructor(public first: i32, public last: i32) {}
}

class Result {
  routeHits: Map<string, i32> = new Map<string, i32>()
  sessions: Map<string, Session> = new Map<string, Session>()
  banned: Map<string, i32> = new Map<string, i32>()
  dropped: i32 = 0
  closed: i32 = 0
  closedBytes: i32 = 0
  longest: i32 = 0
}

function buildEvents(users: StaticArray<string>, routes: StaticArray<string>, bytes: Int32Array): void {
  let s: u32 = 0x1234abcd
  for (let i = 0; i < N; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const u: u32 = (s & 1) == 0 ? (s >>> 1) & 63 : (s >>> 1) & (NUSERS - 1)
    const r: u32 = (s >>> 13) % NROUTES
    unchecked(users[i] = 'user' + u.toString())
    unchecked(routes[i] = '/api/v' + (1 + r % 3).toString() + '/' + RESOURCES[r % 12] + '/' + (r >>> 2).toString())
    unchecked(bytes[i] = 200 + <i32>((s >>> 20) & 4095))
  }
}

function run(users: StaticArray<string>, routes: StaticArray<string>, bytes: Int32Array): Result {
  const res = new Result()
  for (let i = 0; i < N; i++) {
    const r = unchecked(routes[i])
    res.routeHits.set(r, (res.routeHits.has(r) ? res.routeHits.get(r) : 0) + 1)
    const u = unchecked(users[i])
    if (res.banned.has(u)) {
      if (res.banned.get(u) > i) { res.dropped++; continue }
      res.banned.delete(u)
    }
    let s: Session
    if (res.sessions.has(u)) s = res.sessions.get(u)
    else {
      s = new Session(i, i)
      res.sessions.set(u, s)
    }
    s.hits++
    s.bytes += unchecked(bytes[i])
    s.last = i
    if (s.hits % BURST == 0) res.banned.set(u, i + PENALTY)
    if (i % SWEEP == SWEEP - 1) {
      const keys = res.sessions.keys()
      for (let k = 0; k < keys.length; k++) {
        const key = unchecked(keys[k])
        const v = res.sessions.get(key)
        if (i - v.last > WINDOW) {
          res.closed++
          res.closedBytes += v.bytes
          if (v.last - v.first > res.longest) res.longest = v.last - v.first
          res.sessions.delete(key)
        }
      }
    }
  }
  return res
}

function hashStr(s: string): i32 {
  let h: i32 = <i32>0x811c9dc5
  for (let i = 0; i < s.length; i++) h = mix(h, s.charCodeAt(i))
  return h
}

function checksum(r: Result): u32 {
  let h = mix(mix(mix(mix(<i32>0x811c9dc5, r.dropped), r.closed), r.closedBytes), r.longest)
  let acc: i32 = 0
  let keys = r.routeHits.keys()
  for (let k = 0; k < keys.length; k++) acc += mix(hashStr(keys[k]), r.routeHits.get(keys[k]))
  h = mix(mix(h, r.routeHits.size), acc)
  acc = 0
  keys = r.sessions.keys()
  for (let k = 0; k < keys.length; k++) {
    const v = r.sessions.get(keys[k])
    acc += mix(mix(hashStr(keys[k]), v.hits), v.bytes)
  }
  h = mix(mix(h, r.sessions.size), acc)
  acc = 0
  keys = r.banned.keys()
  for (let k = 0; k < keys.length; k++) acc += mix(hashStr(keys[k]), r.banned.get(keys[k]))
  return <u32>mix(mix(h, r.banned.size), acc)
}

export function main(): void {
  const users = new StaticArray<string>(N)
  const routes = new StaticArray<string>(N)
  const bytes = new Int32Array(N)
  buildEvents(users, routes, bytes)
  let r = run(users, routes, bytes)
  for (let i: i32 = 1; i < N_WARMUP; i++) r = run(users, routes, bytes)

  const samples = new Float64Array(N_RUNS)
  for (let i: i32 = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    r = run(users, routes, bytes)
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
