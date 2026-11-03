// mapstr.js – sessionizing a request log with string-keyed Maps: per event,
// count the route (get + set), find or open the user's session (get, set on a
// miss), drop the event if the user is rate-limited (has, get, delete when the
// ban lapses), ban users that exceed a burst, and every 512 events sweep the
// sessions, closing (delete) those idle for a window. The keys are the strings
// a parser hands over: a fresh string per event, equal in content to earlier
// ones but never the same object, so each lookup hashes and compares text.
// The shape of every log aggregator, rate limiter and cache in a server.
//
// The event stream is built once from XorShift32, identical per target: half
// the traffic from 64 hot users, the rest over 4096, routes over 96 paths.
// Folds over a Map's entries are sums (order-independent), so ports whose maps
// iterate in another order agree. Counts are integers: bit-identical everywhere.
//
// Reports: median ms across N_RUNS, throughput in events/µs, FNV-1a checksum
// over closed-session statistics and the final maps.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const N = 1 << 15            // events per pass
const NUSERS = 4096
const NROUTES = 96
const WINDOW = 2048          // a session idle this many events closes
const SWEEP = 512            // events between sweeps
const BURST = 48             // hits within one session that earn a ban
const PENALTY = 1024         // events a ban lasts
const N_RUNS = 21
const N_WARMUP = 5

const RESOURCES = ['users', 'orders', 'items', 'carts', 'search', 'auth', 'images', 'reviews',
  'stock', 'prices', 'tags', 'stats']

const buildEvents = (users, routes, bytes) => {
  let s = 0x1234abcd | 0
  for (let i = 0; i < N; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    const u = (s & 1) === 0 ? (s >>> 1) & 63 : (s >>> 1) & (NUSERS - 1)
    const r = (s >>> 13) % NROUTES
    users[i] = 'user' + u
    routes[i] = '/api/v' + (1 + r % 3) + '/' + RESOURCES[r % RESOURCES.length] + '/' + (r >>> 2)
    bytes[i] = 200 + ((s >>> 20) & 4095)
  }
}

const run = (users, routes, bytes) => {
  const routeHits = new Map()
  const sessions = new Map()
  const banned = new Map()
  let dropped = 0, closed = 0, closedBytes = 0, longest = 0
  for (let i = 0; i < N; i++) {
    const r = routes[i]
    routeHits.set(r, (routeHits.get(r) || 0) + 1)
    const u = users[i]
    if (banned.has(u)) {
      if (banned.get(u) > i) { dropped++; continue }
      banned.delete(u)
    }
    let s = sessions.get(u)
    if (s === undefined) {
      s = { hits: 0, bytes: 0, first: i, last: i }
      sessions.set(u, s)
    }
    s.hits++
    s.bytes += bytes[i]
    s.last = i
    if (s.hits % BURST === 0) banned.set(u, i + PENALTY)
    if (i % SWEEP === SWEEP - 1) {
      for (const [k, v] of sessions) {
        if (i - v.last > WINDOW) {
          closed++
          closedBytes = (closedBytes + v.bytes) | 0
          if (v.last - v.first > longest) longest = v.last - v.first
          sessions.delete(k)
        }
      }
    }
  }
  return { routeHits, sessions, banned, dropped, closed, closedBytes, longest }
}

const hashStr = (s) => {
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < s.length; i++) h = mix(h, s.charCodeAt(i))
  return h
}

const checksum = (r) => {
  let h = mix(mix(mix(mix(0x811c9dc5 | 0, r.dropped), r.closed), r.closedBytes), r.longest)
  let acc = 0
  for (const [k, v] of r.routeHits) acc = (acc + mix(hashStr(k), v)) | 0
  h = mix(mix(h, r.routeHits.size), acc)
  acc = 0
  for (const [k, v] of r.sessions) acc = (acc + mix(mix(hashStr(k), v.hits), v.bytes)) | 0
  h = mix(mix(h, r.sessions.size), acc)
  acc = 0
  for (const [k, v] of r.banned) acc = (acc + mix(hashStr(k), v)) | 0
  return mix(mix(h, r.banned.size), acc) >>> 0
}

export let main = () => {
  const users = [], routes = []
  const bytes = new Int32Array(N)
  buildEvents(users, routes, bytes)
  let r = null
  for (let i = 0; i < N_WARMUP; i++) r = run(users, routes, bytes)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    r = run(users, routes, bytes)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksum(r), N, 3, N_RUNS)
}
