// synth — ports synth.zig
let sr : Double = 44100.0
let n_notes = 64
let note_len = 8192
let n : Int = n_notes * note_len
let n_runs = 21
let n_warmup = 5

let attack : Double = 400.0
let decay : Double = 1600.0
let release : Double = 2400.0
let note_len_f : Double = 8192.0
let sustain : Double = 0.6

let b0 : Double = 0.0675
let b1 : Double = 0.135
let b2 : Double = 0.0675
let a1 : Double = -1.143
let a2 : Double = 0.412

let freqs : Array[Double] = [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88, 523.25]

fn sin_tau(ph : Double) -> Double {
  let q = ph * 4.0
  let m = (q + 0.5).floor()
  let phi = (q - m) * 1.5707963267948966
  let p2 = phi * phi
  let sp = phi * (1.0 + p2 * (-0.16666666666666666 + p2 * (0.008333333333333333 + p2 * (-0.0001984126984126984 + p2 * (2.7557319223985893e-06 + p2 * -2.505210838544172e-08)))))
  let cp = 1.0 + p2 * (-0.5 + p2 * (0.041666666666666664 + p2 * (-0.001388888888888889 + p2 * (2.48015873015873e-05 + p2 * -2.7557319223985894e-07))))
  let r = m.to_int() & 3
  if r == 0 { sp } else if r == 1 { cp } else if r == 2 { -sp } else { -cp }
}

fn render(out : Array[Double]) -> Unit {
  let mut x1 = 0.0
  let mut x2 = 0.0
  let mut y1 = 0.0
  let mut y2 = 0.0
  for note in 0..<n_notes {
    let oct : Double = if ((note >> 2) & 1) != 0 { 2.0 } else { 1.0 }
    let freq = freqs[(note * 3 + 1) & 7] * oct
    let dph = freq / sr
    let mut ph = 0.0
    let off = note * note_len
    for t in 0..<note_len {
      let tf = t.to_double()
      let env : Double = if tf < attack {
        tf / attack
      } else if tf < attack + decay {
        1.0 - (1.0 - sustain) * (tf - attack) / decay
      } else if tf < note_len_f - release {
        sustain
      } else {
        (note_len_f - tf) / release * sustain
      }
      let s = sin_tau(ph) * env
      ph = ph + dph
      if ph >= 1.0 { ph = ph - 1.0 }
      let y = b0 * s + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      x2 = x1
      x1 = s
      y2 = y1
      y1 = y
      out[off + t] = y
    }
  }
}

fn main {
  let out = Array::make(n, 0.0)
  let med = measure(n_warmup, n_runs, fn() { render(out) })
  print_result(med, checksum_f64(out), n, n_notes, n_runs)
}
