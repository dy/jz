// qoi bench kernel — ports qoi.zig
let npix = 65536  // 256*256
let img_len = 262144  // NPIX*4
let cap = 327744  // NPIX*5+64
let n_iters = 10
let n_runs = 21
let n_warmup = 5

fn mix_u32(h : UInt, x : UInt) -> UInt {
  (h ^ x) * 0x01000193
}

fn mk_image(img : Array[UInt]) -> Unit {
  let mut x : UInt = 0x12345678
  let mut r : UInt = 128
  let mut g : UInt = 128
  let mut b : UInt = 128
  let mut a : UInt = 255
  for p in 0..<npix {
    x = x * 1103515245 + 12345
    let roll = (x >> 28) & 7
    if roll < 3 {
      // keep previous pixel - run-length
    } else if roll < 6 {
      r = (r + ((x >> 4) & 3) - 1) & 0xff
      g = (g + ((x >> 6) & 3) - 1) & 0xff
      b = (b + ((x >> 8) & 3) - 1) & 0xff
    } else if roll == 6 {
      r = (x >> 10) & 255
      g = (x >> 16) & 255
      b = (x >> 20) & 255
    } else {
      a = (x >> 12) & 255
    }
    let o = p << 2
    img[o] = r; img[o + 1] = g; img[o + 2] = b; img[o + 3] = a
  }
}

fn encode(img : Array[UInt], ir : Array[UInt], ig : Array[UInt], ib : Array[UInt], ia : Array[UInt], out : Array[UInt]) -> Int {
  for i in 0..<64 { ir[i] = 0; ig[i] = 0; ib[i] = 0; ia[i] = 0 }
  let mut pr : UInt = 0
  let mut pg : UInt = 0
  let mut pb : UInt = 0
  let mut pa : UInt = 255
  let mut run = 0
  let mut op = 0
  for p in 0..<npix {
    let o = p << 2
    let r = img[o]; let g = img[o + 1]; let b = img[o + 2]; let a = img[o + 3]
    if r == pr && g == pg && b == pb && a == pa {
      run = run + 1
      if run == 62 || p == npix - 1 {
        out[op] = 0xc0 | (run - 1).reinterpret_as_uint(); op = op + 1; run = 0
      }
    } else {
      if run > 0 { out[op] = 0xc0 | (run - 1).reinterpret_as_uint(); op = op + 1; run = 0 }
      let h = ((r * 3 + g * 5 + b * 7 + a * 11) & 63).to_int()
      if ir[h] == r && ig[h] == g && ib[h] == b && ia[h] == a {
        out[op] = h.reinterpret_as_uint(); op = op + 1
      } else {
        ir[h] = r; ig[h] = g; ib[h] = b; ia[h] = a
        if a == pa {
          // signed delta: (r - pr) as i8
          let dr = (r - pr) & 0xff
          let dg = (g - pg) & 0xff
          let db = (b - pb) & 0xff
          let vr = if dr >= 128 { dr.to_int() - 256 } else { dr.to_int() }
          let vg = if dg >= 128 { dg.to_int() - 256 } else { dg.to_int() }
          let vb = if db >= 128 { db.to_int() - 256 } else { db.to_int() }
          let vgr = vr - vg
          let vgb = vb - vg
          if vr >= -2 && vr <= 1 && vg >= -2 && vg <= 1 && vb >= -2 && vb <= 1 {
            out[op] = (0x40 | ((vr + 2) << 4) | ((vg + 2) << 2) | (vb + 2)).reinterpret_as_uint(); op = op + 1
          } else if vgr >= -8 && vgr <= 7 && vg >= -32 && vg <= 31 && vgb >= -8 && vgb <= 7 {
            out[op] = (0x80 | (vg + 32)).reinterpret_as_uint(); op = op + 1
            out[op] = (((vgr + 8) << 4) | (vgb + 8)).reinterpret_as_uint(); op = op + 1
          } else {
            out[op] = 0xfe; op = op + 1; out[op] = r; op = op + 1; out[op] = g; op = op + 1; out[op] = b; op = op + 1
          }
        } else {
          out[op] = 0xff; op = op + 1; out[op] = r; op = op + 1; out[op] = g; op = op + 1; out[op] = b; op = op + 1; out[op] = a; op = op + 1
        }
      }
    }
    pr = r; pg = g; pb = b; pa = a
  }
  op
}

fn decode(inp : Array[UInt], clen : Int, ir : Array[UInt], ig : Array[UInt], ib : Array[UInt], ia : Array[UInt], out : Array[UInt]) -> Unit {
  for i in 0..<64 { ir[i] = 0; ig[i] = 0; ib[i] = 0; ia[i] = 0 }
  let mut pr : UInt = 0
  let mut pg : UInt = 0
  let mut pb : UInt = 0
  let mut pa : UInt = 255
  let mut run = 0
  let mut ip = 0
  for p in 0..<npix {
    if run > 0 {
      run = run - 1
    } else if ip < clen {
      let b0 = inp[ip].to_int(); ip = ip + 1
      if b0 == 0xfe {
        pr = inp[ip]; ip = ip + 1; pg = inp[ip]; ip = ip + 1; pb = inp[ip]; ip = ip + 1
      } else if b0 == 0xff {
        pr = inp[ip]; ip = ip + 1; pg = inp[ip]; ip = ip + 1; pb = inp[ip]; ip = ip + 1; pa = inp[ip]; ip = ip + 1
      } else if (b0 & 0xc0) == 0x00 {
        let idx = b0
        pr = ir[idx]; pg = ig[idx]; pb = ib[idx]; pa = ia[idx]
      } else if (b0 & 0xc0) == 0x40 {
        pr = ((pr.to_int() + ((b0 >> 4) & 3) - 2) & 255).reinterpret_as_uint()
        pg = ((pg.to_int() + ((b0 >> 2) & 3) - 2) & 255).reinterpret_as_uint()
        pb = ((pb.to_int() + (b0 & 3) - 2) & 255).reinterpret_as_uint()
      } else if (b0 & 0xc0) == 0x80 {
        let b1 = inp[ip].to_int(); ip = ip + 1
        let vg = (b0 & 63) - 32
        pr = ((pr.to_int() + vg + ((b1 >> 4) & 15) - 8) & 255).reinterpret_as_uint()
        pg = ((pg.to_int() + vg) & 255).reinterpret_as_uint()
        pb = ((pb.to_int() + vg + (b1 & 15) - 8) & 255).reinterpret_as_uint()
      } else {
        run = b0 & 63
      }
      let h = ((pr * 3 + pg * 5 + pb * 7 + pa * 11) & 63).to_int()
      ir[h] = pr; ig[h] = pg; ib[h] = pb; ia[h] = pa
    }
    let o = p << 2
    out[o] = pr; out[o + 1] = pg; out[o + 2] = pb; out[o + 3] = pa
  }
}

fn run_kernel(img : Array[UInt], ir : Array[UInt], ig : Array[UInt], ib : Array[UInt], ia : Array[UInt], comp : Array[UInt], dec : Array[UInt]) -> UInt {
  let mut h : UInt = 0
  for it in 0..<n_iters {
    let clen = encode(img, ir, ig, ib, ia, comp)
    decode(comp, clen, ir, ig, ib, ia, dec)
    let mut ok : UInt = 1
    for i in 0..<img_len {
      if dec[i] != img[i] { ok = 0 }
    }
    h = mix_u32(h, clen.reinterpret_as_uint())
    for i in 0..<clen {
      h = mix_u32(h, comp[i])
    }
    h = mix_u32(h, ok)
    let j = (it % npix) << 2
    img[j] = (img[j] + 1) & 0xff
  }
  h
}

fn main {
  let img = Array::make(img_len, 0U)
  let comp = Array::make(cap, 0U)
  let dec = Array::make(img_len, 0U)
  let ir = Array::make(64, 0U)
  let ig = Array::make(64, 0U)
  let ib = Array::make(64, 0U)
  let ia = Array::make(64, 0U)
  mk_image(img)
  let mut cs : UInt = 0
  for _i in 0..<n_warmup {
    cs = run_kernel(img, ir, ig, ib, ia, comp, dec)
  }
  let samples = Array::make(n_runs, 0.0)
  for i in 0..<n_runs {
    let t = @bench.monotonic_clock_start()
    cs = run_kernel(img, ir, ig, ib, ia, comp, dec)
    samples[i] = @bench.monotonic_clock_end(t)
  }
  let med = median_us(samples, n_runs)
  print_result(med, cs, npix * n_iters, 1, n_runs)
}
