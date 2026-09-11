/**
 * `jz:usp` – URLSearchParams as readable jz source: `new URLSearchParams(init)`
 * canonicalizes to `__usp_new`, a class with shared methods over private
 * parallel key/value arrays. WHATWG semantics: forgiving percent decode ('+'
 * is space, malformed escapes pass through as literals, never a throw),
 * application/x-www-form-urlencoded escaping on toString (space→'+', only
 * [A-Za-z0-9*-._] bare, UTF-8 bytes %XX'd). Divergences (documented):
 * keys()/values()/entries() return arrays (iterable with for-of, not live
 * iterators), and the object is not itself iterable: iterate `.entries()`.
 *
 * @module std/usp
 */

export default `
export let __usp_hex = (c) => c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1
export let __usp_lt = (a, b) => {
  let n = a.length < b.length ? a.length : b.length
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i)
    let y = b.charCodeAt(i)
    if (x !== y) return x < y
  }
  return a.length < b.length
}
export let __usp_dec = (s) => {
  let bytes = new TextEncoder().encode(s)
  let n = bytes.length
  let buf = new Uint8Array(n)
  let j = 0
  for (let i = 0; i < n; i++) {
    let c = bytes[i]
    if (c === 43) { buf[j] = 32; j = j + 1 }
    else if (c === 37 && i + 2 < n) {
      let h = __usp_hex(bytes[i + 1])
      let l = __usp_hex(bytes[i + 2])
      if (h >= 0 && l >= 0) { buf[j] = h * 16 + l; j = j + 1; i = i + 2 }
      else { buf[j] = c; j = j + 1 }
    } else { buf[j] = c; j = j + 1 }
  }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf.slice(0, j))
}
export let __usp_esc = (s) => {
  let out = ''
  let bytes = new TextEncoder().encode(s)
  let n = bytes.length
  for (let i = 0; i < n; i++) {
    let c = bytes[i]
    if (c === 32) out = out + '+'
    else if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 42 || c === 45 || c === 46 || c === 95) out = out + String.fromCharCode(c)
    else {
      let h = c >> 4
      let l = c & 15
      out = out + '%' + String.fromCharCode(h < 10 ? 48 + h : 55 + h) + String.fromCharCode(l < 10 ? 48 + l : 55 + l)
    }
  }
  return out
}
export class __URLSearchParams {
  #ks = []
  #vs = []
  constructor(init) {
    if (init != null) {
      if (typeof init === 'string') {
        let s = init
        if (s[0] === '?') s = s.slice(1)
        if (s.length > 0) {
          let parts = s.split('&')
          for (let pi = 0; pi < parts.length; pi++) {
            let part = parts[pi]
            if (part.length > 0) {
              let eq = part.indexOf('=')
              if (eq < 0) this.append(__usp_dec(part), '')
              else this.append(__usp_dec(part.slice(0, eq)), __usp_dec(part.slice(eq + 1)))
            }
          }
        }
      } else if (Array.isArray(init)) {
        for (let pi = 0; pi < init.length; pi++) { let pair = init[pi]; this.append(pair[0], pair[1]) }
      } else if (init instanceof __URLSearchParams) {
        for (let i = 0; i < init.#ks.length; i++) this.append(init.#ks[i], init.#vs[i])
      } else {
        let es = Object.entries(init)
        for (let ei = 0; ei < es.length; ei++) { let e = es[ei]; this.append(e[0], e[1]) }
      }
    }
  }
  get size() { return this.#ks.length }
  #find(k) { let ks = this.#ks; for (let i = 0; i < ks.length; i++) { if (ks[i] === k) return i } return -1 }
  get(k) { let vs = this.#vs; let i = this.#find(String(k)); return i < 0 ? null : vs[i] }
  getAll(k) { let ks = this.#ks, vs = this.#vs; let key = String(k); let out = []; for (let i = 0; i < ks.length; i++) { if (ks[i] === key) out.push(vs[i]) } return out }
  has(k, v) { let ks = this.#ks, vs = this.#vs; let key = String(k); for (let i = 0; i < ks.length; i++) { if (ks[i] === key && (v === undefined || vs[i] === String(v))) return true } return false }
  append(k, v) { let ks = this.#ks, vs = this.#vs; ks.push(String(k)); vs.push(String(v)); return undefined }
  set(k, v) { let ks = this.#ks, vs = this.#vs;
    let key = String(k)
    let i = this.#find(key)
    if (i < 0) { this.append(key, v); return undefined }
    vs[i] = String(v)
    let w = i + 1
    for (let r = i + 1; r < ks.length; r++) {
      if (ks[r] !== key) { ks[w] = ks[r]; vs[w] = vs[r]; w = w + 1 }
    }
    ks.splice(w)
    vs.splice(w)
    return undefined
  }
  'delete'(k, v) { let ks = this.#ks, vs = this.#vs;
    let key = String(k)
    let w = 0
    for (let r = 0; r < ks.length; r++) {
      if (!(ks[r] === key && (v === undefined || vs[r] === String(v)))) { ks[w] = ks[r]; vs[w] = vs[r]; w = w + 1 }
    }
    ks.splice(w)
    vs.splice(w)
    return undefined
  }
  forEach(fn) { for (let i = 0; i < this.size; i++) fn(this.#vs[i], this.#ks[i], this); return undefined }
  keys() { return this.#ks.slice() }
  values() { return this.#vs.slice() }
  entries() { let ks = this.#ks, vs = this.#vs; let out = []; for (let i = 0; i < ks.length; i++) out.push([ks[i], vs[i]]); return out }
  sort() { let ks = this.#ks, vs = this.#vs;
    for (let i = 1; i < ks.length; i++) {
      let k = ks[i]
      let v = vs[i]
      let j = i - 1
      while (j >= 0 && __usp_lt(k, ks[j])) { ks[j + 1] = ks[j]; vs[j + 1] = vs[j]; j = j - 1 }
      ks[j + 1] = k
      vs[j + 1] = v
    }
    return undefined
  }
  toString() { let ks = this.#ks, vs = this.#vs;
    let out = ''
    for (let i = 0; i < ks.length; i++) {
      if (i > 0) out = out + '&'
      out = out + __usp_esc(ks[i]) + '=' + __usp_esc(vs[i])
    }
    return out
  }
}
export let __usp_new = (init) => new __URLSearchParams(init)
`
