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
