import { collectParamNames, paramList } from './ast.js'

// Parameter initialization runs when a generator is CALLED, before its first
// next(). Keep pulls and defaults interleaved; materializing the input first
// would over-consume it and move side effects across binding initializers.
export function lowerIteratorParams(params, temp) {
  const raw = paramList(params)
  if (!raw.some(hasArrayPattern)) return [params, []]
  const prefix = [], names = collectParamNames(raw), args = []
  // Move every initializer together: a later default can read an earlier
  // destructured binding, and must not run before that binding completes.
  for (const p of raw) {
    const arg = temp('pa'), rest = Array.isArray(p) && p[0] === '...'
    args.push(rest ? ['...', arg] : arg)
    const def = Array.isArray(p) && p[0] === '='
    prefix.push(['=', rest || def ? p[1] : p,
      def ? ['?:', ['===', arg, [null, undefined]], p[2], arg] : arg])
  }
  return [['()', [',', ...args]], [['let', ...names], ...prefix]]
}

// One array-pattern protocol, shared by parameter, declaration and assignment
// lowering. The caller owns binding scopes and recursively lowers each target.
export function lowerIteratorPattern(pat, value, temp, bind, call) {
  const it = temp('pi'), error = temp('pe'), pulls = []
  const block = stmts => ['{}', [';', ...stmts]]
  const items = pat[1] == null ? [] : pat[1][0] === ',' ? pat[1].slice(1) : [pat[1]]
  for (const item of items) {
    if (item == null) pulls.push(call('__it_skip', it))
    else if (Array.isArray(item) && item[0] === '...') bind(item[1], call('__it_rest', it), pulls)
    else bind(item, call('__it_step', it), pulls)
  }
  return [
    ['let', ['=', it, call('__it_open', value)]],
    ...(pulls.length ? [['try', block(pulls), ['catch', error, block([
      call('__it_close', [',', it, [null, true]]), ['throw', error],
    ])]]] : []),
    call('__it_close', [',', it, [null, false]]),
  ]
}

export function hasArrayPattern(p) {
  if (!Array.isArray(p)) return false
  if (p[0] === '[]') return p.length <= 2
  if (p[0] === '=' || p[0] === '...') return hasArrayPattern(p[1])
  if (p[0] === ':') return hasArrayPattern(p[2])
  if (p[0] === '{}' || p[0] === ',' || p[0] === ';') return p.slice(1).some(hasArrayPattern)
  return false
}
