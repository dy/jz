// mapint.goose: Goose port of mapint.js (same edge list, searches and
// checksum): graph analytics over sparse 30-bit ids with integer-keyed maps,
// the standard library's dictionary. An adjacency list is a run of a slice
// pool (`reusable[]`), the map's value its slice and length, doubled in place
// or moved by realloc_slice when full, as a growable array grows; the degree
// histogram and each search's distances are dictionaries too, over a queue of
// ids.

import bench from "../_lib";
import dictionary;

let NODES = 1 << 12;
let EDGES = 3 * NODES;
let SOURCES = 4;
let N_RUNS = 21;
let N_WARMUP = 5;

struct Adj { list: i32[:], len: i64 }

// a node number to its id: a bijective scramble of 30 bits
fn id_of(n: u32) -> i32 {
    var x = ((n + 1) * 0x2c1b3c6d) & 0x3fffffff;
    x ^= x >> 15;
    return ((x * 0x297a2d39) & 0x3fffffff) as i32;
}

fn build_edges(src: i32[:], dst: i32[:]) {
    var s: u32 = 0x2545f491;
    for i in EDGES {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        let a = (s >> 2) & (NODES - 1);
        let b = if s & 1 == 0 { (s >> 16) & 1023 } else { (s >> 16) & (NODES - 1) };
        src[i] = id_of(a);
        dst[i] = id_of(if b == a { (a + 1) & (NODES - 1) } else { b });
    }
}

// list.push(v) on the list of key in adj, a new list on a miss
fn push(lists: i32[>..]&, adj: dictionary<i32, Adj>&, key: i32, v: i32) {
    let l .= adj.get_or_insert(key, Adj { lists[0..0], 0 });
    if l.len == l.list.len {
        l.list = if l.len == 0 { lists.alloc_slice(4) } else { lists.realloc_slice(l.list, l.len * 2) };
    }
    l.list[l.len] = v;
    l.len += 1;
}

fn analyze(src: i32[:], dst: i32[:], degrees: dictionary<i64, i32>&, searches: u32[8]&) -> i64 {
    reusable[] var lists: i32[>..] = [];
    var adj = dictionary<i32, Adj> {};
    for i in src.len {
        push(lists, adj, src[i], dst[i]);
        push(lists, adj, dst[i], src[i]);
    }
    adj.each() { id, l => degrees.update(l.len, 0) { it += 1; }; };
    var queue: i32[>..] = [];
    for k in SOURCES {
        let root = src[(k * 6151) % src.len];
        var dist = dictionary<i32, u32> {};
        dist.insert(root, 0);
        queue.clear();
        queue.push(root);
        var sum: u32 = 0;
        var head = 0;
        while head < queue.len {
            let v = queue[head];
            head += 1;
            let dv = dist.get(v);
            guard dv else { abort("unreached node in the queue"); }
            let d = dv + 1;
            let l .= adj.get(v);
            guard l else { abort("node without a list"); }
            for w in l.list[..l.len] {
                if !dist.contains(w) {
                    dist.insert(w, d);
                    sum += d;
                    queue.push(w);
                }
            }
        }
        searches[k * 2] = dist.count as! u32;
        searches[k * 2 + 1] = sum;
    }
    return adj.count;
}

fn checksum(nodes: i64, degrees: dictionary<i64, i32>&, searches: u32[8]&) -> u32 {
    var h = mix(0x811c9dc5, nodes as! u32);
    var acc: u32 = 0;
    degrees.each() { deg, count => acc += mix(deg as! u32, count as! u32); };
    h = mix(mix(h, degrees.count as! u32), acc);
    for x in searches { h = mix(h, x); }
    return h;
}

fn main() {
    var src: i32[>..] = [];
    var dst: i32[>..] = [];
    src.resize(EDGES, 0);
    dst.resize(EDGES, 0);
    build_edges(src, dst);
    var cs: u32 = 0;
    var searches: u32[8] = [0; 8];
    for i in N_WARMUP {
        var degrees = dictionary<i64, i32> {};
        let nodes = analyze(src, dst, degrees, searches);
        cs = checksum(nodes, degrees, searches);
    }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        var degrees = dictionary<i64, i32> {};
        let t0 = now_ms();
        let nodes = analyze(src, dst, degrees, searches);
        t = now_ms() - t0;
        cs = checksum(nodes, degrees, searches);
    }
    print_result(median_us(samples), cs, EDGES, 3, N_RUNS);
}
