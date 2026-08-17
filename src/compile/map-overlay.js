// O(1) mutable view over a stable base map. Reads consult the function-local
// `own` layer first; writes and deletes never mutate `base`.
//
// Plain objects rather than a class keep this module inside jz's self-hosted
// subset. The delete method is attached after construction because `delete` in
// object-method position is rejected by the self-host parser.
const TOMBSTONE = Symbol('MapOverlay.deleted')

export function makeMapOverlay(base, own) {
  const b = base || null
  const o = own || new Map()
  const has = k => o.has(k) ? o.get(k) !== TOMBSTONE : (b ? b.has(k) : false)
  const overlay = {
    mapOverlay: true,
    base: b,
    own: o,
    has,
    get(k) {
      if (o.has(k)) {
        const v = o.get(k)
        return v === TOMBSTONE ? undefined : v
      }
      return b ? b.get(k) : undefined
    },
    set(k, v) { o.set(k, v) },
  }
  overlay.delete = k => {
    const had = has(k)
    if (had) o.set(k, TOMBSTONE)
    return had
  }
  return overlay
}

export const isMapOverlay = value => value?.mapOverlay === true

/** Detach a writable view without cloning its stable program-wide base. */
export function cloneMapView(view) {
  if (!view) return null
  if (isMapOverlay(view)) return makeMapOverlay(view.base, new Map(view.own))
  return new Map(view)
}

/** Non-empty check; overlap may over-count, but every caller asks only truthiness. */
export function mapOrOverlaySize(view) {
  if (!view) return 0
  return isMapOverlay(view)
    ? view.own.size + mapOrOverlaySize(view.base)
    : view.size
}
