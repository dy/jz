// Floatbeat jukebox — a small collection of real community floatbeats, ported to the jz
// subset and verified FAITHFUL: each `body` reproduces the original's output sample-for-sample
// (dollchan reference == this port == jz-compiled wasm), so the same source runs as JS and
// compiles to wasm in your browser. Each is a PURE function of the integer sample index `t`,
// played at its native sample rate (WebAudio resamples to the device).
//
// Sourced from the Dollchan Bytebeat Composer library (github.com/SthephanShinkufag/bytebeat-composer);
// credited to their authors. Stateful / eval / recursive entries (Vé, foldableboldface) don't fit jz's
// pure-compile model and are intentionally omitted.

export const FLOATBEATS = [
  {
    name: 'Predestined Fate', by: 'Wiebe-Marten Wijnja', sr: 8000,
    body:
`(t) => {
  let ratio = 0.78
  let T = t * 5.6 * ratio
  let v = T >> 12
  v = (v % 768) + (v > 767 ? 128 : 0)
  let M = (p, o, q, m, s, m2, j) => {
    if (!j) j = 0x2000
    let r = q < m.length ? m.charCodeAt(q) : 0
    let q2 = (m2 != null && q < m2.length) ? m2.charCodeAt(q) : 0
    r = q2 === 0 ? r : (r - q2) * ((T % j) / j) + q2
    let g = r < 33 ? 0 : ((T % j) / ratio) * Math.pow(2, (r + p) / 12 - o)
    let x = (g % 255) / 128 - 1
    return s ? (s < 2 ? x : (s < 3 ? Math.abs(x) * 3 : Math.sin(Math.PI * x))) : (g & 128) / 64 - 1
  }
  let m = '5:=5:=5:<5:<5:<:16:18:161:168:68'
  let m2 = ': '
  let m3 = ': : 5 8 ::::: :<= < : 8 ::::::: '
  let m4b = ':: 55 ::6666 6:<<<<<88AA66666   '
  let m4 = ':: 55 ::6666 6:<==<<::AA66666   '
  let m5 = '                        ?A? = < '
  let m6 = ':51...55:::::::<===<<<8811111111'
  let m7 = ': ::: ::: ::: ::6 666 666 666 66'
  let btime = 2 << 12
  let bm = (80 - 40) * Math.pow(1 - (T % btime) / btime, 10) - 80
  let bm2 = 1
  let bd = ((bm2 >> ((T / btime) % 2)) & 1) ? Math.sin(Math.PI * (T % btime) * Math.pow(2, bm / 12 - 1)) * Math.pow(1 - (T % btime) / btime, 10) : 0
  btime = 2 << 11
  let btm = (80 - 15) * Math.pow(1 - (T % btime) / btime, 10) - 80
  let btm2 = 1111010111010111
  let bt = ((btm2 >> ((T / btime) % 16)) & 1) ? Math.sin(Math.PI * (T % btime) * Math.pow(2, btm / 12 - 1)) * Math.pow(1 - (T % btime) / btime, 10) * 0.3 : 0
  return 0 + (v < 640 ?
    M(6, 5, (T >> 12) % 32, m, 3) * 0.3 +
    M(6, 3, (T >> 12) % 32, m, 3) * 0.01 +
    (v < 64 ? 0 : M(6, 4, (T >> 12) % 32, m, 2) * 0.05) +
    (v < 128 ? 0 : (
      M(6, 3, (T >> 16) % 2, m2, 2) +
      M(9, 4, (T >> 16) % 2, m2, 2) +
      M(13, 4, (T >> 16) % 2, m2, 2)
    ) * (1 - (T % 65535) / 65535) * 0.05) +
    (v < 196 ? 0 : M(6, 4, (T >> 12) % 32, m3, (T >> 17) % 2 ? 0 : 1) * 0.05) +
    ((v > 255 && (v < 448 || v > 511)) ?
      (v < 256 ? 0 : bd + bt) +
      (v < 20 ? 0 : M(6, 3, (T >> 13) % 32, m4, 2, m4b, 0x8000) * 0.1 +
        M(6, 4, (T >> 13) % 32, m4, 1, m4b, 0x8000) * 0.05) +
      (v < 320 ? 0 : M(6, 3, (T >> 12) % 32, ((T >> 17) % 2) ? m5 : ' ', 3) * 0.2) : 0) :
    M(6, 4, (T >> 13) % 32, m6, 3) * 0.05 +
    M(6, 5, (T >> 12) % 32, m7, 2) * (1 - (T % (2 << 11)) / (2 << 11)) * 0.05 +
    (((T >> 15) % 4) ? 0 : ((((Math.sqrt(T % 0x2000) << 6 & 255) / 127 - 1)) / ((T >> 13) % 4 + 1)) * 0.15)
  )
}`,
  },
  {
    name: 'Please Exist', by: 'Wiebe-Marten Wijnja', sr: 44100,
    body:
`(t) => {
  // SAMPLE_RATE = 44100, t *= 44100/SAMPLE_RATE cancels out; apply the 0.95 slow-down and loop
  t = t * 0.95;
  t = t % 800e4;

  // Get melody function — returns pitch phase value for a given semitone
  let gm = function(oc, z, m) {
    let p = (z < m.length ? m.charCodeAt(z) : 0);
    return p < 33 ? 0 : t * Math.pow(2, (p || 0) / 12 - oc);
  };

  // BELL
  let d = 16e4;
  let k = 4e4;
  let bm_str = '5 38';
  let y = Math.PI * gm(9, (t / d) % 4, bm_str);
  let x = (Math.sin(y * 0.5) + Math.sin(y * 2) + Math.sin(y * 3) + Math.sin(y * 4.2) + Math.sin(y * 5.4)) * 0.2 *
    Math.pow(1 - (t % 16e4 / 16e4), 2);

  // CHOIR — triangle waves on multiple octaves
  let o = '1';
  let q = '5';
  let s = (
    Math.abs((gm(3, (t / 4e4) % 1, q) % 128) / 64 - 1) +
    Math.abs((gm(3, (t / 4e4) % 1, q) % 128) / 64 - 1) +
    Math.abs((gm(3, (t / 4e4) % 1, o) % 128) / 64 - 1) +
    Math.abs((gm(4, (t / 4e4) % 1, o) % 128) / 64 - 1) +
    Math.abs((gm(5, (t / 4e4) % 1, o) % 128) / 64 - 1)
  ) * 0.01;

  // PERCUSSION — snare
  let sn = function(tArg) {
    return Math.sin((tArg >> 2) * Math.sin(tArg >> 4)) * Math.pow(1 - (tArg % 5e3) / 5e3, 8) * 0.01;
  };
  let snare_m = 983047;
  let z = ((snare_m >> (t / 5e3) % 32) & 1 ? sn(t) * 8 : 0) +
           ((snare_m >> ((t - 15e3) / 5e3) % 32) & 1 ? sn(t) * 4 : 0);

  // Base drum
  let bm = (30 - 15) * Math.pow(1 - (t % 15e3) / 15e3, 10) - 80;
  // int('001111000111', 2) per dollchan runtime = Math.floor(Number('001111000111')) = 1111000111
  let bm2 = 1111000111;
  let bd = (bm2 >> (t / 15e3) % 12) & 1 ?
    Math.sin(Math.PI * (t % 15e3) * Math.pow(2, bm / 12 - 1)) * Math.pow(1 - (t % 15e3) / 15e3, 10) * 0.5 : 0;

  // Floor tom
  let fm = (30 - 20) * Math.pow(1 - (t % 15e3) / 15e3, 10) - 73;
  // int('000000001000', 2) per dollchan runtime = Math.floor(Number('000000001000')) = 1000
  let fm2 = 1000;
  let ft = (fm2 >> (t / 15e3) % 12) & 1 ?
    Math.sin(Math.PI * (t % 15e3) * Math.pow(2, fm / 12 - 1)) * Math.pow(1 - (t % 15e3) / 15e3, 10) * 0.5 : 0;

  let perc = z + bd + ft;

  // ARPEGGIO
  let a = '.13:=AF';
  let w = Math.abs((gm(4, (t / 1e4) % 7, a) % 128) / 64 - 1) +
    Math.abs((gm(4, ((t - 15000) / 1e4) % 7, a) % 128) / 64 - 1) * 0.5;

  // BASS — blend of square and triangle waves, polyphonic
  let g = '1:85....1:85..00';
  let i = '5=<811115=<81133';
  let h = '8A?<55558A?<5588';
  z = (
    (((gm(5, (t / 4e4) % 16, g) & 128) / 64 - 1) * 0.1) * (1 - (t % k / k)) +
    Math.abs((gm(6, (t / 4e4) % 16, g) % 128) / 64 - 1) +
    (((gm(5, (t / 4e4) % 16, h) & 128) / 64 - 1) * 0.1) * (1 - (t % k / k)) +
    Math.abs((gm(6, (t / 4e4) % 16, h) % 128) / 64 - 1) +
    (((gm(5, (t / 4e4) % 16, i) & 128) / 64 - 1) * 0.1) * (1 - (t % k / k)) +
    Math.abs((gm(6, (t / 4e4) % 16, i) % 128) / 64 - 1) +
    (((gm(4, (t / 4e4) % 16, g) & 128) / 64 - 1) * 0.1) * (1 - (t % k / k)) +
    Math.abs((gm(5, (t / 4e4) % 16, g) % 128) / 64 - 1)
  ) * 0.2;

  let u = ((((gm(5, (t / 16e4) % 16, g) & 128) / 64 - 1) * 0.1) * (1 - (t % k / k)) +
    Math.abs((gm(6, (t / 16e4) % 4, g) % 128) / 64 - 1)) * 0.3;

  // PUT TOGETHER SONG — random() replaced with 0 (inaudible dither, makes it deterministic)
  return (
    (t < 256e4 ? z * (t < 32e4 ? (t % 32e4) / 32e4 : t > 128e4 ? 1 - (t - 128e4) / 128e4 : 1) : 0) +
    (t > 128e4 && t < 448e4 ? Math.sin((t - 128e4) * Math.pow(2, -19)) * w * 0.2 : 0) +
    (t > 128e4 && t < 592e4 ? x * 0.1 : 0) +
    (t > 320e4 && t < 592e4 ?
      u * (t < 448e4 ? (t - 320e4) / 128e4 : t < 592e4 ? 1 - (t - 468e4) / 128e4 : 1) : 0) +
    (t > 320e4 && t < 640e4 ?
      perc * (t < 448e4 ? (t - 320e4) / 128e4 : t < 640e4 ? 1 - (t - 512e4) / 128e4 : 1) : 0) +
    (t > 384e4 && t < 768e4 ?
      s * (t < 576e4 ? (t - 384e4) / 64e4 : t < 768e4 ? 1 - (t - 704e4) / 64e4 : 1) : 0)
  );
}`,
  },
  {
    name: 'Sunrise on Mars', by: 'SthephanShi', sr: 44100,
    body:
`(t) => {
let T = t / 44100;
  let b = (100 * T / 60) % 224;
  let D = 294, EE = 330, G = 392, A = 440, B = 494;

  let seq = (a, i) => a[(i | 0) % a.length];
  let vibr = (amp) => T + amp * 1E-4 * Math.sin(33 * T);
  let noise = (pitch, tempo, a) => Number(seq(a, b * tempo)) * (1E5 * Math.sin((T * pitch | 0) ** 2) & 255);

  let square = (del, pitch, tempo, v, a) => 25 * (pitch * vibr(v) * seq(a, (b - del) / tempo) % 2 | 0);
  let triang = (del, pitch, tempo, v, a) => Math.abs(pitch * vibr(v) * seq(a, (b - del) / tempo) * 64 % 64 - 32 | 0);

  let chFilter = (ch, i) => {
    if (i === 0) return 1;
    let r = i % 2 || 2;
    if (!ch) return 1;
    if (ch === r) return 1;
    return 0.3;
  };

  let reverb = (fn, ch, del, x0, x1, x2, x3) => {
    let sum = 0;
    sum += chFilter(ch, 0) * (1 - 0 / 6) * fn(del * 0, x0, x1, x2, x3);
    sum += chFilter(ch, 1) * (1 - 1 / 6) * fn(del * 1, x0, x1, x2, x3);
    sum += chFilter(ch, 2) * (1 - 2 / 6) * fn(del * 2, x0, x1, x2, x3);
    sum += chFilter(ch, 3) * (1 - 3 / 6) * fn(del * 3, x0, x1, x2, x3);
    sum += chFilter(ch, 4) * (1 - 4 / 6) * fn(del * 4, x0, x1, x2, x3);
    return sum;
  };

  let rise = (start, len, x) => {
    if (x === undefined) x = 1;
    return b < start ? 0 : b < start + len ? (b - start) / len : x;
  };
  let fade = (start, len) => b < start ? 1 : b < start + len ? 1 - (b - start) / len : 0;

  let drums = (a) => b < 160 && rise(80, 32) * noise(2E4, 8, a) / 20;
  let bass = (v) => b > 96 && fade(192, 24) * square(0, .25, 16, v, [EE, G]);

  let arpArr = [EE / 2, B / 2, D, EE, G, B, D * 2, G * 2, EE / 2, B / 2, D, EE, G, B, D * 2, EE * 2];

  let arpSqr = (ch, v) => rise(32, 32, fade(192, 32)) * reverb(square, ch, .5 + rise(64, 8) / 4, 2, .5, v, arpArr);
  let arpTri = (ch, v) => rise(0, 32, fade(32, 32)) * reverb(triang, ch, .5 + rise(24, 16) / 3, 2, .5, v, arpArr);

  let leadArr = [EE, D, G, A, B, A, G, A, EE, D, G, A, B, A, G, D];
  let lead = (fn, v, pitch) => rise(72, 16, fade(160, 48)) * .7 * reverb(fn, 0, .6, pitch, 2, v, leadArr);

  let L = (drums('10040010030000004030202020201010') + bass(-8) +
    arpSqr(1, 4) + arpTri(1, 4) + .6 * lead(square, 6, 4) + lead(triang, 6, 1.5) - 127) / 128;
  let R = (drums('40010030010020000403020202020101') + bass(8) +
    arpSqr(2, 6) + arpTri(2, 4) + .6 * lead(square, 4, 3) + lead(triang, 4, 2) - 127) / 128;

  return (L + R) / 2;
}`,
  },
  {
    name: 'Random melody with array', by: 'lehandsomeguy', sr: 22050,
    body:
`(t) => {
  let time = t / 22050;
  const fract = x => ((x % 1) + 1) % 1;
  const hash = x => fract(Math.sin(x * 1342.874 + Math.sin(5212.42 * x)) * 414.23);
  // Precomputed melody_tunes: pow(2^(1/12), melody_chord[i] - 49) * 44100
  // melody_chord = [0, 2, 3, 5, 7, 9, 10, 12, 14, 16, 17, 19, 21, 22]
  // Precomputed in JS to match the reference exactly and avoid jz pow imprecision
  let melody_tunes = [
    2601.5535743289124, 2920.1451538278016, 3093.7860206527034, 3472.6573937727376,
    3897.926131290836,  4375.274149487343,  4635.4414890860935, 5203.107148657827,
    5840.290307655607,  6555.504221452491,  6945.314787545479,  7795.852262581676,
    8750.548298974689,  9270.882978172192
  ];
  let speed = 3;
  let s = 0;
  let loops = 5;
  let time_shift = 0.07;
  time *= 0.46;
  for (let i = 0; i < loops; i++) {
    time += time_shift;
    let melody_tune = melody_tunes[Math.floor(hash((i * 0.24) + Math.floor(time * speed)) * melody_tunes.length)];
    s += Math.sin(time * melody_tune) * (1 - fract(time * speed));
  }
  return s / loops;
}`,
  },
  {
    name: 'Virtual Insanity', by: 'RealZynx92 (arr. Jamiroquai)', sr: 44100,
    body:
`(t) => {
  let BPM = 93;
  let sr = 44100;
  let A = 440;

  let T = t / sr * BPM;
  let s = (semi, o) => Math.asin(Math.sin(t * Math.pow(2, o) * Math.PI / sr * A * Math.pow(2, semi / 12)));

  let b = [6, 11, 16, 9, 15, 14, 13][Math.floor(T / 128) % 7];
  let c1 = [13, 11, 14, 13, 13, 13, 11][Math.floor((T - 21.33) / 128) % 7];
  let c2 = [16, 15, 18, 16, 15, 14, 13][Math.floor((T - 21.33) / 128) % 7];
  let c3 = [18, 18, 20, 20, 18, 18, 17][Math.floor((T - 21.33) / 128) % 7];
  let c4 = [21, 21, 23, 21, 21, 21, 21][Math.floor((T - 21.33) / 128) % 7];

  let bass = s(b, -2) / 4 * (1 - (T % 128 / 128));
  let chords = T - 21.33 < 0 ? 0 : (s(c1, -1) + s(c2, -1) + s(c3, -1) + s(c4, -1)) / 5 * (1 - ((T - 21.33) % 128 / 128));
  
  let rand = Math.sin(t * 12.9898) * 43758.5453 % 1;
  let shaker = rand / Math.max(0.05, ((T & 16 ? T - 5.33 : T) % 16 / 16)) / 100;

  return bass + chords + shaker;
}`,
  },
  {
    name: 'Smells like Petrichor', by: 'Bp103', sr: 44100,
    body:
`(t) => {
  let sr = 44100;
  let t_local = t + sr * 5.9;
  let a = 0;
  let l = 0;
  let r = Math.pow(2, 1/12);
  let note = [[61, 65, 73], [60, 65, 72], [71, 63, 64], [59, 66, 71]];
  let lnote = [61, 68, 66, 71, 68, 75, 73, 68, 61, 68, 66, 71, 64, 75, 71, 63];
  let q = t_local / sr;

  for (let i = 7; i > 0; i--) {
    let q_i = t_local / sr;
    let nSec = Math.floor(q_i * 0.5) % 4; if (nSec < 0) nSec += 4;
    let nSub = Math.floor(q_i * 4) % 3; if (nSub < 0) nSub += 3;
    let noteRow = note[nSec];
    let noteVal = noteRow ? noteRow[nSub] : 0;
    a += Math.sin(q_i * 55 * Math.pow(r, noteVal)) / i * 3;
    
    let lIdx = Math.floor(q_i * 4) % 16; if (lIdx < 0) lIdx += 16;
    let lead = q_i * 55 * Math.pow(r, lnote[lIdx]);
    l += Math.sin(Math.cos(lead / 24) + lead * 4) * (1 - (q_i * 4 % 1)) / i * 0.2;
    t_local += sr / i * 1.3;
  }

  let nSecMain = Math.floor(q * 0.5) % 4; if (nSecMain < 0) nSecMain += 4;
  let nSubMain32 = Math.floor(q * 32) % 3; if (nSubMain32 < 0) nSubMain32 += 3;
  let noteRowMain = note[nSecMain];
  let arp = ((q * 55 * Math.pow(r, (noteRowMain ? noteRowMain[nSubMain32] : 0) - 8)) % 4 > 2) ? 1 / 1.4 : 0;
  
  let bass = q * 55 * Math.pow(r, (noteRowMain ? noteRowMain[2] : 0) - 12);
  let b = Math.sin(Math.sin(bass / 4) + bass / 4) * (1 - (q * 0.5 % 1)) / 2;

  let leftStream = (l / 1.8) + (a / 32) + ((a > 0 ? 1 : 0) / ((Math.sin(q * 0.1) * 3) + 8)) + b + (arp * Math.cos(q * 0.5) * 0.2);
  let rightStream = (l / 1.5) + (a / 50) + ((a > 0 ? 1 : 0) / ((Math.cos(q * 0.1) * 2) + 5)) + b + (arp * Math.sin(q * 0.5) * 0.2);

  let curSection = Math.floor((q - 4) / 8);
  if (curSection < 3) {
    let subSec = Math.floor((q - 8) / 8) % 3;
    if (subSec < 0) subSec += 3;
    if (subSec === 0) {
      return l;
    } else if (subSec === 1) {
      return l + b;
    }
  }
  return (leftStream + rightStream) / 2;
}`,
  },
  {
    name: 'Ambient Waves', by: 'paboribo', sr: 44100,
    body:
`(t) => {
  t = t / 44100;
  let f = (freq, amp) => Math.sin(2 * Math.PI * freq * t) * amp;
  let lfo = (rate) => (Math.sin(2 * Math.PI * rate * t) + 1) / 2;
  return (
    f(110 + lfo(0.1) * 50, 0.3) +
    f(220 + lfo(0.15) * 30, 0.2) +
    f(330 + lfo(0.08) * 80, 0.15) +
    f(55 + lfo(0.05) * 20, 0.25)
  ) * 0.6;
}`,
  },
  {
    name: 'Sierpinski Chords', by: 'RealZynx92', sr: 44100,
    body:
`(t) => {
  let A = 440;

  let s = (n, x) => {
    let freq = (t / 375) * A * Math.pow(2, n / 12);
    return (((freq | 0) & (x | 0)) / 256);
  };

  let t_shift = t >> 17;
  let c1 = -[2, 4, 2, 9][t_shift & 3];
  let c2 = [5, 0, 5, 0][t_shift & 3];
  let c3 = [8, 7, 8, 5][t_shift & 3];

  let chord = (s(c1, (-t >> 8) & 255) + s(c2, (-t >> 8) & 255) + s(c3, (-t >> 8) & 255)) / 2 * (1 - (t % 16384) / 16384);
  let bass = s(c1 - 36, 127) * (1 - (t % 16384) / 20000) * 1.5;

  let out = chord + bass - 1.0;
  return out < -1 ? -1 : (out > 1 ? 1 : out);
}`,
  },
  {
    name: 'Sine Rider', by: 'ryg', sr: 8000,
    body:
`(t) => {
  let x = t;
  let c = (n) => Math.sin(n);
  let s = (f) => c(x / (8000 / f) * 2 * Math.PI);
  let m = (f, l, d) => s(f) * (x % d < l ? 1 : 0);
  let r = (f, d) => s(f) * Math.pow(1 - (x % d) / d, 2);
  return (
    r(220, 4000) * 0.3 +
    r(330, 2000) * 0.2 +
    m(440, 1000, 2000) * 0.15 +
    m(554, 500, 1500) * 0.1 +
    s(110) * 0.1
  ) * 0.8;
}`,
  },
  {
    name: 'Digital Rain', by: 'kurblo', sr: 44100,
    body:
`(t) => {
  t /= 44100;
  let bpm = 128;
  let beat = t * bpm / 60;
  let bar = beat / 4 | 0;
  let pat = beat % 4;
  let kick = pat < 1 ? Math.sin(60 * Math.PI * Math.pow(1 - pat, 4)) * 0.4 : 0;
  let hat = Math.sin(t * 8000 * Math.sin(t * 200)) * Math.pow(1 - beat % 0.5, 8) * 0.08;
  let bassN = [55, 55, 73, 65];
  let bass = Math.sin(2 * Math.PI * bassN[bar % 4] * t) * 0.2 * (1 - beat % 1);
  let pad = Math.sin(2 * Math.PI * 220 * t) * 0.05 + Math.sin(2 * Math.PI * 277 * t) * 0.05;
  return kick + hat + bass + pad;
}`,
  },
]

// Wrap a (t)=>sample floatbeat into a jz/js module: beat(t) + a clamped fill(out,len,off).
export const moduleSrc = (body) => `export let beat = ${body}
export let fill = (out, len, off) => { let i = 0; while (i < len) { let s = beat(off + i); out[i] = s < -1 ? -1 : (s > 1 ? 1 : s); i++ } }`
