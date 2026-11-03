// mapstr.goose: Goose port of mapstr.js (same event stream, passes and
// checksum): sessionizing a request log with string-keyed maps. Each event's
// user and route are inline strings of their own (u8[..12], u8[..24]), equal in
// text to earlier ones but never the same bytes; the maps are the standard
// library's dictionary keyed by views of them, so each lookup hashes and
// compares text. A sweep notes the idle sessions as it walks the table, then
// removes them, since a dictionary is not changed during its own `each`.

import bench from "../_lib";
import dictionary;

let N = 1 << 15;            // events per pass
let NUSERS = 4096;
let NROUTES = 96;
let WINDOW = 2048;          // a session idle this many events closes
let SWEEP = 512;            // events between sweeps
let BURST = 48;             // hits within one session that earn a ban
let PENALTY = 1024;         // events a ban lasts
let N_RUNS = 21;
let N_WARMUP = 5;

let RESOURCES = ["users", "orders", "items", "carts", "search", "auth", "images", "reviews",
                 "stock", "prices", "tags", "stats"];

struct Session { hits: i32, bytes: i32, first: i32, last: i32 }

struct Stats { dropped: i32, closed: i32, closed_bytes: i32, longest: i32 }

fn build_events(users: u8[..12][>..]&, routes: u8[..24][>..]&, bytes: i32[>..]&) {
    var s: u32 = 0x1234abcd;
    for i in N {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        let u = if s & 1 == 0 { (s >> 1) & 63 } else { (s >> 1) & (NUSERS - 1) };
        let r = (s >> 13) % NROUTES;
        var user: u8[..12] = [];
        format(user, "user", u);
        users.push(user);
        var route: u8[..24] = [];
        format(route, "/api/v", 1 + r % 3, "/", RESOURCES[r % RESOURCES.len], "/", r >> 2);
        routes.push(route);
        bytes.push((200 + ((s >> 20) & 4095)) as i32);
    }
}

fn run(users: u8[..12][:], routes: u8[..24][:], bytes: i32[:], route_hits: dictionary<u8[:], i32>&,
       sessions: dictionary<u8[:], Session>&, banned: dictionary<u8[:], i32>&) -> Stats {
    var res = Stats { 0, 0, 0, 0 };
    var idle: (u8[:])[>..] = [];
    for i: i32 in 0..N {
        route_hits.update(routes[i], 0) { it += 1; };
        let u .= users[i];
        let until = banned.get(u);
        if until {
            if until > i { res.dropped += 1; continue; }
            banned.remove(u);
        }
        let s .= sessions.get_or_insert(u, Session { 0, 0, i, i });
        s.hits += 1;
        s.bytes += bytes[i];
        s.last = i;
        if s.hits % BURST == 0 { banned.insert(u, i + PENALTY); }
        if i % SWEEP == SWEEP - 1 {
            sessions.each() { k, v =>
                if i - v.last > WINDOW {
                    res.closed += 1;
                    res.closed_bytes = (res.closed_bytes as! u32 + v.bytes as! u32) as! i32;
                    if v.last - v.first > res.longest { res.longest = v.last - v.first; }
                    idle.push(k);
                }
            };
            for k in idle { sessions.remove(k); }
            idle.clear();
        }
    }
    return res;
}

fn hash_str(s: u8[:]) -> u32 {
    var h: u32 = 0x811c9dc5;
    for c in s { h = mix(h, c); }
    return h;
}

fn checksum(r: Stats, route_hits: dictionary<u8[:], i32>&, sessions: dictionary<u8[:], Session>&,
            banned: dictionary<u8[:], i32>&) -> u32 {
    var h = mix(mix(mix(mix(0x811c9dc5, r.dropped as! u32), r.closed as! u32),
                    r.closed_bytes as! u32), r.longest as! u32);
    var acc: u32 = 0;
    route_hits.each() { k, v => acc += mix(hash_str(k), v as! u32); };
    h = mix(mix(h, route_hits.count as! u32), acc);
    acc = 0;
    sessions.each() { k, v => acc += mix(mix(hash_str(k), v.hits as! u32), v.bytes as! u32); };
    h = mix(mix(h, sessions.count as! u32), acc);
    acc = 0;
    banned.each() { k, v => acc += mix(hash_str(k), v as! u32); };
    return mix(mix(h, banned.count as! u32), acc);
}

fn main() {
    var users: u8[..12][>..] = [];
    var routes: u8[..24][>..] = [];
    var bytes: i32[>..] = [];
    build_events(users, routes, bytes);
    var cs: u32 = 0;
    for i in N_WARMUP {
        var route_hits = dictionary<u8[:], i32> {};
        var sessions = dictionary<u8[:], Session> {};
        var banned = dictionary<u8[:], i32> {};
        let r = run(users, routes, bytes, route_hits, sessions, banned);
        cs = checksum(r, route_hits, sessions, banned);
    }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        var route_hits = dictionary<u8[:], i32> {};
        var sessions = dictionary<u8[:], Session> {};
        var banned = dictionary<u8[:], i32> {};
        let t0 = now_ms();
        let r = run(users, routes, bytes, route_hits, sessions, banned);
        t = now_ms() - t0;
        cs = checksum(r, route_hits, sessions, banned);
    }
    print_result(median_us(samples), cs, N, 3, N_RUNS);
}
