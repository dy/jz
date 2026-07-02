// Token-frequency counting kernel (string-keyed map) — ports wordcount.js
let nwords = 512 // distinct words in the vocabulary
let n = 16384 // 1 << 14, tokens per pass
let nprobes = 64
let n_iters = 16
let n_runs = 21

// Deterministic vocabulary — 512 words of 3–8 lowercase chars from XorShift32,
// identical per target.
fn build_words() -> Array[String] {
  let words = Array::make(nwords, "")
  let mut s : UInt = 0x1234abcd
  for i in 0..<nwords {
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    let len = 3 + ((s >> 8) % 6).reinterpret_as_int()
    let chars : Array[Char] = []
    let mut x = s
    for j in 0..<len {
      x = x * 0x9e3779b1 + j.reinterpret_as_uint()
      let ch = 97 + ((x >> 16) % 26).reinterpret_as_int()
      chars.push(Char::from_int(ch))
    }
    words[i] = String::from_array(chars)
  }
  words
}

// Skewed token stream — half the traffic hits 16 hot words (Zipf-ish),
// the rest spreads over the whole vocabulary.
fn fill_tokens(toks : Array[Int]) -> Unit {
  let mut s : UInt = 0x2545f491
  for i in 0..<n {
    s = s ^ (s << 13)
    s = s ^ (s >> 17)
    s = s ^ (s << 5)
    toks[i] = if (s & 8) == 0 {
      ((s >> 4) & 15).reinterpret_as_int()
    } else {
      ((s >> 4) & 511).reinterpret_as_int()
    }
  }
}

fn run_kernel(
  words : Array[String],
  toks : Array[Int],
  probes : Array[String],
) -> UInt {
  let mut h : UInt = 0x811c9dc5
  for _it in 0..<n_iters {
    let counts : Map[String, Int] = Map::new()
    for i in 0..<n {
      let w = words[toks[i]]
      counts[w] = counts.get_or_default(w, 0) + 1
    }
    for j in 0..<nprobes {
      h = mix(h, counts.get_or_default(probes[j], 0).reinterpret_as_uint())
    }
  }
  h
}

fn main {
  let words = build_words()
  let toks = Array::make(n, 0)
  fill_tokens(toks)
  // Probe every 8th word plus 8 absent keys — a missing count reads 0.
  let probes = Array::make(nprobes, "")
  for j in 0..<(nprobes - 8) {
    probes[j] = words[(j * 8) & (nwords - 1)]
  }
  for j in 0..<8 {
    probes[nprobes - 8 + j] = "zz\{j}"
  }
  let mut cs : UInt = 0
  // warmup
  for _i in 0..<5 {
    cs = run_kernel(words, toks, probes)
  }
  let samples = Array::make(n_runs, 0.0)
  for i in 0..<n_runs {
    let t = @bench.monotonic_clock_start()
    cs = run_kernel(words, toks, probes)
    samples[i] = @bench.monotonic_clock_end(t)
  }
  let med = median_us(samples, n_runs)
  print_result(med, cs, n * n_iters, nwords, n_runs)
}
