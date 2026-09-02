/**
 * `jz:domexception` – DOMException as readable jz source: an Error carrying
 * the WebIDL `name` and its legacy `code` (0 for names without one).
 *
 * @module std/domexception
 */

export default `
let __dom_codes = {
  IndexSizeError: 1, HierarchyRequestError: 3, WrongDocumentError: 4, InvalidCharacterError: 5,
  NoModificationAllowedError: 7, NotFoundError: 8, NotSupportedError: 9, InUseAttributeError: 10,
  InvalidStateError: 11, SyntaxError: 12, InvalidModificationError: 13, NamespaceError: 14,
  InvalidAccessError: 15, TypeMismatchError: 17, SecurityError: 18, NetworkError: 19, AbortError: 20,
  URLMismatchError: 21, QuotaExceededError: 22, TimeoutError: 23, InvalidNodeTypeError: 24, DataCloneError: 25,
}

export class DOMException extends Error {
  constructor(message = '', name = 'Error') {
    super(message)
    this.name = name
    this.code = __dom_codes[name] ?? 0
  }
}
`
