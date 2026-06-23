// json bench — ports json.zig (hand-written parser over fixed source)
let src_str = "{\"items\":[{\"id\":1,\"kind\":2,\"value\":10},{\"id\":2,\"kind\":3,\"value\":20},{\"id\":3,\"kind\":5,\"value\":30}],\"meta\":{\"scale\":7,\"bias\":11}}"
let n_iters = 512
let n_runs = 21
let n_warmup = 5

fn mix_u32(h : UInt, x : UInt) -> UInt {
  (h ^ x) * 0x01000193
}

// Parser state: pos into src (Array[Int] of char codes)
fn skip_ws(src : Array[Int], pos : Int) -> Int {
  let mut p = pos
  let len = src.length()
  while p < len {
    let c = src[p]
    if c == 32 || c == 9 || c == 10 || c == 13 {
      p = p + 1
    } else {
      break
    }
  }
  p
}

// Parse a JSON integer (digits only, no sign here — all values positive in src)
// Returns (value, new_pos)
fn parse_int(src : Array[Int], pos : Int) -> (Int, Int) {
  let mut p = pos
  let len = src.length()
  let mut v = 0
  while p < len {
    let c = src[p]
    if c >= 48 && c <= 57 {
      v = v * 10 + (c - 48)
      p = p + 1
    } else {
      break
    }
  }
  (v, p)
}

// Parse a JSON string key, return new pos after closing quote
fn parse_string(src : Array[Int], pos : Int) -> (Array[Int], Int) {
  // pos is after opening quote
  let mut p = pos
  let len = src.length()
  let chars : Array[Int] = []
  while p < len {
    let c = src[p]
    if c == 34 { // closing "
      p = p + 1
      break
    } else if c == 92 { // backslash
      p = p + 2
    } else {
      chars.push(c)
      p = p + 1
    }
  }
  (chars, p)
}

fn arr_eq(a : Array[Int], b : Array[Int]) -> Bool {
  if a.length() != b.length() {
    return false
  }
  let mut i = 0
  while i < a.length() {
    if a[i] != b[i] {
      return false
    }
    i = i + 1
  }
  true
}

fn str_to_arr(s : String) -> Array[Int] {
  let arr : Array[Int] = []
  for ch in s.to_array() {
    arr.push(ch.to_int())
  }
  arr
}

// Parse an object like {"key":val,...} where all values are integers.
// Returns a flat array of (key_arr, value) pairs as (Array[Array[Int]], Array[Int]).
// We just collect all integer values keyed by string.
// Returns new pos after '}'.
fn parse_obj_ints(src : Array[Int], start : Int) -> (Array[Array[Int]], Array[Int], Int) {
  let keys : Array[Array[Int]] = []
  let vals : Array[Int] = []
  let mut p = start // start is right after '{'
  let len = src.length()
  while p < len {
    p = skip_ws(src, p)
    let c = src[p]
    if c == 125 { // '}'
      p = p + 1
      break
    } else if c == 44 { // ','
      p = p + 1
    } else if c == 34 { // '"' key
      p = p + 1 // skip opening quote
      let (key, p2) = parse_string(src, p)
      p = p2
      p = skip_ws(src, p)
      // expect ':'
      p = p + 1
      p = skip_ws(src, p)
      // parse integer value
      let (v, p3) = parse_int(src, p)
      p = p3
      keys.push(key)
      vals.push(v)
    } else {
      p = p + 1
    }
  }
  (keys, vals, p)
}

fn get_int_by_key(keys : Array[Array[Int]], vals : Array[Int], key : String) -> Int {
  let k = str_to_arr(key)
  let mut i = 0
  while i < keys.length() {
    if arr_eq(keys[i], k) {
      return vals[i]
    }
    i = i + 1
  }
  0
}

// Parse the fixed JSON source and walk it exactly like the zig does.
// Returns h after N_ITERS iterations.
fn parse_and_walk(src : Array[Int]) -> UInt {
  let mut h : UInt = 0x811c9dc5
  // Pre-parse the structure once — but zig re-parses every iter.
  // We must re-parse each iter to match timing.
  let len = src.length()
  for _iter in 0..<n_iters {
    // Simple state machine parser for the fixed structure:
    // {"items":[{...},{...},{...}],"meta":{...}}
    let mut p = 0
    p = skip_ws(src, p)
    // expect '{'
    p = p + 1
    // We'll scan for "items" and "meta" keys
    let items_id = Array::make(3, 0)
    let items_kind = Array::make(3, 0)
    let items_value = Array::make(3, 0)
    let mut item_count = 0
    let mut scale = 0
    let mut bias = 0
    // parse top-level object entries
    let top_end = len
    let _ = top_end
    while p < len {
      p = skip_ws(src, p)
      let c = src[p]
      if c == 125 { // '}'
        p = p + 1
        break
      } else if c == 44 { // ','
        p = p + 1
      } else if c == 34 { // '"' key
        p = p + 1
        let (key, p2) = parse_string(src, p)
        p = p2
        p = skip_ws(src, p)
        p = p + 1 // skip ':'
        p = skip_ws(src, p)
        // check key
        let k_items = str_to_arr("items")
        let k_meta = str_to_arr("meta")
        if arr_eq(key, k_items) {
          // parse array of objects
          // expect '['
          p = p + 1
          while p < len {
            p = skip_ws(src, p)
            let cc = src[p]
            if cc == 93 { // ']'
              p = p + 1
              break
            } else if cc == 44 { // ','
              p = p + 1
            } else if cc == 123 { // '{'
              p = p + 1
              let (ks, vs, p3) = parse_obj_ints(src, p)
              p = p3
              if item_count < 3 {
                items_id[item_count] = get_int_by_key(ks, vs, "id")
                items_kind[item_count] = get_int_by_key(ks, vs, "kind")
                items_value[item_count] = get_int_by_key(ks, vs, "value")
                item_count = item_count + 1
              }
            } else {
              p = p + 1
            }
          }
        } else if arr_eq(key, k_meta) {
          // expect '{'
          p = p + 1
          let (ks, vs, p3) = parse_obj_ints(src, p)
          p = p3
          scale = get_int_by_key(ks, vs, "scale")
          bias = get_int_by_key(ks, vs, "bias")
        } else {
          // skip value
          p = p + 1
        }
      } else {
        p = p + 1
      }
    }
    // walk: s = bias + sum(id*scale + kind + value)
    let mut s : Int = bias
    for idx in 0..<item_count {
      s = (s + items_id[idx] * scale + items_kind[idx] + items_value[idx])
    }
    h = mix_u32(h, s.reinterpret_as_uint())
  }
  h
}

fn main {
  // Build src array once
  let src : Array[Int] = []
  for ch in src_str.to_array() {
    src.push(ch.to_int())
  }
  let mut cs : UInt = 0
  for _i in 0..<n_warmup {
    cs = parse_and_walk(src)
  }
  let samples = Array::make(n_runs, 0.0)
  for i in 0..<n_runs {
    let t = @bench.monotonic_clock_start()
    cs = parse_and_walk(src)
    samples[i] = @bench.monotonic_clock_end(t)
  }
  let med = median_us(samples, n_runs)
  print_result(med, cs, n_iters, 4, n_runs)
}
