/**
 * navigator — the one member with compute meaning: hardwareConcurrency.
 * Pairs with jz.pool/SPMD workers for in-module tile sizing.
 *
 * host:'js' — reads through an `env.hardwareConcurrency` service (wired by
 * interop from globalThis.navigator, present in browsers and Node ≥ 21).
 * host:'wasi' — no host to ask: warns and folds to 1 (a loud, documented
 * degradation; WASI p1 has no concurrency introspection).
 *
 * @module navigator
 */

import { typed } from '../src/ir.js'
import { hostImport } from '../src/bridge.js'
import { warn } from '../src/ctx.js'

export default (ctx) => {
  ctx.core.emit['navigator.hardwareConcurrency'] = () => {
    if (ctx.transform.host === 'wasi') {
      warn('host-global', `\`navigator.hardwareConcurrency\` has no WASI source — folded to 1; size worker pools from the embedder instead`, {})
      return typed(['f64.const', 1], 'f64')
    }
    hostImport('env', 'hardwareConcurrency', ['func', '$__hw_concurrency', ['result', 'f64']])
    return typed(['call', '$__hw_concurrency'], 'f64')
  }
}
