import Base
import ../_lib/bench.bend as B
# mapstr.bend: Bend port of mapstr.js (same event stream, maps, sweeps and
# checksum): sessionizing a request log with Base's string-keyed Map. Per
# event the route's count is read and set one higher, a banned user is
# dropped (has, get, and del once the ban lapses), the user's session is
# read (a fresh one when absent, the default Map.get answers) and set back
# updated, a burst earns a ban, and every 512 events the sweep walks
# Map.to_list of the sessions, deleting those idle for a window. A Bend
# value has no identity, so a session is a Data record, Sess, and the JS's
# writes into the object it holds are one Map.set of the updated record. The
# keys are Strings from Array<String> tables built once, compared by their
# text as the JS's fresh strings are; Map's own walks take nearly all the
# time. Folds over a map's entries are sums, so its order does not matter.

type Sess is Data:
  Sess{hits: U32, bytes: U32, first: U32, last: U32}

type Ev is Type:
  Ev{users: Array<String>, routes: Array<String>, bytes: Array<U32>}

type Maps is Type:
  Maps{hits: Map<&2, U32>, sess: Map<&2, Sess>, banned: Map<&2, U32>}

# dropped, closed, closedBytes and longest
type St is Data:
  St{dropped: U32, closed: U32, cbytes: U32, longest: U32}

type Run is Type:
  Run{ev: Ev, maps: Maps, st: St}

type Bld is Type:
  Bld{users: Array<String>, routes: Array<String>, bytes: Array<U32>, res: Array<String>}

def n() -> Nat:
  32768n

def resources() -> List<&2, String>:
  ["users", "orders", "items", "carts", "search", "auth", "images", "reviews",
   "stock", "prices", "tags", "stats"]

def table(xs: List<&2, String>, +i: U32, a: Array<String>) -> Array<String>:
  match xs:
    case Nil{}:
      a
    case x <> t:
      table(t, (i + 1 : U32), Array.set(String, a, i, x))

# users[i] = 'user' + u; routes[i] = '/api/v' + (1 + r % 3) + '/' +
# RESOURCES[r % 12] + '/' + (r >>> 2); bytes[i] = 200 + ((s >>> 20) & 4095)
def build.route(+i: U32, +r: U32, users: Array<String>, routes: Array<String>, bytes: Array<U32>,
                x: Array<String> & String) -> Bld:
  (res, name) = x
  Bld{users, Array.set(String, routes, i, "/api/v" ++ U32.show((1 + U32.mod(r, 3) : U32)) ++ "/" ++
    name ++ "/" ++ U32.show((r >> 2n : U32))), bytes, res}

def build.step(+i: U32, +s: U32, b: Bld) -> Bld:
  Bld{users, routes, bytes, res} = b
  +u = Bool.pick(U32, U32.is_eq((s .&. 1 : U32), 0), ((s >> 1n) .&. 63 : U32), ((s >> 1n) .&. 4095 : U32))
  +r = U32.mod((s >> 13n : U32), 96)
  build.route(i, r, Array.set(String, users, i, "user" ++ U32.show(u)), routes,
    bytes[i] <- (200 + ((s >> 20n) .&. 4095) : U32), Array.get(String, res, U32.mod(r, 12)))

def build(k: Nat, +i: U32, +s: U32, b: Bld) -> Bld:
  match k:
    case 0n:
      b
    case 1n+p:
      +s1 = (s .^. (s << 13n) : U32)
      +s2 = (s1 .^. (s1 >> 17n) : U32)
      +s3 = (s2 .^. (s2 << 5n) : U32)
      build(p, (i + 1 : U32), s3, build.step(i, s3, b))

# routeHits.set(r, (routeHits.get(r) || 0) + 1)
def route.set(+r: String, x: Map<&2, U32> & U32) -> Map<&2, U32>:
  (hits, c) = x
  Map.set(&2, U32, hits, r, (c + 1 : U32))

def route(hits: Map<&2, U32>, +r: String) -> Map<&2, U32>:
  route.set(r, Map.get(U32, 0, hits, r))

# if (v.last - v.first > longest) longest = v.last - v.first; sessions.delete(k)
def sweep.close(over: Bool, k: String, b: U32, +first: U32, +last: U32, m: Map<&2, Sess>,
                st: St) -> Map<&2, Sess> & St:
  match over:
    case True{}:
      St{dropped, closed, cbytes, +longest} = st
      +len = (last - first : U32)
      (Map.del(&2, Sess, m, k),
        St{dropped, (closed + 1 : U32), (cbytes + b : U32), Bool.pick(U32, (len > longest : U32), len, longest)})
    case False{}:
      (m, st)

# a session idle more than WINDOW events closes
def sweep.entry(+i: U32, k: String, v: Sess, r: Map<&2, Sess> & St) -> Map<&2, Sess> & St:
  Sess{hits, b, +first, +last} = v
  (m, st) = r
  sweep.close(((i - last : U32) > 2048 : U32), k, b, first, last, m, st)

def sweep.go(xs: List<&2, Sigma<&2, &2, String, _ => Sess>>, +i: U32,
             r: Map<&2, Sess> & St) -> Map<&2, Sess> & St:
  match xs:
    case Nil{}:
      r
    case (k, v) <> t:
      sweep.go(t, i, sweep.entry(i, k, v, r))

def sweep.fin(ev: Ev, hits: Map<&2, U32>, banned: Map<&2, U32>, r: Map<&2, Sess> & St) -> Run:
  (sess, st) = r
  Run{ev, Maps{hits, sess, banned}, st}

# if (i % SWEEP === SWEEP - 1): for (const [k, v] of sessions)
def sweep(go: Bool, +i: U32, ev: Ev, maps: Maps, st: St) -> Run:
  match go:
    case True{}:
      Maps{hits, +sess, banned} = maps
      sweep.fin(ev, hits, banned, sweep.go(Map.to_list(&2, Sess, sess), i, (sess, st)))
    case False{}:
      Run{ev, maps, st}

# if (s.hits % BURST === 0) banned.set(u, i + PENALTY)
def session.ban(ban: Bool, +i: U32, u: String, ev: Ev, hits: Map<&2, U32>, sess: Map<&2, Sess>,
                banned: Map<&2, U32>, st: St) -> Run:
  match ban:
    case True{}:
      sweep(U32.is_eq(U32.mod(i, 512), 511), i, ev,
        Maps{hits, sess, Map.set(&2, U32, banned, u, (i + 1024 : U32))}, st)
    case False{}:
      sweep(U32.is_eq(U32.mod(i, 512), 511), i, ev, Maps{hits, sess, banned}, st)

# s.hits++; s.bytes += bytes[i]; s.last = i: the updated record set back
def session.f2(+i: U32, +u: String, ev: Ev, hits: Map<&2, U32>, banned: Map<&2, U32>, st: St,
               b: U32, x: Map<&2, Sess> & Sess) -> Run:
  (sess, s) = x
  Sess{h, sb, first, last} = s
  +h1 = (h + 1 : U32)
  session.ban(U32.is_eq(U32.mod(h1, 48), 0), i, u, ev, hits,
    Map.set(&2, Sess, sess, u, Sess{h1, (sb + b : U32), first, i}), banned, st)

# s = sessions.get(u), { hits: 0, bytes: 0, first: i, last: i } when absent
def session.f1(+i: U32, +u: String, users: Array<String>, routes: Array<String>, maps: Maps,
               st: St, x: Array<U32> & U32) -> Run:
  Maps{hits, sess, banned} = maps
  (bytes, b) = x
  session.f2(i, u, Ev{users, routes, bytes}, hits, banned, st, b,
    Map.get(Sess, Sess{0, 0, i, i}, sess, u))

def session(+i: U32, u: String, ev: Ev, maps: Maps, st: St) -> Run:
  Ev{users, routes, bytes} = ev
  session.f1(i, u, users, routes, maps, st, bytes[i])

# banned.get(u) > i: dropped++ and the event ends; else banned.delete(u)
def step.drop(still: Bool, +i: U32, +u: String, ev: Ev, hits: Map<&2, U32>,
              sess: Map<&2, Sess>, st: St, banned: Map<&2, U32>) -> Run:
  match still:
    case True{}:
      St{dropped, closed, cbytes, longest} = st
      Run{ev, Maps{hits, sess, banned}, St{(dropped + 1 : U32), closed, cbytes, longest}}
    case False{}:
      session(i, u, ev, Maps{hits, sess, Map.del(&2, U32, banned, u)}, st)

def step.lapse(+i: U32, u: String, ev: Ev, hits: Map<&2, U32>, sess: Map<&2, Sess>, st: St,
               x: Map<&2, U32> & U32) -> Run:
  (banned, t) = x
  step.drop((t > i : U32), i, u, ev, hits, sess, st, banned)

# if (banned.has(u))
def step.banned(has: Bool, +i: U32, +u: String, ev: Ev, hits: Map<&2, U32>,
                sess: Map<&2, Sess>, st: St, banned: Map<&2, U32>) -> Run:
  match has:
    case True{}:
      step.lapse(i, u, ev, hits, sess, st, Map.get(U32, 0, banned, u))
    case False{}:
      session(i, u, ev, Maps{hits, sess, banned}, st)

def step.ban(+i: U32, u: String, ev: Ev, hits: Map<&2, U32>, sess: Map<&2, Sess>, st: St,
             x: Map<&2, U32> & Bool) -> Run:
  (banned, has) = x
  step.banned(has, i, u, ev, hits, sess, st, banned)

# u = users[i]
def step.u(+i: U32, routes: Array<String>, bytes: Array<U32>, hits: Map<&2, U32>,
           sess: Map<&2, Sess>, banned: Map<&2, U32>, st: St, x: Array<String> & String) -> Run:
  (users, +u) = x
  step.ban(i, u, Ev{users, routes, bytes}, hits, sess, st, Map.has(&2, U32, banned, u))

# r = routes[i], counted
def step.r(+i: U32, users: Array<String>, bytes: Array<U32>, hits: Map<&2, U32>,
           sess: Map<&2, Sess>, banned: Map<&2, U32>, st: St, x: Array<String> & String) -> Run:
  (routes, r) = x
  step.u(i, routes, bytes, route(hits, r), sess, banned, st, Array.get(String, users, i))

def step(+i: U32, s: Run) -> Run:
  Run{ev, maps, st} = s
  Ev{users, routes, bytes} = ev
  Maps{hits, sess, banned} = maps
  step.r(i, users, bytes, hits, sess, banned, st, Array.get(String, routes, i))

def events(k: Nat, +i: U32, s: Run) -> Run:
  match k:
    case 0n:
      s
    case 1n+p:
      events(p, (i + 1 : U32), step(i, s))

# one run: three fresh maps over the event stream; the last run's result
# is the one checksummed
def kernel(s: Run) -> Run:
  Run{ev, maps, st} = s
  events(n(), 0, Run{ev, Maps{Map.new(&2, U32), Map.new(&2, Sess), Map.new(&2, U32)},
    St{0, 0, 0, 0}})

def hash_str(s: String, h: U32) -> U32:
  match s:
    case SNil{}:
      h
    case SCon{Chr{c}, t}:
      hash_str(t, B.mix(h, c))

# acc = (acc + mix(hashStr(k), v)) | 0 over a map's entries
def sum.u32(xs: List<&2, Sigma<&2, &2, String, _ => U32>>, acc: U32) -> U32:
  match xs:
    case Nil{}:
      acc
    case (k, v) <> t:
      sum.u32(t, (acc + B.mix(hash_str(k, 2166136261), v) : U32))

def sum.sess.one(k: String, v: Sess) -> U32:
  Sess{hits, bytes, first, last} = v
  B.mix(B.mix(hash_str(k, 2166136261), hits), bytes)

def sum.sess(xs: List<&2, Sigma<&2, &2, String, _ => Sess>>, acc: U32) -> U32:
  match xs:
    case Nil{}:
      acc
    case (k, v) <> t:
      sum.sess(t, (acc + sum.sess.one(k, v) : U32))

def checksum(s: Run) -> U32:
  Run{ev, maps, st} = s
  Maps{+hits, +sess, +banned} = maps
  St{dropped, closed, cbytes, longest} = st
  +h0 = B.mix(B.mix(B.mix(B.mix(2166136261, dropped), closed), cbytes), longest)
  +h1 = B.mix(B.mix(h0, U32.from_nat(Map.size(&2, U32, hits))), sum.u32(Map.to_list(&2, U32, hits), 0))
  +h2 = B.mix(B.mix(h1, U32.from_nat(Map.size(&2, Sess, sess))), sum.sess(Map.to_list(&2, Sess, sess), 0))
  B.mix(B.mix(h2, U32.from_nat(Map.size(&2, U32, banned))), sum.u32(Map.to_list(&2, U32, banned), 0))

def run(b: Bld) -> IO(Unit):
  Bld{users, routes, bytes, res} = b
  s = B.warm(~Run, ~(s => s), ~kernel, 5n,
    Run{Ev{users, routes, bytes}, Maps{Map.new(&2, U32), Map.new(&2, Sess), Map.new(&2, U32)},
      St{0, 0, 0, 0}})
  do IO<Unit>:
    r : Run & List<&2, U32> <- B.timed(~Run, ~(s => s), ~kernel, 21n, s, [])
    B.finish(~Run, ~checksum, 32768, 3, 21, r)

def main() -> IO(Unit):
  run(build(n(), 0, 305441741,
    Bld{[SNil{} : String*32768n], [SNil{} : String*32768n], [0 : U32*32768n],
      table(resources(), 0, [SNil{} : String*16n])}))
