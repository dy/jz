import { collectParamNames, paramList } from '../src/ast.js'

// Parameter initialization runs when a generator is CALLED, before its first
// next(). Keep pulls and defaults interleaved; materializing the input first
// would over-consume it and move side effects across binding initializers.
export function lowerIteratorParams(params, temp) {
  const raw = paramList(params)
  const arrayPattern = p => Array.isArray(p) && (p[0] === '[]' || p[0] === '=' && arrayPattern(p[1]))
  if (!raw.some(arrayPattern)) return [params, []]
  const prefix = [], names = collectParamNames(raw), args = []
  const call = (fn, arg) => ['()', fn, arg]
  const block = stmts => ['{}', [';', ...stmts]]
  const bind = (pat, value, out) => {
    if (Array.isArray(pat) && pat[0] === '=') {
      const v = temp('pd')
      out.push(['let', ['=', v, value]])
      bind(pat[1], ['?:', ['===', v, [null, undefined]], pat[2], v], out)
    } else if (Array.isArray(pat) && pat[0] === '[]') {
      const it = temp('pi'), error = temp('pe'), pulls = []
      out.push(['let', ['=', it, call('__it_open', value)]])
      const items = pat[1] == null ? [] : pat[1][0] === ',' ? pat[1].slice(1) : [pat[1]]
      for (const item of items) {
        if (item == null) pulls.push(call('__it_skip', it))
        else if (Array.isArray(item) && item[0] === '...') bind(item[1], call('__it_rest', it), pulls)
        else bind(item, call('__it_step', it), pulls)
      }
      // On a binding error, IteratorClose still runs, but its own error must
      // not replace the original. A failed next/value read marks the record
      // done, so closing it is a no-op (IteratorStepValue abrupt completion).
      out.push(['try', block(pulls), ['catch', error, block([
        call('__it_close', [',', it, [null, true]]), ['throw', error],
      ])]])
      out.push(call('__it_close', [',', it, [null, false]]))
    } else out.push(['=', pat, value])
  }
  // Move every initializer together: a later default can read an earlier
  // destructured binding, and must not run before that binding completes.
  for (const p of raw) {
    const arg = temp('pa'), rest = Array.isArray(p) && p[0] === '...'
    args.push(rest ? ['...', arg] : arg)
    bind(rest ? p[1] : p, arg, prefix)
  }
  return [['()', [',', ...args]], [['let', ...names], ...prefix]]
}
