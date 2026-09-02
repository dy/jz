/**
 * `jz:weakref` – WeakRef and FinalizationRegistry.
 *
 * jz never collects a live heap object behind a program's back, so a WeakRef
 * is a reference that stays alive and a FinalizationRegistry never fires: the
 * spec permits both (cleanup is "at the implementation's discretion"), and a
 * program written for a collector runs unchanged. `unregister` reports false:
 * nothing was pending.
 *
 * @module std/weakref
 */

export default `
export class WeakRef {
  #target
  constructor(target) { this.#target = target }
  deref() { return this.#target }
}

export class FinalizationRegistry {
  constructor(cleanup) {}
  register(target, held, token) {}
  unregister(token) { return false }
}
`
