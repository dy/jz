// Loop keywords: for, while
// Extension for subscript - can be ported to subscript package later

import { token, expr, skip, cur, idx, err, space } from 'subscript/src/parse.js'
import { PREC_STATEMENT, PREC_SEQ, PREC_ASSIGN, OPAREN, CPAREN } from 'subscript/src/const.js'

const SEMI = 59 // ';'

// Loops registered at high precedence so they match inside body parsing
// Body parsed at PREC_LOOP (lower) so `,` and `;` don't get consumed
const PREC_FOR = PREC_ASSIGN  // 20 - same as assignment
const PREC_LOOP = PREC_STATEMENT + 1  // 6 - for body parsing

const DEBUG = false

// for (init; cond; step) body
// Parses as: ['for', init, cond, step, body]
token('for', PREC_FOR, a => {
  if (a) return // for is prefix only
  DEBUG && console.log('for: start at', idx)

  space()
  if (cur.charCodeAt(idx) !== OPAREN) err('Expected ( after for')
  skip() // consume (

  // Parse init - use PREC_SEQ to stop before ;
  space()
  const init = cur.charCodeAt(idx) === SEMI ? null : expr(PREC_SEQ)
  DEBUG && console.log('for: init=', init, 'idx=', idx)
  space()
  if (cur.charCodeAt(idx) !== SEMI) err('Expected ; after for init')
  skip() // consume ;

  // Parse condition
  space()
  const cond = cur.charCodeAt(idx) === SEMI ? null : expr(PREC_SEQ)
  DEBUG && console.log('for: cond=', cond, 'idx=', idx)
  space()
  if (cur.charCodeAt(idx) !== SEMI) err('Expected ; after for condition')
  skip() // consume ;

  // Parse step
  space()
  const step = cur.charCodeAt(idx) === CPAREN ? null : expr(PREC_SEQ)
  DEBUG && console.log('for: step=', step, 'idx=', idx)
  space()
  if (cur.charCodeAt(idx) !== CPAREN) err('Expected ) after for step')
  skip() // consume )

  // Parse body - either single expr or block
  space()
  DEBUG && console.log('for: body start at', idx, 'char=', cur[idx])
  const body = expr(PREC_LOOP)
  DEBUG && console.log('for: body=', body, 'idx=', idx)

  return ['for', init, cond, step, body]
})

// while (cond) body
// Parses as: ['while', cond, body]
token('while', PREC_FOR, a => {
  if (a) return // while is prefix only

  space()
  if (cur.charCodeAt(idx) !== OPAREN) err('Expected ( after while')
  skip() // consume (

  const cond = expr(0)
  if (cur.charCodeAt(idx) !== CPAREN) err('Expected ) after while condition')
  skip() // consume )

  // Parse body
  space()
  const body = expr(PREC_LOOP)

  return ['while', cond, body]
})
