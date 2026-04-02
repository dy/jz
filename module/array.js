/**
 * Array module — literals, indexing, methods, push/pop.
 *
 * Type=1 (ARRAY): C-style header in memory.
 * Layout: [-8:len(i32)][-4:cap(i32)][elem0:f64, elem1:f64, ...]
 * offset points to elem0 (past header). len/cap mutable. Aliases see changes.
 *
 * @module array
 */

import { emit, typed, asF64, asI32 } from '../src/compile.js'
import { ctx } from '../src/ctx.js'

const ARRAY = 1, STRING = 4, STRING_SSO = 5

/** Allocate array: 8-byte header (len+cap) + n*8 data. Returns offset to data start. */
function allocArray(len, cap) {
  if (cap == null) cap = len
  const t = `__arr${ctx.uniq++}`
  ctx.locals.set(t, 'i32')
  // Alloc header(8) + data(cap*8), store len+cap, return data start
  return {
    local: t,
    setup: [
      ['local.set', `$${t}`, ['call', '$__alloc', ['i32.const', (typeof cap === 'number' ? cap : 0) * 8 + 8]]],
      ['i32.store', ['local.get', `$${t}`], typeof len === 'number' ? ['i32.const', len] : len],  // len
      ['i32.store', ['i32.add', ['local.get', `$${t}`], ['i32.const', 4]],
        typeof cap === 'number' ? ['i32.const', cap] : cap],  // cap
      ['local.set', `$${t}`, ['i32.add', ['local.get', `$${t}`], ['i32.const', 8]]],  // skip header
    ],
  }
}

/** Emit a loop that iterates over array elements. Helper for methods. */
function arrayLoop(arrExpr, bodyFn) {
  const ptr = `__ap${ctx.uniq++}`, len = `__al${ctx.uniq++}`, i = `__ai${ctx.uniq++}`
  ctx.locals.set(ptr, 'i32')
  ctx.locals.set(len, 'i32')
  ctx.locals.set(i, 'i32')
  const id = ctx.uniq++
  return [
    ['local.set', `$${ptr}`, ['call', '$__ptr_offset', asF64(arrExpr)]],
    ['local.set', `$${len}`, ['call', '$__len', asF64(arrExpr)]],
    ['local.set', `$${i}`, ['i32.const', 0]],
    ['block', `$brk${id}`, ['loop', `$loop${id}`,
      ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${i}`], ['local.get', `$${len}`]]],
      ...bodyFn(ptr, len, i),
      ['local.set', `$${i}`, ['i32.add', ['local.get', `$${i}`], ['i32.const', 1]]],
      ['br', `$loop${id}`]]],
  ]
}

function elemLoad(ptr, i) {
  return ['f64.load', ['i32.add', ['local.get', `$${ptr}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', 3]]]]
}

function elemStore(ptr, i, val) {
  return ['f64.store', ['i32.add', ['local.get', `$${ptr}`], ['i32.shl', ['local.get', `$${i}`], ['i32.const', 3]]], val]
}

export default () => {
  // === Array literal ===

  ctx.emit['['] = (...elems) => {
    const hasSpread = elems.some(e => Array.isArray(e) && e[0] === '...')

    if (!hasSpread) {
      const len = elems.length
      const { local: t, setup } = allocArray(len, Math.max(len, 4))  // min cap=4 for small pushes
      const body = [...setup]
      for (let i = 0; i < len; i++)
        body.push(['f64.store', ['i32.add', ['local.get', `$${t}`], ['i32.const', i * 8]], asF64(emit(elems[i]))])
      body.push(['call', '$__mkptr', ['i32.const', ARRAY], ['i32.const', 0], ['local.get', `$${t}`]])
      return typed(['block', ['result', 'f64'], ...body], 'f64')
    }

    // Spread: compute total, alloc, copy
    const out = `__sa${ctx.uniq++}`, pos = `__sp${ctx.uniq++}`, total = `__st${ctx.uniq++}`
    ctx.locals.set(out, 'i32'); ctx.locals.set(pos, 'i32'); ctx.locals.set(total, 'i32')

    const lenCalc = [['local.set', `$${total}`, ['i32.const', 0]]]
    for (const e of elems) {
      if (Array.isArray(e) && e[0] === '...')
        lenCalc.push(['local.set', `$${total}`, ['i32.add', ['local.get', `$${total}`], ['call', '$__len', asF64(emit(e[1]))]]])
      else
        lenCalc.push(['local.set', `$${total}`, ['i32.add', ['local.get', `$${total}`], ['i32.const', 1]]])
    }

    const body = [...lenCalc,
      // Alloc header + data
      ['local.set', `$${out}`, ['call', '$__alloc', ['i32.add', ['i32.const', 8], ['i32.shl', ['local.get', `$${total}`], ['i32.const', 3]]]]],
      ['i32.store', ['local.get', `$${out}`], ['local.get', `$${total}`]],  // len
      ['i32.store', ['i32.add', ['local.get', `$${out}`], ['i32.const', 4]], ['local.get', `$${total}`]],  // cap=len
      ['local.set', `$${out}`, ['i32.add', ['local.get', `$${out}`], ['i32.const', 8]]],  // skip header
      ['local.set', `$${pos}`, ['i32.const', 0]],
    ]

    for (const e of elems) {
      if (Array.isArray(e) && e[0] === '...') {
        const src = `__ss${ctx.uniq++}`, slen = `__sl${ctx.uniq++}`, si = `__si${ctx.uniq++}`
        ctx.locals.set(src, 'i32'); ctx.locals.set(slen, 'i32'); ctx.locals.set(si, 'i32')
        const id = ctx.uniq++
        body.push(
          ['local.set', `$${src}`, ['call', '$__ptr_offset', asF64(emit(e[1]))]],
          ['local.set', `$${slen}`, ['call', '$__len', asF64(emit(e[1]))]],
          ['local.set', `$${si}`, ['i32.const', 0]],
          ['block', `$brk${id}`, ['loop', `$loop${id}`,
            ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${si}`], ['local.get', `$${slen}`]]],
            ['f64.store',
              ['i32.add', ['local.get', `$${out}`], ['i32.shl', ['local.get', `$${pos}`], ['i32.const', 3]]],
              ['f64.load', ['i32.add', ['local.get', `$${src}`], ['i32.shl', ['local.get', `$${si}`], ['i32.const', 3]]]]],
            ['local.set', `$${pos}`, ['i32.add', ['local.get', `$${pos}`], ['i32.const', 1]]],
            ['local.set', `$${si}`, ['i32.add', ['local.get', `$${si}`], ['i32.const', 1]]],
            ['br', `$loop${id}`]]])
      } else {
        body.push(
          ['f64.store', ['i32.add', ['local.get', `$${out}`], ['i32.shl', ['local.get', `$${pos}`], ['i32.const', 3]]], asF64(emit(e))],
          ['local.set', `$${pos}`, ['i32.add', ['local.get', `$${pos}`], ['i32.const', 1]]])
      }
    }

    body.push(['call', '$__mkptr', ['i32.const', ARRAY], ['i32.const', 0], ['local.get', `$${out}`]])
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // === Index read ===

  ctx.emit['[]'] = (arr, idx) => {
    // Boxed object: index the inner value (slot 0)
    if (typeof arr === 'string' && ctx.schema.isBoxed?.(arr)) {
      const va = ctx.schema.emitInner(arr), vi = asI32(emit(idx))
      return typed(
        ['f64.load', ['i32.add', ['call', '$__ptr_offset', asF64(va)], ['i32.shl', vi, ['i32.const', 3]]]],
        'f64')
    }
    const va = emit(arr), vi = asI32(emit(idx))
    const ptrExpr = asF64(va)
    if (ctx.modules['string'])
      return typed(
        ['if', ['result', 'f64'],
          ['i32.ge_u', ['call', '$__ptr_type', ptrExpr], ['i32.const', STRING]],
          ['then', ['f64.convert_i32_u', ['call', '$__char_at', ptrExpr, vi]]],
          ['else', ['f64.load', ['i32.add', ['call', '$__ptr_offset', ptrExpr], ['i32.shl', vi, ['i32.const', 3]]]]]],
        'f64')
    return typed(
      ['f64.load', ['i32.add', ['call', '$__ptr_offset', ptrExpr], ['i32.shl', vi, ['i32.const', 3]]]],
      'f64')
  }

  // === Push/Pop (mutate in place) ===

  // .push(val) → append, increment len, return array (same pointer)
  ctx.emit['.push'] = (arr, ...vals) => {
    const va = asF64(emit(arr))
    const t = `__pp${ctx.uniq++}`, len = `__pl${ctx.uniq++}`, i = `__pi${ctx.uniq++}`
    ctx.locals.set(t, 'f64'); ctx.locals.set(len, 'i32'); ctx.locals.set(i, 'i32')

    const body = [
      ['local.set', `$${t}`, va],
      ['local.set', `$${len}`, ['call', '$__len', ['local.get', `$${t}`]]],
    ]

    // Store each value and increment len
    for (const val of vals) {
      const vv = asF64(emit(val))
      body.push(
        // Store value at offset + len*8
        ['f64.store',
          ['i32.add', ['call', '$__ptr_offset', ['local.get', `$${t}`]], ['i32.shl', ['local.get', `$${len}`], ['i32.const', 3]]],
          vv],
        // Increment len
        ['local.set', `$${len}`, ['i32.add', ['local.get', `$${len}`], ['i32.const', 1]]]
      )
    }

    // Update array length header and return array
    body.push(
      ['call', '$__set_len', ['local.get', `$${t}`], ['local.get', `$${len}`]],
      ['local.get', `$${t}`]
    )

    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // .pop() → decrement len, return removed element
  ctx.emit['.pop'] = (arr) => {
    const va = asF64(emit(arr))
    const t = `__po${ctx.uniq++}`, len = `__pl${ctx.uniq++}`
    ctx.locals.set(t, 'f64'); ctx.locals.set(len, 'i32')
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${t}`, va],
      ['local.set', `$${len}`, ['i32.sub', ['call', '$__len', ['local.get', `$${t}`]], ['i32.const', 1]]],
      ['call', '$__set_len', ['local.get', `$${t}`], ['local.get', `$${len}`]],
      ['f64.load',
        ['i32.add', ['call', '$__ptr_offset', ['local.get', `$${t}`]], ['i32.shl', ['local.get', `$${len}`], ['i32.const', 3]]]]], 'f64')
  }

  // === Array methods ===

  ctx.emit['.map'] = (arr, fn) => {
    const va = emit(arr)
    const out = `__mo${ctx.uniq++}`, len = `__ml${ctx.uniq++}`
    ctx.locals.set(out, 'i32'); ctx.locals.set(len, 'i32')
    const loop = arrayLoop(va, (ptr, _len, i) => [
      elemStore(out, i, asF64(ctx.fn.call(emit(fn), [typed(elemLoad(ptr, i), 'f64')])))
    ])
    // Allocate header + data for result
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${len}`, ['call', '$__len', asF64(va)]],
      ['local.set', `$${out}`, ['call', '$__alloc', ['i32.add', ['i32.const', 8], ['i32.shl', ['local.get', `$${len}`], ['i32.const', 3]]]]],
      ['i32.store', ['local.get', `$${out}`], ['local.get', `$${len}`]],  // len
      ['i32.store', ['i32.add', ['local.get', `$${out}`], ['i32.const', 4]], ['local.get', `$${len}`]],  // cap
      ['local.set', `$${out}`, ['i32.add', ['local.get', `$${out}`], ['i32.const', 8]]],
      ...loop,
      ['call', '$__mkptr', ['i32.const', ARRAY], ['i32.const', 0], ['local.get', `$${out}`]]], 'f64')
  }

  ctx.emit['.filter'] = (arr, fn) => {
    const va = emit(arr)
    const out = `__fo${ctx.uniq++}`, count = `__fc${ctx.uniq++}`, maxLen = `__fm${ctx.uniq++}`
    ctx.locals.set(out, 'i32'); ctx.locals.set(count, 'i32'); ctx.locals.set(maxLen, 'i32')
    const loop = arrayLoop(va, (ptr, _len, i) => [
      ['if', ['f64.ne', asF64(ctx.fn.call(emit(fn), [typed(elemLoad(ptr, i), 'f64')])), ['f64.const', 0]],
        ['then',
          ['f64.store', ['i32.add', ['local.get', `$${out}`], ['i32.shl', ['local.get', `$${count}`], ['i32.const', 3]]], elemLoad(ptr, i)],
          ['local.set', `$${count}`, ['i32.add', ['local.get', `$${count}`], ['i32.const', 1]]]]]
    ])
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${maxLen}`, ['call', '$__len', asF64(va)]],
      ['local.set', `$${out}`, ['call', '$__alloc', ['i32.add', ['i32.const', 8], ['i32.shl', ['local.get', `$${maxLen}`], ['i32.const', 3]]]]],
      ['i32.store', ['local.get', `$${out}`], ['i32.const', 0]],  // len=0 initially
      ['i32.store', ['i32.add', ['local.get', `$${out}`], ['i32.const', 4]], ['local.get', `$${maxLen}`]],  // cap
      ['local.set', `$${out}`, ['i32.add', ['local.get', `$${out}`], ['i32.const', 8]]],
      ['local.set', `$${count}`, ['i32.const', 0]],
      ...loop,
      // Set actual length
      ['i32.store', ['i32.sub', ['local.get', `$${out}`], ['i32.const', 8]], ['local.get', `$${count}`]],
      ['call', '$__mkptr', ['i32.const', ARRAY], ['i32.const', 0], ['local.get', `$${out}`]]], 'f64')
  }

  ctx.emit['.reduce'] = (arr, fn, init) => {
    const va = emit(arr)
    const acc = `__ra${ctx.uniq++}`
    ctx.locals.set(acc, 'f64')
    const loop = arrayLoop(va, (ptr, _len, i) => [
      ['local.set', `$${acc}`, asF64(ctx.fn.call(emit(fn), [typed(['local.get', `$${acc}`], 'f64'), typed(elemLoad(ptr, i), 'f64')]))]
    ])
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${acc}`, init ? asF64(emit(init)) : ['f64.const', 0]],
      ...loop,
      ['local.get', `$${acc}`]], 'f64')
  }

  ctx.emit['.forEach'] = (arr, fn) => {
    const va = emit(arr)
    const tmp = `__ft${ctx.uniq++}`
    ctx.locals.set(tmp, 'f64')
    const loop = arrayLoop(va, (ptr, _len, i) => [
      ['local.set', `$${tmp}`, asF64(ctx.fn.call(emit(fn), [typed(elemLoad(ptr, i), 'f64')]))]
    ])
    return typed(['block', ['result', 'f64'], ...loop, ['f64.const', 0]], 'f64')
  }

  ctx.emit['.find'] = (arr, fn) => {
    const va = emit(arr)
    const result = `__ff${ctx.uniq++}`, found = `__fd${ctx.uniq++}`
    ctx.locals.set(result, 'f64'); ctx.locals.set(found, 'i32')
    const loop = arrayLoop(va, (ptr, _len, i) => [
      ['if', ['i32.eqz', ['local.get', `$${found}`]],
        ['then',
          ['if', ['f64.ne', asF64(ctx.fn.call(emit(fn), [typed(elemLoad(ptr, i), 'f64')])), ['f64.const', 0]],
            ['then',
              ['local.set', `$${result}`, elemLoad(ptr, i)],
              ['local.set', `$${found}`, ['i32.const', 1]]]]]]
    ])
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${result}`, ['f64.const', 0]],
      ['local.set', `$${found}`, ['i32.const', 0]],
      ...loop,
      ['local.get', `$${result}`]], 'f64')
  }

  ctx.emit['.indexOf'] = (arr, val) => {
    const va = emit(arr), vv = asF64(emit(val))
    const result = `__ix${ctx.uniq++}`
    ctx.locals.set(result, 'i32')
    const loop = arrayLoop(va, (ptr, _len, i) => [
      ['if', ['f64.eq', elemLoad(ptr, i), vv],
        ['then', ['local.set', `$${result}`, ['local.get', `$${i}`]]]]
    ])
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${result}`, ['i32.const', -1]],
      ...loop,
      ['f64.convert_i32_s', ['local.get', `$${result}`]]], 'f64')
  }

  ctx.emit['.includes'] = (arr, val) => {
    const va = emit(arr), vv = asF64(emit(val))
    const result = `__ic${ctx.uniq++}`
    ctx.locals.set(result, 'i32')
    const loop = arrayLoop(va, (ptr, _len, i) => [
      ['if', ['f64.eq', elemLoad(ptr, i), vv],
        ['then', ['local.set', `$${result}`, ['i32.const', 1]]]]
    ])
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${result}`, ['i32.const', 0]],
      ...loop,
      ['f64.convert_i32_s', ['local.get', `$${result}`]]], 'f64')
  }

  ctx.emit['.slice'] = (arr, start, end) => {
    const va = emit(arr), vs = asI32(emit(start))
    const ve = end ? asI32(emit(end)) : ['call', '$__len', asF64(va)]
    const out = `__so${ctx.uniq++}`, len = `__sl${ctx.uniq++}`, j = `__sj${ctx.uniq++}`, ptr = `__sp${ctx.uniq++}`
    ctx.locals.set(out, 'i32'); ctx.locals.set(len, 'i32'); ctx.locals.set(j, 'i32'); ctx.locals.set(ptr, 'i32')
    const id = ctx.uniq++
    return typed(['block', ['result', 'f64'],
      ['local.set', `$${ptr}`, ['call', '$__ptr_offset', asF64(va)]],
      ['local.set', `$${len}`, ['i32.sub', ve, vs]],
      // Alloc header + data
      ['local.set', `$${out}`, ['call', '$__alloc', ['i32.add', ['i32.const', 8], ['i32.shl', ['local.get', `$${len}`], ['i32.const', 3]]]]],
      ['i32.store', ['local.get', `$${out}`], ['local.get', `$${len}`]],
      ['i32.store', ['i32.add', ['local.get', `$${out}`], ['i32.const', 4]], ['local.get', `$${len}`]],
      ['local.set', `$${out}`, ['i32.add', ['local.get', `$${out}`], ['i32.const', 8]]],
      ['local.set', `$${j}`, ['i32.const', 0]],
      ['block', `$brk${id}`, ['loop', `$loop${id}`,
        ['br_if', `$brk${id}`, ['i32.ge_s', ['local.get', `$${j}`], ['local.get', `$${len}`]]],
        ['f64.store',
          ['i32.add', ['local.get', `$${out}`], ['i32.shl', ['local.get', `$${j}`], ['i32.const', 3]]],
          ['f64.load', ['i32.add', ['local.get', `$${ptr}`], ['i32.shl', ['i32.add', vs, ['local.get', `$${j}`]], ['i32.const', 3]]]]],
        ['local.set', `$${j}`, ['i32.add', ['local.get', `$${j}`], ['i32.const', 1]]],
        ['br', `$loop${id}`]]],
      ['call', '$__mkptr', ['i32.const', ARRAY], ['i32.const', 0], ['local.get', `$${out}`]]], 'f64')
  }

  // .concat(...others) → concatenate arrays
  ctx.emit['.array:concat'] = (arr, ...others) => {
    const result = `__res${ctx.uniq++}`, len = `__len${ctx.uniq++}`, pos = `__pos${ctx.uniq++}`
    ctx.locals.set(result, 'i32')
    ctx.locals.set(len, 'i32')
    ctx.locals.set(pos, 'i32')

    const va = asF64(emit(arr))

    // Calculate total length
    const body = [
      ['local.set', `$${len}`, ['call', '$__len', va]],
    ]

    const otherVals = []
    for (const other of others) {
      const vo = asF64(emit(other))
      otherVals.push(vo)
      body.push(['local.set', `$${len}`, ['i32.add', ['local.get', `$${len}`], ['call', '$__len', vo]]])
    }

    // Allocate result array
    body.push(
      ['local.set', `$${result}`, ['call', '$__alloc', ['i32.add', ['i32.const', 8], ['i32.shl', ['local.get', `$${len}`], ['i32.const', 3]]]]],
      ['i32.store', ['local.get', `$${result}`], ['local.get', `$${len}`]],
      ['i32.store', ['i32.add', ['local.get', `$${result}`], ['i32.const', 4]], ['local.get', `$${len}`]],
      ['local.set', `$${result}`, ['i32.add', ['local.get', `$${result}`], ['i32.const', 8]]]
    )

    // Copy source array
    body.push(
      ['local.set', `$${pos}`, ['i32.const', 0]],
      ['local.set', `$${len}`, ['call', '$__len', va]]
    )
    const id = ctx.uniq++
    body.push(
      ['block', `$done${id}`, ['loop', `$loop${id}`,
        ['br_if', `$done${id}`, ['i32.ge_s', ['local.get', `$${pos}`], ['local.get', `$${len}`]]],
        ['f64.store',
          ['i32.add', ['local.get', `$${result}`], ['i32.shl', ['local.get', `$${pos}`], ['i32.const', 3]]],
          ['f64.load', ['i32.add', ['call', '$__ptr_offset', va], ['i32.shl', ['local.get', `$${pos}`], ['i32.const', 3]]]]],
        ['local.set', `$${pos}`, ['i32.add', ['local.get', `$${pos}`], ['i32.const', 1]]],
        ['br', `$loop${id}`]]]
    )

    // Copy each other array
    let offset = `__off${ctx.uniq++}`
    ctx.locals.set(offset, 'i32')
    body.push(['local.set', `$${offset}`, ['call', '$__len', va]])

    for (let i = 0; i < otherVals.length; i++) {
      const vo = otherVals[i]
      const id2 = ctx.uniq++
      body.push(
        ['local.set', `$${pos}`, ['i32.const', 0]],
        ['local.set', `$${len}`, ['call', '$__len', vo]],
        ['block', `$done${id2}`, ['loop', `$loop${id2}`,
          ['br_if', `$done${id2}`, ['i32.ge_s', ['local.get', `$${pos}`], ['local.get', `$${len}`]]],
          ['f64.store',
            ['i32.add', ['local.get', `$${result}`], ['i32.shl', ['i32.add', ['local.get', `$${offset}`], ['local.get', `$${pos}`]], ['i32.const', 3]]],
            ['f64.load', ['i32.add', ['call', '$__ptr_offset', vo], ['i32.shl', ['local.get', `$${pos}`], ['i32.const', 3]]]]],
          ['local.set', `$${pos}`, ['i32.add', ['local.get', `$${pos}`], ['i32.const', 1]]],
          ['br', `$loop${id2}`]]],
        ['local.set', `$${offset}`, ['i32.add', ['local.get', `$${offset}`], ['local.get', `$${len}`]]]
      )
    }

    body.push(['call', '$__mkptr', ['i32.const', ARRAY], ['i32.const', 0], ['local.get', `$${result}`]])
    return typed(['block', ['result', 'f64'], ...body], 'f64')
  }

  // .join(sep) → concatenate array elements with separator string
  ctx.emit['.join'] = (arr, sep) => {
    for (const n of ['__str_join', '__str_concat', '__to_str', '__ftoa', '__itoa', '__pow10', '__mkstr', '__static_str', '__str_byteLen'])
      ctx.includes.add(n)
    return typed(['call', '$__str_join', asF64(emit(arr)), asF64(emit(sep))], 'f64')
  }
}
