const KEY = 'jz.floatbeat.library.v1'
const valid = t => t && typeof t.id === 'string' && typeof t.name === 'string' &&
  typeof t.body === 'string' && Number.isInteger(t.sr) && t.sr >= 1000 && t.sr <= 192000

export function readLibrary(storage) {
  try {
    const rows = JSON.parse(storage.getItem(KEY) || '[]')
    return Array.isArray(rows) ? rows.filter(valid) : []
  } catch { return [] }
}

export function writeLibrary(storage, rows) {
  if (!rows.every(valid)) throw new TypeError('Invalid saved formula')
  storage.setItem(KEY, JSON.stringify(rows))
}
