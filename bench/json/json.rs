use std::time::Instant;

const SRC: &str = r#"{"items":[{"id":1,"kind":2,"value":10},{"id":2,"kind":3,"value":20},{"id":3,"kind":5,"value":30}],"meta":{"scale":7,"bias":11}}"#;
const N_ITERS: usize = 512;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

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

fn parse_int(p: &mut usize) -> i32 {
    let bytes = SRC.as_bytes();
    let mut v: i32 = 0;
    let mut neg = false;
    if bytes[*p] == b'-' { neg = true; *p += 1; }
    while *p < bytes.len() && bytes[*p] >= b'0' && bytes[*p] <= b'9' {
        v = v * 10 + (bytes[*p] - b'0') as i32;
        *p += 1;
    }
    if neg { -v } else { v }
}

fn skip_to(p: &mut usize, ch: u8) {
    let bytes = SRC.as_bytes();
    while *p < bytes.len() && bytes[*p] != ch { *p += 1; }
}

fn parse_and_walk() -> u32 {
    let mut h = 0x811c_9dc5u32;
    for _ in 0..N_ITERS {
        let mut p: usize = 0;
        let mut ids = [0i32; 3];
        let mut kinds = [0i32; 3];
        let mut values = [0i32; 3];
        let mut scale = 0i32;
        let mut bias = 0i32;

        skip_to(&mut p, b'[');
        p += 1;
        for j in 0..3 {
            skip_to(&mut p, b'{');
            p += 1;
            skip_to(&mut p, b':'); p += 1;
            ids[j] = parse_int(&mut p);
            skip_to(&mut p, b':'); p += 1;
            kinds[j] = parse_int(&mut p);
            skip_to(&mut p, b':'); p += 1;
            values[j] = parse_int(&mut p);
            skip_to(&mut p, b'}'); p += 1;
        }

        // parse "meta":{"scale":7,"bias":11}
        skip_to(&mut p, b'{'); p += 1;
        // "scale":7
        skip_to(&mut p, b':'); p += 1;
        scale = parse_int(&mut p);
        // "bias":11
        skip_to(&mut p, b':'); p += 1;
        bias = parse_int(&mut p);

        let mut s = bias;
        for j in 0..3 {
            s += ids[j] * scale + kinds[j] + values[j];
        }
        h = mix(h, s as u32);
    }
    h
}

fn main() {
    let mut cs = 0u32;
    for _ in 0..N_WARMUP { cs = parse_and_walk(); }

    let mut samples = [0.0; N_RUNS];
    for sample in &mut samples {
        let t0 = Instant::now();
        cs = parse_and_walk();
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples), cs, N_ITERS, 4, N_RUNS
    );
}
