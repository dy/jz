// Serialize a JS value to a jz source literal (numbers/booleans/strings/null/
// undefined + literal arrays/objects). Returns null for anything not expressible
// as a compile-time literal (functions, host objects, circular). Shared by the
// `jz\`…${val}\`` template tag (hoists complex args) and opts.define.
export const serialize = (v) => {
  if (v === undefined) return 'undefined'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) {
    const elems = v.map(serialize)
    return elems.every(e => e !== null) ? `[${elems.join(', ')}]` : null
  }
  if (typeof v === 'object') {
    const props = Object.keys(v).map(k => {
      const s = serialize(v[k])
      return s !== null ? `${k}: ${s}` : null
    })
    return props.every(p => p !== null) ? `{${props.join(', ')}}` : null
  }
  return null
}

