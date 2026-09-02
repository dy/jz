/**
 * Standard modules written in jz's own subset, bundled like user modules.
 *
 * A `jz:` specifier resolves here when the compile supplies no source for it;
 * `STD_GLOBALS` names the globals each module provides, so a module that
 * references one without declaring it gets the import implicitly (jzify) –
 * user-visible globals (`Event`, `DOMException`) and the runtime helpers the
 * lowerings emit (`__p_new`, `__it_drain`) alike. prepareModule caches by
 * specifier: one copy per compile, shared identity and one microtask queue.
 * Pay-per-use: a program referencing none of them compiles byte-identically.
 *
 * `STD_HOST_EXPORTS` lists the exports interop reads off the instance by
 * plain name (the async boundary); prepare re-exports them from the program
 * whenever the module is bundled, from whichever module pulled it in.
 *
 * @module std
 */
import events from './events.js'
import weakref from './weakref.js'
import domexception from './domexception.js'
import asyncRt from './async.js'
import asyncgen from './asyncgen.js'
import iter from './iter.js'
import iterArr from './iter-arr.js'
import iterHelpers from './iter-helpers.js'
import usp from './usp.js'

export const STD_SOURCES = {
  'jz:events': events, 'jz:weakref': weakref, 'jz:domexception': domexception,
  'jz:async': asyncRt, 'jz:asyncgen': asyncgen,
  'jz:iter': iter, 'jz:iter-arr': iterArr, 'jz:iter-helpers': iterHelpers,
  'jz:usp': usp,
}

export const STD_HOST_EXPORTS = { 'jz:async': ['__mt_drain', '__p_state', '__p_value', '__p_make', '__p_finish'] }

/** global name → the `jz:` module exporting it (prototype-less: `constructor` is a plain identifier) */
export const STD_GLOBALS = Object.create(null)
for (const spec of Object.keys(STD_SOURCES))
  for (const line of STD_SOURCES[spec].split('\n')) {
    const at = line.startsWith('export let ') ? 11 : line.startsWith('export class ') ? 13 : 0
    if (at) STD_GLOBALS[line.slice(at, line.indexOf(' ', at))] = spec
  }
