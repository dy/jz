// Prepared, synthesized and specialized functions share one record layout.
// Late result facts start empty; variants inherit them from their source.
export function createFunction(name, body, sig, exported = false, defaults = null, rest = null) {
  return {
    name, body, sig, exported, defaults, rest,
    valResult: null, valResultMayBeUndefined: false,
    arrayElemSchema: null, arrayElemSchemaSet: null,
  }
}
