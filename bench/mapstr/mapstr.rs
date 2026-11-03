// mapstr.rs – sessionizing a request log with string-keyed maps: per event,
// count the route, find or open the user's session, drop the event while the
// user is rate-limited, ban users that exceed a burst, and every 512 events
// close the sessions idle for a window. Rust's idiomatic answer is
// HashMap<&str, T> with the entry API and `retain` for the sweep; the keys
// are fresh strings per event, as a parser hands them over. Map folds are
// sums, so the map's iteration order changes nothing.
//
// Reports: median ms across N_RUNS, throughput in events/µs, FNV-1a checksum
// over closed-session statistics and the final maps.
use std::collections::HashMap;
use std::time::Instant;

const N: usize = 1 << 15; // events per pass
const NUSERS: u32 = 4096;
const NROUTES: u32 = 96;
const WINDOW: i32 = 2048; // a session idle this many events closes
const SWEEP: usize = 512; // events between sweeps
const BURST: i32 = 48; // hits within one session that earn a ban
const PENALTY: i32 = 1024; // events a ban lasts
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

const RESOURCES: [&str; 12] = ["users", "orders", "items", "carts", "search", "auth", "images", "reviews",
    "stock", "prices", "tags", "stats"];

struct Session { hits: i32, bytes: i32, first: i32, last: i32 }

struct Result<'a> {
    route_hits: HashMap<&'a str, i32>,
    sessions: HashMap<&'a str, Session>,
    banned: HashMap<&'a str, i32>,
    dropped: i32, closed: i32, closed_bytes: i32, longest: i32,
}

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

fn median_us(samples: &mut [f64]) -> u64 {
    for i in 1..samples.len() {
        let v = samples[i];
        let mut j = i;
        while j > 0 && samples[j - 1] > v {
            samples[j] = samples[j - 1];
            j -= 1;
        }
        samples[j] = v;
    }
    (samples[(samples.len() - 1) >> 1] * 1000.0) as u64
}

fn build_events(users: &mut Vec<String>, routes: &mut Vec<String>, bytes: &mut Vec<i32>) {
    let mut s: u32 = 0x1234abcd;
    for _ in 0..N {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        let u = if s & 1 == 0 { (s >> 1) & 63 } else { (s >> 1) & (NUSERS - 1) };
        let r = (s >> 13) % NROUTES;
        users.push(format!("user{}", u));
        routes.push(format!("/api/v{}/{}/{}", 1 + r % 3, RESOURCES[(r % 12) as usize], r >> 2));
        bytes.push(200 + ((s >> 20) & 4095) as i32);
    }
}

fn run<'a>(users: &'a [String], routes: &'a [String], bytes: &[i32]) -> Result<'a> {
    let mut res = Result { route_hits: HashMap::new(), sessions: HashMap::new(), banned: HashMap::new(),
        dropped: 0, closed: 0, closed_bytes: 0, longest: 0 };
    for i in 0..N {
        let t = i as i32;
        *res.route_hits.entry(routes[i].as_str()).or_insert(0) += 1;
        let u = users[i].as_str();
        if let Some(&until) = res.banned.get(u) {
            if until > t { res.dropped += 1; continue; }
            res.banned.remove(u);
        }
        let s = res.sessions.entry(u).or_insert(Session { hits: 0, bytes: 0, first: t, last: t });
        s.hits += 1;
        s.bytes += bytes[i];
        s.last = t;
        if s.hits % BURST == 0 { res.banned.insert(u, t + PENALTY); }
        if i % SWEEP == SWEEP - 1 {
            let (closed, closed_bytes, longest) = (&mut res.closed, &mut res.closed_bytes, &mut res.longest);
            res.sessions.retain(|_, v| {
                if t - v.last <= WINDOW { return true; }
                *closed += 1;
                *closed_bytes = closed_bytes.wrapping_add(v.bytes);
                if v.last - v.first > *longest { *longest = v.last - v.first; }
                false
            });
        }
    }
    res
}

fn hash_str(s: &str) -> u32 {
    s.bytes().fold(0x811c9dc5, |h, b| mix(h, b as u32)) // ASCII keys: bytes are the UTF-16 code units
}

fn checksum(r: &Result) -> u32 {
    let mut h = mix(mix(mix(mix(0x811c9dc5, r.dropped as u32), r.closed as u32), r.closed_bytes as u32), r.longest as u32);
    let acc = r.route_hits.iter().fold(0u32, |a, (k, &v)| a.wrapping_add(mix(hash_str(k), v as u32)));
    h = mix(mix(h, r.route_hits.len() as u32), acc);
    let acc = r.sessions.iter().fold(0u32, |a, (k, v)| a.wrapping_add(mix(mix(hash_str(k), v.hits as u32), v.bytes as u32)));
    h = mix(mix(h, r.sessions.len() as u32), acc);
    let acc = r.banned.iter().fold(0u32, |a, (k, &v)| a.wrapping_add(mix(hash_str(k), v as u32)));
    mix(mix(h, r.banned.len() as u32), acc)
}

fn main() {
    let (mut users, mut routes, mut bytes) = (Vec::with_capacity(N), Vec::with_capacity(N), Vec::with_capacity(N));
    build_events(&mut users, &mut routes, &mut bytes);
    let mut r = run(&users, &routes, &bytes);
    for _ in 1..N_WARMUP { r = run(&users, &routes, &bytes); }

    let mut samples = [0.0f64; N_RUNS];
    for s in samples.iter_mut() {
        let t0 = Instant::now();
        r = run(&users, &routes, &bytes); // drops the previous run's maps, as a GC would reclaim them
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }
    println!("median_us={} checksum={} samples={} stages={} runs={}", median_us(&mut samples), checksum(&r), N, 3, N_RUNS);
}
