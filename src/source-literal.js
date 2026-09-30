// Serialize a JS value to a jz source literal (numbers/booleans/strings/null/
// undefined + literal arrays/objects). Returns null for anything not expressible
// as a compile-time literal (functions, host objects, circular). Shared by the
// `jz\`…${val}\`` template tag (hoists complex args) and opts.define.
export const serialize = (v, active = null) => {
  if (v === undefined) return 'undefined'
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v)
  if (typeof v === 'boolean') return String(v)
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v !== 'object') return null
  const array = Array.isArray(v), proto = Object.getPrototypeOf(v)
  if (!array && proto !== null && proto !== Object.prototype) return null
  active ??= new Set()
  if (active.has(v)) return null
  active.add(v)
  try {
    const parts = [], keys = array ? null : Object.keys(v), length = array ? v.length : keys.length
    for (let i = 0; i < length; i++) {
      const key = array ? i : keys[i]
      const prop = Object.getOwnPropertyDescriptor(v, key)
      if (prop && !('value' in prop)) return null
      const value = serialize(prop?.value, active)
      if (value === null) return null
      if (array) parts.push(value)
      else {
        const name = key === '__proto__' ? `[${JSON.stringify(key)}]` : JSON.stringify(key)
        parts.push(`${name}: ${value}`)
      }
    }
    return array ? `[${parts.join(', ')}]` : `{${parts.join(', ')}}`
  } finally { active.delete(v) }
}
