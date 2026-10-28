/**
 * `jz:symbol` – the description of a Symbol made with one no literal fixes.
 *
 * A Symbol is an atom identity with no storage of its own (module/symbol.js):
 * the identity outlives arena rounds and resets, and a description the
 * program writes as a literal rides the identity itself. jzify routes
 * `Symbol(x)` of any other argument here, which keeps the description,
 * keyed by the number the identity reads as (`__sym_key`), in a module binding
 * a call keeps what it stores into. The program's readers (`__sym_described`)
 * and the host (interop.js) read it through `__sym_desc`.
 *
 * @module std/symbol
 */

export default `
const descriptions = new Map()

export let __sym_new = (description) => {
  const text = description === undefined ? undefined : \`\${description}\`
  const symbol = Symbol()
  if (text !== undefined) descriptions.set(__sym_key(symbol), text)
  return symbol
}

export let __sym_desc = (key) => descriptions.get(key)
`
