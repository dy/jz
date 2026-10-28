/**
 * `jz:suppressed` – SuppressedError as readable jz source: the error a
 * disposal throws over an earlier one (jzify/using.js), `error` the later
 * and `suppressed` the earlier, both own properties that do not enumerate
 * (`__hide_member`, the class lowering's own mark).
 *
 * @module std/suppressed
 */

export default `
export class SuppressedError extends Error {
  constructor(error, suppressed, message) {
    super(message)
    this.name = 'SuppressedError'
    this.error = error
    this.suppressed = suppressed
    __hide_member(this, 'error')
    __hide_member(this, 'suppressed')
  }
}
`
