/**
 * Date module — deterministic UTC algorithms first.
 *
 * Current scope: Date.UTC(...). Date objects, local-time methods, parsing, and
 * locale-sensitive formatting are deliberately staged later.
 *
 * @module date
 */

import { typed, asF64, toNumF64, allocPtr } from '../src/ir.js'
import { emit } from '../src/emit.js'
import { inc, PTR } from '../src/ctx.js'
import { VAL } from '../src/analyze.js'

const MS_PER_DAY = 86400000
const MAX_TIME = 8640000000000000

export default (ctx) => {
  Object.assign(ctx.core.stdlibDeps, {
    __date_days_from_year: [],
    __date_make_day: ['__date_days_from_year'],
    __date_make_time: [],
    __date_time_clip: [],
    __date_utc: ['__date_make_day', '__date_make_time', '__date_time_clip'],
  })

  const dateArg = (node, fallback, required = false) => {
    if (node === undefined) return typed(['f64.const', required ? NaN : fallback], 'f64')
    if (Array.isArray(node) && node[0] == null && node[1] === undefined) return typed(['f64.const', NaN], 'f64')
    return toNumF64(node, emit(node))
  }

  ctx.core.emit['Date.UTC'] = (year, month, date, hours, minutes, seconds, ms) => {
    inc('__date_utc')
    return typed(['call', '$__date_utc',
      asF64(dateArg(year, NaN, true)),
      asF64(dateArg(month, 0)),
      asF64(dateArg(date, 1)),
      asF64(dateArg(hours, 0)),
      asF64(dateArg(minutes, 0)),
      asF64(dateArg(seconds, 0)),
      asF64(dateArg(ms, 0)),
    ], 'f64')
  }

  ctx.core.stdlib['__date_days_from_year'] = `(func $__date_days_from_year (param $y f64) (result f64)
    (f64.add
      (f64.add
        (f64.mul (f64.const 365) (f64.sub (local.get $y) (f64.const 1970)))
        (f64.floor (f64.div (f64.sub (local.get $y) (f64.const 1969)) (f64.const 4))))
      (f64.sub
        (f64.floor (f64.div (f64.sub (local.get $y) (f64.const 1601)) (f64.const 400)))
        (f64.floor (f64.div (f64.sub (local.get $y) (f64.const 1901)) (f64.const 100))))))`

  ctx.core.stdlib['__date_make_day'] = `(func $__date_make_day (param $year f64) (param $month f64) (param $date f64) (result f64)
    (local $y f64) (local $m f64) (local $dt f64) (local $q f64) (local $ym f64) (local $mn f64)
    (local $mi i32) (local $leap f64) (local $day f64)
    (local.set $y (f64.trunc (local.get $year)))
    (local.set $m (f64.trunc (local.get $month)))
    (local.set $dt (f64.trunc (local.get $date)))
    (local.set $q (f64.floor (f64.div (local.get $m) (f64.const 12))))
    (local.set $ym (f64.add (local.get $y) (local.get $q)))
    (local.set $mn (f64.sub (local.get $m) (f64.mul (local.get $q) (f64.const 12))))
    (local.set $mi (i32.trunc_sat_f64_s (local.get $mn)))
    (local.set $leap
      (if (result f64)
        (f64.eq
          (f64.sub
            (call $__date_days_from_year (f64.add (local.get $ym) (f64.const 1)))
            (call $__date_days_from_year (local.get $ym)))
          (f64.const 366))
        (then (f64.const 1))
        (else (f64.const 0))))
    (if (i32.ge_s (local.get $mi) (i32.const 1)) (then (local.set $day (f64.const 31))))
    (if (i32.ge_s (local.get $mi) (i32.const 2)) (then (local.set $day (f64.add (f64.const 59) (local.get $leap)))))
    (if (i32.ge_s (local.get $mi) (i32.const 3)) (then (local.set $day (f64.add (f64.const 90) (local.get $leap)))))
    (if (i32.ge_s (local.get $mi) (i32.const 4)) (then (local.set $day (f64.add (f64.const 120) (local.get $leap)))))
    (if (i32.ge_s (local.get $mi) (i32.const 5)) (then (local.set $day (f64.add (f64.const 151) (local.get $leap)))))
    (if (i32.ge_s (local.get $mi) (i32.const 6)) (then (local.set $day (f64.add (f64.const 181) (local.get $leap)))))
    (if (i32.ge_s (local.get $mi) (i32.const 7)) (then (local.set $day (f64.add (f64.const 212) (local.get $leap)))))
    (if (i32.ge_s (local.get $mi) (i32.const 8)) (then (local.set $day (f64.add (f64.const 243) (local.get $leap)))))
    (if (i32.ge_s (local.get $mi) (i32.const 9)) (then (local.set $day (f64.add (f64.const 273) (local.get $leap)))))
    (if (i32.ge_s (local.get $mi) (i32.const 10)) (then (local.set $day (f64.add (f64.const 304) (local.get $leap)))))
    (if (i32.ge_s (local.get $mi) (i32.const 11)) (then (local.set $day (f64.add (f64.const 334) (local.get $leap)))))
    (f64.add
      (f64.add (call $__date_days_from_year (local.get $ym)) (local.get $day))
      (f64.sub (local.get $dt) (f64.const 1))))`

  ctx.core.stdlib['__date_make_time'] = `(func $__date_make_time (param $hour f64) (param $min f64) (param $sec f64) (param $ms f64) (result f64)
    (f64.add
      (f64.add
        (f64.mul (f64.trunc (local.get $hour)) (f64.const 3600000))
        (f64.mul (f64.trunc (local.get $min)) (f64.const 60000)))
      (f64.add
        (f64.mul (f64.trunc (local.get $sec)) (f64.const 1000))
        (f64.trunc (local.get $ms)))))`

  ctx.core.stdlib['__date_time_clip'] = `(func $__date_time_clip (param $time f64) (result f64)
    (if (result f64)
      (i32.or
        (f64.ne (local.get $time) (local.get $time))
        (f64.gt (f64.abs (local.get $time)) (f64.const ${MAX_TIME})))
      (then (f64.const nan))
      (else (f64.add (f64.trunc (local.get $time)) (f64.const 0)))))`

  ctx.core.stdlib['__date_utc'] = `(func $__date_utc (param $year f64) (param $month f64) (param $date f64) (param $hours f64) (param $minutes f64) (param $seconds f64) (param $ms f64) (result f64)
    (local $y f64)
    (local.set $y (f64.trunc (local.get $year)))
    (if
      (i32.and
        (f64.eq (local.get $y) (local.get $y))
        (i32.and (f64.ge (local.get $y) (f64.const 0)) (f64.le (local.get $y) (f64.const 99))))
      (then (local.set $y (f64.add (local.get $y) (f64.const 1900)))))
    (call $__date_time_clip
      (f64.add
        (f64.mul
          (call $__date_make_day (local.get $y) (local.get $month) (local.get $date))
          (f64.const ${MS_PER_DAY}))
        (call $__date_make_time (local.get $hours) (local.get $minutes) (local.get $seconds) (local.get $ms)))))`

  // === Minimal Date value object ===
  // Represented as PTR.OBJECT with a single f64 slot at offset 0 (the time value).
  // No schemaId (aux=0); dynamic property access falls through to undefined.

  ctx.core.emit['new.Date'] = (ms) => {
    let timeVal
    if (ms === undefined || ms === null) {
      timeVal = typed(['f64.const', NaN], 'f64')
    } else {
      inc('__date_time_clip')
      timeVal = typed(['call', '$__date_time_clip', toNumF64(ms, emit(ms))], 'f64')
    }
    const out = allocPtr({ type: PTR.OBJECT, len: 1, cap: 1, stride: 8, tag: 'date' })
    return typed(['block', ['result', 'f64'],
      out.init,
      ['f64.store', ['local.get', `$${out.local}`], timeVal],
      out.ptr], 'f64')
  }

  const emitDateGetTime = (dateExpr) => {
    const d = asF64(emit(dateExpr))
    return typed(['f64.load', ['i32.wrap_i64', ['i64.reinterpret_f64', d]]], 'f64')
  }

  const emitDateSetTime = (dateExpr, ms) => {
    inc('__date_time_clip')
    const d = asF64(emit(dateExpr))
    const t = typed(['call', '$__date_time_clip', toNumF64(ms, emit(ms))], 'f64')
    return typed(['block', ['result', 'f64'],
      ['f64.store', ['i32.wrap_i64', ['i64.reinterpret_f64', d]], t],
      t], 'f64')
  }

  ctx.core.emit['.getTime'] = emitDateGetTime
  ctx.core.emit[`.${VAL.DATE}:getTime`] = emitDateGetTime

  ctx.core.emit['.valueOf'] = emitDateGetTime
  ctx.core.emit[`.${VAL.DATE}:valueOf`] = emitDateGetTime

  ctx.core.emit['.setTime'] = emitDateSetTime
  ctx.core.emit[`.${VAL.DATE}:setTime`] = emitDateSetTime
}
