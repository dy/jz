// Prepared, synthesized and specialized functions share one record layout.
// Late result facts start empty; variants inherit them from their source.
export function createFunction(name, body, sig, exported = false, defaults = null, rest = null) {
  return {
    name, body, sig, exported, defaults, rest,
    valResult: null, valResultMayBeUndefined: false,
    arrayElemSchema: null, arrayElemSchemaSet: null,
  }
}

/** The nodes a function runs, in evaluation order: its parameter defaults,
 *  then its body. A scan of what a function reads, writes, captures or calls
 *  walks all of them (a closure record carries the same two fields). */
export const frameRoots = (fn) => fn.defaults ? [...Object.values(fn.defaults), fn.body] : [fn.body]

/** The same nodes as one statement list, for a scan that takes a single node
 *  (the body itself where there is no default). */
export const frameNode = (fn) => { const roots = frameRoots(fn); return roots.length > 1 ? [';', ...roots] : fn.body }

/** Function.length counts parameters before the first default or rest parameter. */
export const functionLength = (params, defaults, rest) => {
  let n = 0
  for (const p of params) {
    const name = typeof p === 'string' ? p : p.name
    if (name === rest || defaults && Object.hasOwn(defaults, name)) break
    n++
  }
  return n
}
