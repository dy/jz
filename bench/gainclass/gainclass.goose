// gainclass.goose: Goose port of gainclass.js (same input, chain and
// checksum): a chain of eight gain nodes, each scaling the previous node's
// output into a buffer of its own. A node is an inline record holding its
// gain and its buffer, and the chain one grow-only array of them, walked in
// order.

import bench from "../_lib";

let N_SAMPLES = 65536;
let N_NODES = 8;
let N_RUNS = 21;
let N_WARMUP = 5;

struct Gain { gain: f64, buf: f64[] }

fn mk_input(n: i64) -> f64[>..] {
    var out: f64[>..] = [];
    var s: u32 = 0x1234abcd;
    for i in n {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        out.push(s / 4294967296.0 * 2 - 1);
    }
    return out;
}

fn zeros(n: i64) -> f64[>..] {
    var b: f64[>..] = [];
    b.resize(n, 0.0);
    return b;
}

fn mk_chain(n: i64, count: i64) -> Gain[>..] {
    var nodes: Gain[>..] = [];
    for k in count { nodes.push(Gain { gain: 0.9 + k * 0.01, buf: zeros(n) }); }
    return nodes;
}

fn process(node: Gain&, input: f64[:]) {
    let g = node.gain;
    for i in node.buf.len { node.buf[i] = input[i] * g; }
}

fn render(input: f64[:], nodes: Gain[>..]&) -> f64[:] {
    var x = input;
    for node in nodes {
        process(node, x);
        x = node.buf;
    }
    return x;
}

fn main() {
    let input = mk_input(N_SAMPLES);
    var nodes = mk_chain(N_SAMPLES, N_NODES);
    for i in N_WARMUP { render(input, nodes); }

    var samples = [0.0; N_RUNS];
    var out = input[..];
    for &t in samples {
        let t0 = now_ms();
        out = render(input, nodes);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum_f64(out), N_SAMPLES, N_NODES, N_RUNS);
}
