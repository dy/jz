/**
 * Complete active-function analysis/emission record.
 *
 * The record is replaced as one authority at every real function boundary;
 * nested emitters restore the previous record by identity, never by copying a
 * selected field list. Flow scopes inside one function still mutate fields on
 * the active record deliberately.
 *
 * typedElem/typedLen live here too: they are function-local representation
 * facts, not program-wide type state. A boundary therefore swaps them by the
 * same record identity as locals, reps, refinements, and emission flags; no
 * parallel ambient save/restore authority exists.
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
    typedElem: null,
    typedLen: null,
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

/** Debug/test predicate for the post-compile inactive session record.
 *
 *  Asserts every constructor field except `uniq` by name: overlays
 *  (localValTypesOverlay/localTypedElemsOverlay — flow-state.js's scoped
 *  fields), refinements, prediction state (p1Predicted), try/finally state
 *  (inTry/finallyStack), emission flags (repsFrozen/boxedResult/
 *  mixedAtomReturn plus the expression-dispatch scopes _expect/
 *  _selfAccumConcat/_schemaSpecSlow), and the typedElem/typedLen facts owned
 *  directly by the record. Adding state to ActiveFunction requires deciding
 *  and pinning its inactive value here rather than silently widening the gap
 *  between this predicate and a true "record fully restored" claim.
 *
 *  `uniq` is deliberately NOT checked against 0: it's a shared synthetic-name
 *  counter, and some post-analysis passes (boundary-wrapper synthesis) mint
 *  names off the session frame's own counter after every real function has
 *  restored it — a real, intentional session-frame write, not a leak (unlike
 *  the fields checked below, which have no legitimate post-compile use at
 *  all). */
export function isInactiveFunction(ctx) {
  const frame = ctx.func
  const emptyMap = value => value instanceof Map && value.size === 0
  const emptySet = value => value instanceof Set && value.size === 0
  return frame.current === null && frame.body === null && frame.exported === false &&
    frame.atModuleScope === false && emptyMap(frame.locals) && frame.localReps === null &&
    frame.localProps === null && frame.typedElem === null && frame.typedLen === null &&
    emptyMap(frame.boxed) && emptySet(frame.cellTypes) && emptyMap(frame.flatObjects) &&
    emptySet(frame.sliceViews) && emptySet(frame.leanHashLocals) && emptySet(frame.i32HashLocals) &&
    emptyMap(frame.leanHashDomains) && emptySet(frame.preboxed) &&
    Array.isArray(frame.stack) && frame.stack.length === 0 && frame.inTry === false &&
    frame.finallyStack === null && frame.pendingLabel === null && emptyMap(frame.refinements) &&
    frame.flowValBlocked === null && frame.repsFrozen === false && emptySet(frame.p1Predicted) &&
    emptyMap(frame.localValTypesOverlay) && frame.localTypedElemsOverlay === null &&
    emptyMap(frame.closureAux) && frame.directClosures === null && emptySet(frame.zeroInitSeen) &&
    emptySet(frame.maybeNullish) && emptySet(frame.ternaryBoxedNames) &&
    frame.boxedResult === false && frame.valResult === null && frame.mixedAtomReturn === false &&
    frame.charDecomp === null && frame.charDecompGlobals === false && frame.concatBufs === null &&
    frame.probeHoist === null && frame.lenHoist === null && frame.hoistTempDefs === null &&
    frame._expect === null && frame._arrayLiteralNeverEscapes === false &&
    frame._schemaSpecSlow === false && frame._selfAccumConcat === null
}
