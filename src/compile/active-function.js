/**
 * Complete active-function analysis/emission record.
 *
 * The record is replaced as one authority at every real function boundary;
 * nested emitters restore the previous record by identity, never by copying a
 * selected field list. Flow scopes inside one function still mutate fields on
 * the active record deliberately.
 */
export function createActiveFunction({
  sig = null,
  body = null,
  uniq = 0,
  directClosures = null,
  exported = false,
  moduleScope = false,
} = {}) {
  return {
    current: sig,
    body,
    exported: !!exported,
    atModuleScope: !!moduleScope,

    locals: new Map(),
    localReps: null,
    localProps: null,
    boxed: new Map(),
    cellTypes: new Set(),
    flatObjects: new Map(),
    sliceViews: new Set(),
    leanHashLocals: new Set(),
    i32HashLocals: new Set(),
    leanHashDomains: new Map(),
    preboxed: new Set(),

    stack: [],
    uniq,
    inTry: false,
    finallyStack: null,
    pendingLabel: null,
    refinements: new Map(),
    flowValBlocked: null,

    repsFrozen: false,
    p1Predicted: new Set(),
    localValTypesOverlay: new Map(),
    localTypedElemsOverlay: null,

    closureAux: new Map(),
    directClosures,
    zeroInitSeen: new Set(),
    maybeNullish: new Set(),
    ternaryBoxedNames: new Set(),
    boxedResult: false,
    valResult: null,
    mixedAtomReturn: false,

    charDecomp: null,
    charDecompGlobals: false,
    concatBufs: null,
    probeHoist: null,
    lenHoist: null,
    hoistTempDefs: null,

    // Expression-dispatch scopes. They are fields rather than module globals so
    // recursive emission remains explicit and function-local.
    _expect: null,
    _arrayLiteralNeverEscapes: false,
    _schemaSpecSlow: false,
    _selfAccumConcat: null,
  }
}

/** Install a complete active record and return the displaced record. */
export function enterActiveFunction(ctx, options) {
  const previous = ctx.func
  ctx.func = createActiveFunction(options)
  return previous
}

/** Restore a record previously returned by enterActiveFunction(). */
export function restoreActiveFunction(ctx, previous) {
  ctx.func = previous
}

/** Mint an id from the current EmitFrame name authority. */
export function freshEmitId(ctx) {
  return ctx.func.uniq++
}

/** Register one local on the current EmitFrame. */
export function declareLocal(ctx, name, type) {
  ctx.func.locals.set(name, type)
  return name
}

/** Debug/test predicate for the post-compile inactive record. */
export function isInactiveFunction(frame) {
  return frame.current === null && frame.body === null && frame.atModuleScope === false &&
    frame.locals instanceof Map && Array.isArray(frame.stack) && frame.stack.length === 0
}
