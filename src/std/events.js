/**
 * `jz:events` – Event, CustomEvent and EventTarget as readable jz source.
 *
 * A module referencing one of these globals without declaring it imports this
 * module implicitly (jzify prepends the import); the bundler prepares it once
 * per compile, so every module shares one class identity and `instanceof
 * Event` holds across modules. DOM semantics kept: listener order, `once`,
 * duplicate registration ignored, `stopImmediatePropagation`, `preventDefault`
 * under `cancelable`, `dispatchEvent` returning `!defaultPrevented`, target /
 * currentTarget set for the dispatch. Left out (documented): capture phase and
 * bubbling (no tree), `handleEvent` objects, `timeStamp`, `composedPath`.
 *
 * @module std/events
 */

export default `
export class Event {
  constructor(type, init) {
    this.type = type
    this.bubbles = !!init?.bubbles
    this.cancelable = !!init?.cancelable
    this.defaultPrevented = false
    this.target = null
    this.currentTarget = null
    this.__stop = false
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true }
  stopPropagation() {}
  stopImmediatePropagation() { this.__stop = true }
}

export class CustomEvent extends Event {
  constructor(type, init) {
    super(type, init)
    this.detail = init?.detail
  }
}

export class EventTarget {
  #listeners = new Map()

  addEventListener(type, fn, opts) {
    if (!fn) return
    let list = this.#listeners.get(type)
    if (!list) this.#listeners.set(type, list = [])
    for (let l of list) if (l.fn === fn) return
    list.push({ fn, once: typeof opts === 'object' && opts !== null ? !!opts.once : false })
  }

  removeEventListener(type, fn) {
    let list = this.#listeners.get(type)
    if (!list) return
    for (let i = 0; i < list.length; i++) if (list[i].fn === fn) { list.splice(i, 1); return }
  }

  dispatchEvent(event) {
    event.target = this
    event.currentTarget = this
    event.__stop = false
    let list = this.#listeners.get(event.type)
    if (list) for (let l of [...list]) {
      if (l.once) this.removeEventListener(event.type, l.fn)
      l.fn(event)
      if (event.__stop) break
    }
    event.currentTarget = null
    return !event.defaultPrevented
  }
}
`
