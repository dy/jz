/**
 * Complete active-function analysis/emission record.
 *
 * The record is replaced as one authority at every real function boundary;
 * nested emitters restore the previous record by identity, never by copying a
 * selected field list. Flow scopes inside one function still mutate fields on
 * the active record deliberately.
 *
 * typedElem/typedLen are the two exceptions to "lives on the record": they
 * are read throughout analyze.js/emit.js/narrow.js as the ambient
 * ctx.types.typedElem/typedLen pair (per ctx.js's own phase table, "function"
 * lifecycle — reset per function like everything else here), not as
 * ctx.func.* fields, so relocating their STORAGE would mean rewriting every
 * one of those call sites, narrow.js included. What moves here instead is
 * their LIFECYCLE: enterActiveFunction/restoreActiveFunction below stash and
 * restore ctx.types.typedElem/typedLen on the displaced record's own
 * typedElem/typedLen fields, the same swap-by-identity discipline every other
 * field on this record already gets — closing the audit's P1 finding (a
 * manual save/restore at each call site, one of which — emitClosureBody —
 * forgot typedLen) without touching a single read site.
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
    typedElem: null,   // stashed ctx.types.typedElem snapshot while DISPLACED (see enterActiveFunction) — stale/unused while this record is the active ctx.func
    typedLen: null,    // same, for ctx.types.typedLen
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

/** Install a complete active record and return the displaced record.
 *  Structurally carries ctx.types.typedElem/typedLen along with the swap
 *  (see createActiveFunction's own doc) — the displaced record keeps its
 *  ambient snapshot on itself so the matching restoreActiveFunction() puts it
 *  back automatically, the same identity-keyed discipline as every other
 *  field here. The entered record starts with a clean ambient slate; callers
 *  that need to seed it (analyzeFuncForEmit, installFunctionPlan,
 *  emitClosureBody) write ctx.types.typedElem/typedLen explicitly right
 *  after, same as they already populate ctx.func.locals/boxed/etc. */
export function enterActiveFunction(ctx, options) {
  const previous = ctx.func
  previous.typedElem = ctx.types.typedElem
  previous.typedLen = ctx.types.typedLen
  ctx.func = createActiveFunction(options)
  ctx.types.typedElem = null
  ctx.types.typedLen = null
  return previous
}

/** Restore a record previously returned by enterActiveFunction(). */
export function restoreActiveFunction(ctx, previous) {
  ctx.func = previous
  ctx.types.typedElem = previous.typedElem
  ctx.types.typedLen = previous.typedLen
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
 *  Audit P3: the old check asserted only identity/body/module-scope/locals-
 *  shape/empty-stack — narrower than the state classes a "record fully
 *  restored" claim implies. Strengthened to assert each class by name:
 *  overlays (localValTypesOverlay/localTypedElemsOverlay — flow-state.js's
 *  scoped fields), refinements, prediction state (p1Predicted), try/finally
 *  state (inTry/finallyStack), emission flags (repsFrozen/boxedResult/
 *  mixedAtomReturn plus the expression-dispatch scopes _expect/
 *  _selfAccumConcat/_schemaSpecSlow), and — P2's fix directly above — the
 *  ambient ctx.types.typedElem/typedLen pair, exactly the field a forgotten
 *  restore (emitClosureBody's old typedLen gap) used to leave dirty right
 *  here. Takes the whole ctx (not just ctx.func) because that last class
 *  lives outside the record proper.
 *
 *  `uniq` is deliberately NOT checked against 0: it's a shared synthetic-name
 *  counter, and some post-analysis passes (boundary-wrapper synthesis) mint
 *  names off the session frame's own counter after every real function has
 *  restored it — a real, intentional session-frame write, not a leak (unlike
 *  the fields checked below, which have no legitimate post-compile use at
 *  all). Confirmed empirically: `xs[0]` alone leaves it at 2. */
export function isInactiveFunction(ctx) {
  const frame = ctx.func
  return frame.current === null && frame.body === null && frame.atModuleScope === false &&
    frame.locals instanceof Map && Array.isArray(frame.stack) && frame.stack.length === 0 &&
    frame.localValTypesOverlay instanceof Map && frame.localValTypesOverlay.size === 0 &&
    frame.localTypedElemsOverlay === null &&
    frame.refinements instanceof Map && frame.refinements.size === 0 &&
    frame.p1Predicted instanceof Set && frame.p1Predicted.size === 0 &&
    frame.inTry === false && frame.finallyStack === null &&
    frame.repsFrozen === false && frame.boxedResult === false && frame.mixedAtomReturn === false &&
    frame._expect === null && frame._selfAccumConcat === null && frame._schemaSpecSlow === false &&
    ctx.types.typedElem === null && ctx.types.typedLen === null
}
