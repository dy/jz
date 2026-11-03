// gainclass.rs – a chain of eight gain nodes over a 65536-sample f64 signal, an
// audio node graph in small.
//
// Ports gainclass.js as written. The Gain class is a struct owning its output
// buffer (Vec<f64>) and its gain; the constructor is Gain::new and process an
// impl method that fills the node's buffer and returns it as a slice, the next
// node's input. mkChain's array of instances is a Vec<Gain> built by push;
// render walks it in order, each node borrowing the previous node's buffer.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over a sparse stride of the
// last node's output (benchlib checksumF64).
use std::time::Instant;

const N_SAMPLES: usize = 65536;
const N_NODES: usize = 8;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

// FNV-1a over the low 32 bits of every 128th f64 (matches benchlib checksumF64,
// which strides 256 over the Uint32Array view).
fn checksum_f64(out: &[f64]) -> u32 {
    let mut h = 0x811c_9dc5u32;
    let mut i = 0usize;
    while i < out.len() {
        h = mix(h, out[i].to_bits() as u32);
        i += 128;
    }
    h
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

// XorShift32: deterministic per target. Output is in [-1, 1).
fn mk_input(n: usize) -> Vec<f64> {
    let mut out = vec![0.0f64; n];
    let mut s = 0x1234abcdu32;
    for x in out.iter_mut() {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        *x = (s as f64 / 4294967296.0) * 2.0 - 1.0;
    }
    out
}

struct Gain {
    buf: Vec<f64>,
    gain: f64,
}

impl Gain {
    fn new(n: usize, gain: f64) -> Gain {
        Gain { buf: vec![0.0f64; n], gain }
    }

    fn process(&mut self, input: &[f64]) -> &[f64] {
        let b = &mut self.buf;
        let g = self.gain;
        for i in 0..b.len() {
            b[i] = input[i] * g;
        }
        b
    }
}

fn mk_chain(n: usize, count: usize) -> Vec<Gain> {
    let mut nodes = Vec::new();
    for k in 0..count {
        nodes.push(Gain::new(n, 0.9 + k as f64 * 0.01));
    }
    nodes
}

// Hot path: every node scales the previous node's output.
fn render<'a>(input: &'a [f64], nodes: &'a mut [Gain]) -> &'a [f64] {
    let mut x = input;
    for node in nodes.iter_mut() {
        x = node.process(x);
    }
    x
}

fn main() {
    let input = mk_input(N_SAMPLES);
    let mut nodes = mk_chain(N_SAMPLES, N_NODES);

    for _ in 0..N_WARMUP {
        render(&input, &mut nodes);
    }

    let mut samples = [0.0; N_RUNS];
    let mut out: &[f64] = &input;
    for sample in &mut samples {
        let t0 = Instant::now();
        out = render(&input, &mut nodes);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    let us = median_us(&mut samples);
    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        us,
        checksum_f64(out),
        N_SAMPLES,
        N_NODES,
        N_RUNS
    );
}
