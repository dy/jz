/**
 * Date module — deterministic UTC algorithms first.
 *
 * Current scope: Date.UTC(...), Date object construction, UTC getters/setters,
 * toISOString, toUTCString. Local-time methods, parsing, and locale-sensitive
 * formatting are deliberately staged later.
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
    __date_day: [],
    __date_time_within_day: ['__date_day'],
    __date_weekday: ['__date_day'],
    __date_year_from_time: ['__date_days_from_year'],
    __date_in_leap_year: ['__date_year_from_time', '__date_days_from_year'],
    __date_day_within_year: ['__date_day', '__date_year_from_time', '__date_days_from_year'],
    __date_month_from_time: ['__date_day_within_year', '__date_in_leap_year'],
    __date_month_start: [],
    __date_date_from_time: ['__date_day_within_year', '__date_month_from_time', '__date_in_leap_year', '__date_month_start'],
    __date_hour_from_time: ['__date_time_within_day'],
    __date_min_from_time: ['__date_time_within_day', '__date_hour_from_time'],
    __date_sec_from_time: ['__date_time_within_day', '__date_hour_from_time', '__date_min_from_time'],
    __date_ms_from_time: ['__date_time_within_day', '__date_hour_from_time', '__date_min_from_time', '__date_sec_from_time'],
    __date_set_time: ['__date_time_clip'],
    __date_set_utc_date: ['__date_set_time', '__date_make_day', '__date_year_from_time', '__date_month_from_time', '__date_time_within_day'],
    __date_set_utc_month: ['__date_set_time', '__date_make_day', '__date_year_from_time', '__date_time_within_day'],
    __date_set_utc_full_year: ['__date_set_time', '__date_make_day', '__date_time_within_day'],
    __date_set_utc_hours: ['__date_set_time', '__date_day', '__date_make_time'],
    __date_set_utc_minutes: ['__date_set_time', '__date_day', '__date_make_time', '__date_hour_from_time'],
    __date_set_utc_seconds: ['__date_set_time', '__date_day', '__date_make_time', '__date_hour_from_time', '__date_min_from_time'],
    __date_set_utc_milliseconds: ['__date_set_time', '__date_day', '__date_make_time', '__date_hour_from_time', '__date_min_from_time', '__date_sec_from_time'],
    __date_write2: [],
    __date_write3: [],
    __date_write4: [],
    __date_to_iso_string: ['__mkstr', '__alloc', '__itoa', '__date_year_from_time', '__date_month_from_time', '__date_date_from_time', '__date_hour_from_time', '__date_min_from_time', '__date_sec_from_time', '__date_ms_from_time', '__date_write2', '__date_write3', '__date_write4'],
    __date_to_utc_string: ['__mkstr', '__alloc', '__itoa', '__date_weekday', '__date_date_from_time', '__date_month_from_time', '__date_year_from_time', '__date_hour_from_time', '__date_min_from_time', '__date_sec_from_time', '__date_write2', '__date_write4'],
  })

  const dateArg = (node, fallback, required = false) => {
    if (node === undefined) return typed(['f64.const', required ? NaN : fallback], 'f64')
    if (Array.isArray(node) && node[0] == null && node[1] === undefined) return typed(['f64.const', NaN], 'f64')
    return toNumF64(node, emit(node))
  }

  const missingArg = (node) => node === undefined

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

  // ── Core algorithms ───────────────────────────────────────────────────────

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

  // ── Time decomposition (ECMA-262 §21.4.1) ────────────────────────────────

  ctx.core.stdlib['__date_day'] = `(func $__date_day (param $t f64) (result f64)
    (f64.floor (f64.div (local.get $t) (f64.const ${MS_PER_DAY}))))`

  ctx.core.stdlib['__date_time_within_day'] = `(func $__date_time_within_day (param $t f64) (result f64)
    (f64.sub (local.get $t) (f64.mul (call $__date_day (local.get $t)) (f64.const ${MS_PER_DAY}))))`

  ctx.core.stdlib['__date_weekday'] = `(func $__date_weekday (param $t f64) (result f64)
    (local $wd i32)
    (if (f64.ne (local.get $t) (local.get $t)) (then (return (f64.const nan))))
    (local.set $wd (i32.rem_s (i32.add (i32.trunc_sat_f64_s (call $__date_day (local.get $t))) (i32.const 4)) (i32.const 7)))
    (if (i32.lt_s (local.get $wd) (i32.const 0)) (then (local.set $wd (i32.add (local.get $wd) (i32.const 7)))))
    (f64.convert_i32_s (local.get $wd)))`

  ctx.core.stdlib['__date_year_from_time'] = `(func $__date_year_from_time (param $t f64) (result f64)
    (local $day f64) (local $y f64)
    (if (f64.ne (local.get $t) (local.get $t)) (then (return (f64.const nan))))
    (local.set $day (call $__date_day (local.get $t)))
    (local.set $y (f64.floor (f64.add (f64.const 1970) (f64.div (local.get $day) (f64.const 365.2425)))))
    (if (f64.gt (call $__date_days_from_year (local.get $y)) (local.get $day))
      (then (local.set $y (f64.sub (local.get $y) (f64.const 1)))))
    (if (f64.le (call $__date_days_from_year (f64.add (local.get $y) (f64.const 1))) (local.get $day))
      (then (local.set $y (f64.add (local.get $y) (f64.const 1)))))
    (local.get $y))`

  ctx.core.stdlib['__date_in_leap_year'] = `(func $__date_in_leap_year (param $t f64) (result f64)
    (local $y f64)
    (local.set $y (call $__date_year_from_time (local.get $t)))
    (if (result f64)
      (f64.eq (f64.sub (call $__date_days_from_year (f64.add (local.get $y) (f64.const 1))) (call $__date_days_from_year (local.get $y))) (f64.const 366))
      (then (f64.const 1))
      (else (f64.const 0))))`

  ctx.core.stdlib['__date_day_within_year'] = `(func $__date_day_within_year (param $t f64) (result f64)
    (f64.sub (call $__date_day (local.get $t)) (call $__date_days_from_year (call $__date_year_from_time (local.get $t)))))`

  ctx.core.stdlib['__date_month_from_time'] = `(func $__date_month_from_time (param $t f64) (result f64)
    (local $dwy i32) (local $leap i32) (local $m i32)
    (if (f64.ne (local.get $t) (local.get $t)) (then (return (f64.const nan))))
    (local.set $dwy (i32.trunc_sat_f64_s (call $__date_day_within_year (local.get $t))))
    (local.set $leap (i32.trunc_sat_f64_s (call $__date_in_leap_year (local.get $t))))
    (local.set $m (i32.const 0))
    (if (i32.ge_s (local.get $dwy) (i32.const 31)) (then (local.set $m (i32.const 1))))
    (if (i32.ge_s (local.get $dwy) (i32.add (i32.const 59) (local.get $leap))) (then (local.set $m (i32.const 2))))
    (if (i32.ge_s (local.get $dwy) (i32.add (i32.const 90) (local.get $leap))) (then (local.set $m (i32.const 3))))
    (if (i32.ge_s (local.get $dwy) (i32.add (i32.const 120) (local.get $leap))) (then (local.set $m (i32.const 4))))
    (if (i32.ge_s (local.get $dwy) (i32.add (i32.const 151) (local.get $leap))) (then (local.set $m (i32.const 5))))
    (if (i32.ge_s (local.get $dwy) (i32.add (i32.const 181) (local.get $leap))) (then (local.set $m (i32.const 6))))
    (if (i32.ge_s (local.get $dwy) (i32.add (i32.const 212) (local.get $leap))) (then (local.set $m (i32.const 7))))
    (if (i32.ge_s (local.get $dwy) (i32.add (i32.const 243) (local.get $leap))) (then (local.set $m (i32.const 8))))
    (if (i32.ge_s (local.get $dwy) (i32.add (i32.const 273) (local.get $leap))) (then (local.set $m (i32.const 9))))
    (if (i32.ge_s (local.get $dwy) (i32.add (i32.const 304) (local.get $leap))) (then (local.set $m (i32.const 10))))
    (if (i32.ge_s (local.get $dwy) (i32.add (i32.const 334) (local.get $leap))) (then (local.set $m (i32.const 11))))
    (f64.convert_i32_s (local.get $m)))`

  ctx.core.stdlib['__date_month_start'] = `(func $__date_month_start (param $month i32) (param $leap i32) (result i32)
    (if (i32.eq (local.get $month) (i32.const 0)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $month) (i32.const 1)) (then (return (i32.const 31))))
    (if (i32.eq (local.get $month) (i32.const 2)) (then (return (i32.add (i32.const 59) (local.get $leap)))))
    (if (i32.eq (local.get $month) (i32.const 3)) (then (return (i32.add (i32.const 90) (local.get $leap)))))
    (if (i32.eq (local.get $month) (i32.const 4)) (then (return (i32.add (i32.const 120) (local.get $leap)))))
    (if (i32.eq (local.get $month) (i32.const 5)) (then (return (i32.add (i32.const 151) (local.get $leap)))))
    (if (i32.eq (local.get $month) (i32.const 6)) (then (return (i32.add (i32.const 181) (local.get $leap)))))
    (if (i32.eq (local.get $month) (i32.const 7)) (then (return (i32.add (i32.const 212) (local.get $leap)))))
    (if (i32.eq (local.get $month) (i32.const 8)) (then (return (i32.add (i32.const 243) (local.get $leap)))))
    (if (i32.eq (local.get $month) (i32.const 9)) (then (return (i32.add (i32.const 273) (local.get $leap)))))
    (if (i32.eq (local.get $month) (i32.const 10)) (then (return (i32.add (i32.const 304) (local.get $leap)))))
    (if (i32.eq (local.get $month) (i32.const 11)) (then (return (i32.add (i32.const 334) (local.get $leap)))))
    (i32.const 334))`

  ctx.core.stdlib['__date_date_from_time'] = `(func $__date_date_from_time (param $t f64) (result f64)
    (local $dwy i32) (local $m i32) (local $leap i32)
    (if (f64.ne (local.get $t) (local.get $t)) (then (return (f64.const nan))))
    (local.set $dwy (i32.trunc_sat_f64_s (call $__date_day_within_year (local.get $t))))
    (local.set $m (i32.trunc_sat_f64_s (call $__date_month_from_time (local.get $t))))
    (local.set $leap (i32.trunc_sat_f64_s (call $__date_in_leap_year (local.get $t))))
    (f64.convert_i32_s (i32.add (i32.sub (local.get $dwy) (call $__date_month_start (local.get $m) (local.get $leap))) (i32.const 1))))`

  ctx.core.stdlib['__date_hour_from_time'] = `(func $__date_hour_from_time (param $t f64) (result f64)
    (f64.floor (f64.div (call $__date_time_within_day (local.get $t)) (f64.const 3600000))))`

  ctx.core.stdlib['__date_min_from_time'] = `(func $__date_min_from_time (param $t f64) (result f64)
    (f64.floor (f64.div (f64.sub (call $__date_time_within_day (local.get $t)) (f64.mul (call $__date_hour_from_time (local.get $t)) (f64.const 3600000))) (f64.const 60000))))`

  ctx.core.stdlib['__date_sec_from_time'] = `(func $__date_sec_from_time (param $t f64) (result f64)
    (f64.floor (f64.div (f64.sub (f64.sub (call $__date_time_within_day (local.get $t)) (f64.mul (call $__date_hour_from_time (local.get $t)) (f64.const 3600000))) (f64.mul (call $__date_min_from_time (local.get $t)) (f64.const 60000))) (f64.const 1000))))`

  ctx.core.stdlib['__date_ms_from_time'] = `(func $__date_ms_from_time (param $t f64) (result f64)
    (f64.sub (f64.sub (f64.sub (call $__date_time_within_day (local.get $t)) (f64.mul (call $__date_hour_from_time (local.get $t)) (f64.const 3600000))) (f64.mul (call $__date_min_from_time (local.get $t)) (f64.const 60000))) (f64.mul (call $__date_sec_from_time (local.get $t)) (f64.const 1000))))`

  // ── Setter helpers ────────────────────────────────────────────────────────

  ctx.core.stdlib['__date_set_time'] = `(func $__date_set_time (param $ptr i32) (param $day f64) (param $time f64) (result f64)
    (local $v f64)
    (local.set $v (call $__date_time_clip (f64.add (f64.mul (local.get $day) (f64.const ${MS_PER_DAY})) (local.get $time))))
    (f64.store (local.get $ptr) (local.get $v))
    (local.get $v))`

  ctx.core.stdlib['__date_set_utc_date'] = `(func $__date_set_utc_date (param $ptr i32) (param $t f64) (param $dt f64) (result f64)
    (call $__date_set_time (local.get $ptr)
      (call $__date_make_day (call $__date_year_from_time (local.get $t)) (call $__date_month_from_time (local.get $t)) (local.get $dt))
      (call $__date_time_within_day (local.get $t))))`

  ctx.core.stdlib['__date_set_utc_month'] = `(func $__date_set_utc_month (param $ptr i32) (param $t f64) (param $m f64) (param $dt f64) (result f64)
    (call $__date_set_time (local.get $ptr)
      (call $__date_make_day (call $__date_year_from_time (local.get $t)) (local.get $m) (local.get $dt))
      (call $__date_time_within_day (local.get $t))))`

  ctx.core.stdlib['__date_set_utc_full_year'] = `(func $__date_set_utc_full_year (param $ptr i32) (param $t f64) (param $y f64) (param $m f64) (param $dt f64) (result f64)
    (if (f64.ne (local.get $t) (local.get $t))
      (then (local.set $t (f64.const 0))))
    (call $__date_set_time (local.get $ptr)
      (call $__date_make_day (local.get $y) (local.get $m) (local.get $dt))
      (call $__date_time_within_day (local.get $t))))`

  ctx.core.stdlib['__date_set_utc_hours'] = `(func $__date_set_utc_hours (param $ptr i32) (param $t f64) (param $h f64) (param $m f64) (param $s f64) (param $ms f64) (result f64)
    (call $__date_set_time (local.get $ptr)
      (call $__date_day (local.get $t))
      (call $__date_make_time (local.get $h) (local.get $m) (local.get $s) (local.get $ms))))`

  ctx.core.stdlib['__date_set_utc_minutes'] = `(func $__date_set_utc_minutes (param $ptr i32) (param $t f64) (param $m f64) (param $s f64) (param $ms f64) (result f64)
    (call $__date_set_time (local.get $ptr)
      (call $__date_day (local.get $t))
      (call $__date_make_time (call $__date_hour_from_time (local.get $t)) (local.get $m) (local.get $s) (local.get $ms))))`

  ctx.core.stdlib['__date_set_utc_seconds'] = `(func $__date_set_utc_seconds (param $ptr i32) (param $t f64) (param $s f64) (param $ms f64) (result f64)
    (call $__date_set_time (local.get $ptr)
      (call $__date_day (local.get $t))
      (call $__date_make_time (call $__date_hour_from_time (local.get $t)) (call $__date_min_from_time (local.get $t)) (local.get $s) (local.get $ms))))`

  ctx.core.stdlib['__date_set_utc_milliseconds'] = `(func $__date_set_utc_milliseconds (param $ptr i32) (param $t f64) (param $ms f64) (result f64)
    (call $__date_set_time (local.get $ptr)
      (call $__date_day (local.get $t))
      (call $__date_make_time (call $__date_hour_from_time (local.get $t)) (call $__date_min_from_time (local.get $t)) (call $__date_sec_from_time (local.get $t)) (local.get $ms))))`

  // ── Digit formatters ──────────────────────────────────────────────────────

  ctx.core.stdlib['__date_write2'] = `(func $__date_write2 (param $buf i32) (param $v i32)
    (i32.store8 (local.get $buf) (i32.add (i32.const 48) (i32.div_u (local.get $v) (i32.const 10))))
    (i32.store8 (i32.add (local.get $buf) (i32.const 1)) (i32.add (i32.const 48) (i32.rem_u (local.get $v) (i32.const 10)))))`

  ctx.core.stdlib['__date_write3'] = `(func $__date_write3 (param $buf i32) (param $v i32)
    (local $d i32)
    (local.set $d (i32.div_u (local.get $v) (i32.const 100)))
    (i32.store8 (local.get $buf) (i32.add (i32.const 48) (local.get $d)))
    (local.set $v (i32.rem_u (local.get $v) (i32.const 100)))
    (local.set $d (i32.div_u (local.get $v) (i32.const 10)))
    (i32.store8 (i32.add (local.get $buf) (i32.const 1)) (i32.add (i32.const 48) (local.get $d)))
    (i32.store8 (i32.add (local.get $buf) (i32.const 2)) (i32.add (i32.const 48) (i32.rem_u (local.get $v) (i32.const 10)))))`

  ctx.core.stdlib['__date_write4'] = `(func $__date_write4 (param $buf i32) (param $v i32)
    (local $d i32)
    (local.set $d (i32.div_u (local.get $v) (i32.const 1000)))
    (i32.store8 (local.get $buf) (i32.add (i32.const 48) (local.get $d)))
    (local.set $v (i32.rem_u (local.get $v) (i32.const 1000)))
    (local.set $d (i32.div_u (local.get $v) (i32.const 100)))
    (i32.store8 (i32.add (local.get $buf) (i32.const 1)) (i32.add (i32.const 48) (local.get $d)))
    (local.set $v (i32.rem_u (local.get $v) (i32.const 100)))
    (local.set $d (i32.div_u (local.get $v) (i32.const 10)))
    (i32.store8 (i32.add (local.get $buf) (i32.const 2)) (i32.add (i32.const 48) (local.get $d)))
    (i32.store8 (i32.add (local.get $buf) (i32.const 3)) (i32.add (i32.const 48) (i32.rem_u (local.get $v) (i32.const 10)))))`

  // ── toISOString ───────────────────────────────────────────────────────────

  ctx.core.stdlib['__date_to_iso_string'] = `(func $__date_to_iso_string (param $t f64) (result f64)
    (local $buf i32) (local $p i32) (local $year f64) (local $yv i32) (local $nd i32)
    (if (f64.ne (local.get $t) (local.get $t)) (then (return (call $__mkstr (i32.const 0) (i32.const 0)))))
    (local.set $buf (call $__alloc (i32.const 40)))
    (local.set $p (local.get $buf))
    (local.set $year (call $__date_year_from_time (local.get $t)))
    (if (f64.lt (local.get $year) (f64.const 0))
      (then
        (i32.store8 (local.get $p) (i32.const 45))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (local.set $year (f64.neg (local.get $year)))))
    (local.set $yv (i32.trunc_sat_f64_u (local.get $year)))
    (if (i32.le_u (local.get $yv) (i32.const 9999))
      (then
        (call $__date_write4 (local.get $p) (local.get $yv))
        (local.set $p (i32.add (local.get $p) (i32.const 4))))
      (else
        (local.set $nd (call $__itoa (local.get $yv) (local.get $p)))
        (local.set $p (i32.add (local.get $p) (local.get $nd)))))
    (i32.store8 (local.get $p) (i32.const 45))
    (local.set $p (i32.add (local.get $p) (i32.const 1)))
    (call $__date_write2 (local.get $p) (i32.add (i32.trunc_sat_f64_s (call $__date_month_from_time (local.get $t))) (i32.const 1)))
    (local.set $p (i32.add (local.get $p) (i32.const 2)))
    (i32.store8 (local.get $p) (i32.const 45))
    (local.set $p (i32.add (local.get $p) (i32.const 1)))
    (call $__date_write2 (local.get $p) (i32.trunc_sat_f64_s (call $__date_date_from_time (local.get $t))))
    (local.set $p (i32.add (local.get $p) (i32.const 2)))
    (i32.store8 (local.get $p) (i32.const 84))
    (local.set $p (i32.add (local.get $p) (i32.const 1)))
    (call $__date_write2 (local.get $p) (i32.trunc_sat_f64_s (call $__date_hour_from_time (local.get $t))))
    (local.set $p (i32.add (local.get $p) (i32.const 2)))
    (i32.store8 (local.get $p) (i32.const 58))
    (local.set $p (i32.add (local.get $p) (i32.const 1)))
    (call $__date_write2 (local.get $p) (i32.trunc_sat_f64_s (call $__date_min_from_time (local.get $t))))
    (local.set $p (i32.add (local.get $p) (i32.const 2)))
    (i32.store8 (local.get $p) (i32.const 58))
    (local.set $p (i32.add (local.get $p) (i32.const 1)))
    (call $__date_write2 (local.get $p) (i32.trunc_sat_f64_s (call $__date_sec_from_time (local.get $t))))
    (local.set $p (i32.add (local.get $p) (i32.const 2)))
    (i32.store8 (local.get $p) (i32.const 46))
    (local.set $p (i32.add (local.get $p) (i32.const 1)))
    (call $__date_write3 (local.get $p) (i32.trunc_sat_f64_s (call $__date_ms_from_time (local.get $t))))
    (local.set $p (i32.add (local.get $p) (i32.const 3)))
    (i32.store8 (local.get $p) (i32.const 90))
    (local.set $p (i32.add (local.get $p) (i32.const 1)))
    (call $__mkstr (local.get $buf) (i32.sub (local.get $p) (local.get $buf))))`

  // ── toUTCString ───────────────────────────────────────────────────────────

  ctx.core.stdlib['__date_to_utc_string'] = `(func $__date_to_utc_string (param $t f64) (result f64)
    (local $buf i32) (local $p i32) (local $wd i32) (local $year f64) (local $yv i32) (local $nd i32) (local $month i32)
    (if (f64.ne (local.get $t) (local.get $t)) (then (return (call $__mkstr (i32.const 0) (i32.const 0)))))
    (local.set $buf (call $__alloc (i32.const 48)))
    (local.set $p (local.get $buf))
    (local.set $wd (i32.trunc_sat_f64_s (call $__date_weekday (local.get $t))))
    (if (i32.eq (local.get $wd) (i32.const 0))
      (then
        (i32.store8 (local.get $p) (i32.const 83))
        (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 117))
        (i32.store8 (i32.add (local.get $p) (i32.const 2)) (i32.const 110))))
    (if (i32.eq (local.get $wd) (i32.const 1))
      (then
        (i32.store8 (local.get $p) (i32.const 77))
        (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 111))
        (i32.store8 (i32.add (local.get $p) (i32.const 2)) (i32.const 110))))
    (if (i32.eq (local.get $wd) (i32.const 2))
      (then
        (i32.store8 (local.get $p) (i32.const 84))
        (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 117))
        (i32.store8 (i32.add (local.get $p) (i32.const 2)) (i32.const 101))))
    (if (i32.eq (local.get $wd) (i32.const 3))
      (then
        (i32.store8 (local.get $p) (i32.const 87))
        (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 101))
        (i32.store8 (i32.add (local.get $p) (i32.const 2)) (i32.const 100))))
    (if (i32.eq (local.get $wd) (i32.const 4))
      (then
        (i32.store8 (local.get $p) (i32.const 84))
        (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 104))
        (i32.store8 (i32.add (local.get $p) (i32.const 2)) (i32.const 117))))
    (if (i32.eq (local.get $wd) (i32.const 5))
      (then
        (i32.store8 (local.get $p) (i32.const 70))
        (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 114))
        (i32.store8 (i32.add (local.get $p) (i32.const 2)) (i32.const 105))))
    (if (i32.eq (local.get $wd) (i32.const 6))
      (then
        (i32.store8 (local.get $p) (i32.const 83))
        (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 97))
        (i32.store8 (i32.add (local.get $p) (i32.const 2)) (i32.const 116))))
    (local.set $p (i32.add (local.get $p) (i32.const 3)))
    (i32.store8 (local.get $p) (i32.const 44))
    (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 32))
    (local.set $p (i32.add (local.get $p) (i32.const 2)))
    (call $__date_write2 (local.get $p) (i32.trunc_sat_f64_s (call $__date_date_from_time (local.get $t))))
    (local.set $p (i32.add (local.get $p) (i32.const 2)))
    (i32.store8 (local.get $p) (i32.const 32))
    (local.set $p (i32.add (local.get $p) (i32.const 1)))
    (local.set $month (i32.trunc_sat_f64_s (call $__date_month_from_time (local.get $t))))
    (if (i32.eq (local.get $month) (i32.const 0))
      (then
        (i32.store8 (local.get $p) (i32.const 74))
        (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 97))
        (i32.store8 (i32.add (local.get $p) (i32.const 2)) (i32.const 110))))
    (if (i32.eq (local.get $month) (i32.const 1))
      (then
        (i32.store8 (local.get $p) (i32.const 70))
        (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 101))
        (i32.store8 (i32.add (local.get $p) (i32.const 2)) (i32.const 98))))
    (if (i32.eq (local.get $month) (i32.const 2))
      (then
        (i32.store8 (local.get $p) (i32.const 77))
        (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 97))
        (i32.store8 (i32.add (local.get $p) (i32.const 2)) (i32.const 114))))
    (if (i32.eq (local.get $month) (i32.const 3))
      (then
        (i32.store8 (local.get $p) (i32.const 65))
        (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 112))
        (i32.store8 (i32.add (local.get $p) (i32.const 2)) (i32.const 114))))
    (if (i32.eq (local.get $month) (i32.const 4))
      (then
        (i32.store8 (local.get $p) (i32.const 77))
        (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 97))
        (i32.store8 (i32.add (local.get $p) (i32.const 2)) (i32.const 121))))
    (if (i32.eq (local.get $month) (i32.const 5))
      (then
        (i32.store8 (local.get $p) (i32.const 74))
        (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 117))
        (i32.store8 (i32.add (local.get $p) (i32.const 2)) (i32.const 110))))
    (if (i32.eq (local.get $month) (i32.const 6))
      (then
        (i32.store8 (local.get $p) (i32.const 74))
        (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 117))
        (i32.store8 (i32.add (local.get $p) (i32.const 2)) (i32.const 108))))
    (if (i32.eq (local.get $month) (i32.const 7))
      (then
        (i32.store8 (local.get $p) (i32.const 65))
        (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 117))
        (i32.store8 (i32.add (local.get $p) (i32.const 2)) (i32.const 103))))
    (if (i32.eq (local.get $month) (i32.const 8))
      (then
        (i32.store8 (local.get $p) (i32.const 83))
        (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 101))
        (i32.store8 (i32.add (local.get $p) (i32.const 2)) (i32.const 112))))
    (if (i32.eq (local.get $month) (i32.const 9))
      (then
        (i32.store8 (local.get $p) (i32.const 79))
        (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 99))
        (i32.store8 (i32.add (local.get $p) (i32.const 2)) (i32.const 116))))
    (if (i32.eq (local.get $month) (i32.const 10))
      (then
        (i32.store8 (local.get $p) (i32.const 78))
        (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 111))
        (i32.store8 (i32.add (local.get $p) (i32.const 2)) (i32.const 118))))
    (if (i32.eq (local.get $month) (i32.const 11))
      (then
        (i32.store8 (local.get $p) (i32.const 68))
        (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 101))
        (i32.store8 (i32.add (local.get $p) (i32.const 2)) (i32.const 99))))
    (local.set $p (i32.add (local.get $p) (i32.const 3)))
    (i32.store8 (local.get $p) (i32.const 32))
    (local.set $p (i32.add (local.get $p) (i32.const 1)))
    (local.set $year (call $__date_year_from_time (local.get $t)))
    (if (f64.lt (local.get $year) (f64.const 0))
      (then
        (i32.store8 (local.get $p) (i32.const 45))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (local.set $year (f64.neg (local.get $year)))))
    (local.set $yv (i32.trunc_sat_f64_u (local.get $year)))
    (if (i32.le_u (local.get $yv) (i32.const 9999))
      (then
        (call $__date_write4 (local.get $p) (local.get $yv))
        (local.set $p (i32.add (local.get $p) (i32.const 4))))
      (else
        (local.set $nd (call $__itoa (local.get $yv) (local.get $p)))
        (local.set $p (i32.add (local.get $p) (local.get $nd)))))
    (i32.store8 (local.get $p) (i32.const 32))
    (local.set $p (i32.add (local.get $p) (i32.const 1)))
    (call $__date_write2 (local.get $p) (i32.trunc_sat_f64_s (call $__date_hour_from_time (local.get $t))))
    (local.set $p (i32.add (local.get $p) (i32.const 2)))
    (i32.store8 (local.get $p) (i32.const 58))
    (local.set $p (i32.add (local.get $p) (i32.const 1)))
    (call $__date_write2 (local.get $p) (i32.trunc_sat_f64_s (call $__date_min_from_time (local.get $t))))
    (local.set $p (i32.add (local.get $p) (i32.const 2)))
    (i32.store8 (local.get $p) (i32.const 58))
    (local.set $p (i32.add (local.get $p) (i32.const 1)))
    (call $__date_write2 (local.get $p) (i32.trunc_sat_f64_s (call $__date_sec_from_time (local.get $t))))
    (local.set $p (i32.add (local.get $p) (i32.const 2)))
    (i32.store8 (local.get $p) (i32.const 32))
    (i32.store8 (i32.add (local.get $p) (i32.const 1)) (i32.const 71))
    (i32.store8 (i32.add (local.get $p) (i32.const 2)) (i32.const 77))
    (i32.store8 (i32.add (local.get $p) (i32.const 3)) (i32.const 84))
    (local.set $p (i32.add (local.get $p) (i32.const 4)))
    (call $__mkstr (local.get $buf) (i32.sub (local.get $p) (local.get $buf))))`

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

  // ── UTC getter emit handlers ──────────────────────────────────────────────

  const emitDateLoad = (dateExpr) =>
    typed(['f64.load', ['i32.wrap_i64', ['i64.reinterpret_f64', asF64(emit(dateExpr))]]], 'f64')

  const dateGetter = (fn) => (dateExpr) => {
    inc(fn)
    return typed(['call', `$${fn}`, emitDateLoad(dateExpr)], 'f64')
  }

  ctx.core.emit['.getUTCFullYear'] = dateGetter('__date_year_from_time')
  ctx.core.emit[`.${VAL.DATE}:getUTCFullYear`] = dateGetter('__date_year_from_time')

  ctx.core.emit['.getUTCMonth'] = dateGetter('__date_month_from_time')
  ctx.core.emit[`.${VAL.DATE}:getUTCMonth`] = dateGetter('__date_month_from_time')

  ctx.core.emit['.getUTCDate'] = dateGetter('__date_date_from_time')
  ctx.core.emit[`.${VAL.DATE}:getUTCDate`] = dateGetter('__date_date_from_time')

  ctx.core.emit['.getUTCDay'] = dateGetter('__date_weekday')
  ctx.core.emit[`.${VAL.DATE}:getUTCDay`] = dateGetter('__date_weekday')

  ctx.core.emit['.getUTCHours'] = dateGetter('__date_hour_from_time')
  ctx.core.emit[`.${VAL.DATE}:getUTCHours`] = dateGetter('__date_hour_from_time')

  ctx.core.emit['.getUTCMinutes'] = dateGetter('__date_min_from_time')
  ctx.core.emit[`.${VAL.DATE}:getUTCMinutes`] = dateGetter('__date_min_from_time')

  ctx.core.emit['.getUTCSeconds'] = dateGetter('__date_sec_from_time')
  ctx.core.emit[`.${VAL.DATE}:getUTCSeconds`] = dateGetter('__date_sec_from_time')

  ctx.core.emit['.getUTCMilliseconds'] = dateGetter('__date_ms_from_time')
  ctx.core.emit[`.${VAL.DATE}:getUTCMilliseconds`] = dateGetter('__date_ms_from_time')

  // ── UTC setter emit handlers ──────────────────────────────────────────────

  const emitDatePtr = (dateExpr) =>
    ['i32.wrap_i64', ['i64.reinterpret_f64', asF64(emit(dateExpr))]]

  ctx.core.emit['.setUTCDate'] = (dateExpr, dt) => {
    inc('__date_set_utc_date')
    return typed(['call', '$__date_set_utc_date', emitDatePtr(dateExpr), emitDateLoad(dateExpr), asF64(toNumF64(dt, emit(dt)))], 'f64')
  }
  ctx.core.emit[`.${VAL.DATE}:setUTCDate`] = ctx.core.emit['.setUTCDate']

  ctx.core.emit['.setUTCMonth'] = (dateExpr, month, dt) => {
    inc('__date_set_utc_month')
    const m = asF64(toNumF64(month, emit(month)))
    const t = emitDateLoad(dateExpr)
    const d = missingArg(dt)
      ? (inc('__date_date_from_time'), typed(['call', '$__date_date_from_time', t], 'f64'))
      : asF64(toNumF64(dt, emit(dt)))
    return typed(['call', '$__date_set_utc_month', emitDatePtr(dateExpr), t, m, d], 'f64')
  }
  ctx.core.emit[`.${VAL.DATE}:setUTCMonth`] = ctx.core.emit['.setUTCMonth']

  ctx.core.emit['.setUTCFullYear'] = (dateExpr, year, month, dt) => {
    inc('__date_set_utc_full_year')
    const y = asF64(toNumF64(year, emit(year)))
    const t = emitDateLoad(dateExpr)
    const m = missingArg(month)
      ? (inc('__date_month_from_time'), typed(['if', ['result', 'f64'],
          ['f64.ne', t, t],
          ['then', ['f64.const', 0]],
          ['else', ['call', '$__date_month_from_time', t]]], 'f64'))
      : asF64(toNumF64(month, emit(month)))
    const d = missingArg(dt)
      ? (inc('__date_date_from_time'), typed(['if', ['result', 'f64'],
          ['f64.ne', t, t],
          ['then', ['f64.const', 1]],
          ['else', ['call', '$__date_date_from_time', t]]], 'f64'))
      : asF64(toNumF64(dt, emit(dt)))
    return typed(['call', '$__date_set_utc_full_year', emitDatePtr(dateExpr), t, y, m, d], 'f64')
  }
  ctx.core.emit[`.${VAL.DATE}:setUTCFullYear`] = ctx.core.emit['.setUTCFullYear']

  ctx.core.emit['.setUTCHours'] = (dateExpr, hour, min, sec, ms) => {
    inc('__date_set_utc_hours')
    const h = asF64(toNumF64(hour, emit(hour)))
    const t = emitDateLoad(dateExpr)
    const m = missingArg(min)
      ? (inc('__date_min_from_time'), typed(['call', '$__date_min_from_time', t], 'f64'))
      : asF64(toNumF64(min, emit(min)))
    const s = missingArg(sec)
      ? (inc('__date_sec_from_time'), typed(['call', '$__date_sec_from_time', t], 'f64'))
      : asF64(toNumF64(sec, emit(sec)))
    const msec = missingArg(ms)
      ? (inc('__date_ms_from_time'), typed(['call', '$__date_ms_from_time', t], 'f64'))
      : asF64(toNumF64(ms, emit(ms)))
    return typed(['call', '$__date_set_utc_hours', emitDatePtr(dateExpr), t, h, m, s, msec], 'f64')
  }
  ctx.core.emit[`.${VAL.DATE}:setUTCHours`] = ctx.core.emit['.setUTCHours']

  ctx.core.emit['.setUTCMinutes'] = (dateExpr, min, sec, ms) => {
    inc('__date_set_utc_minutes')
    const m = asF64(toNumF64(min, emit(min)))
    const t = emitDateLoad(dateExpr)
    const s = missingArg(sec)
      ? (inc('__date_sec_from_time'), typed(['call', '$__date_sec_from_time', t], 'f64'))
      : asF64(toNumF64(sec, emit(sec)))
    const msec = missingArg(ms)
      ? (inc('__date_ms_from_time'), typed(['call', '$__date_ms_from_time', t], 'f64'))
      : asF64(toNumF64(ms, emit(ms)))
    return typed(['call', '$__date_set_utc_minutes', emitDatePtr(dateExpr), t, m, s, msec], 'f64')
  }
  ctx.core.emit[`.${VAL.DATE}:setUTCMinutes`] = ctx.core.emit['.setUTCMinutes']

  ctx.core.emit['.setUTCSeconds'] = (dateExpr, sec, ms) => {
    inc('__date_set_utc_seconds')
    const s = asF64(toNumF64(sec, emit(sec)))
    const t = emitDateLoad(dateExpr)
    const msec = missingArg(ms)
      ? (inc('__date_ms_from_time'), typed(['call', '$__date_ms_from_time', t], 'f64'))
      : asF64(toNumF64(ms, emit(ms)))
    return typed(['call', '$__date_set_utc_seconds', emitDatePtr(dateExpr), t, s, msec], 'f64')
  }
  ctx.core.emit[`.${VAL.DATE}:setUTCSeconds`] = ctx.core.emit['.setUTCSeconds']

  ctx.core.emit['.setUTCMilliseconds'] = (dateExpr, ms) => {
    inc('__date_set_utc_milliseconds')
    return typed(['call', '$__date_set_utc_milliseconds', emitDatePtr(dateExpr), emitDateLoad(dateExpr), asF64(toNumF64(ms, emit(ms)))], 'f64')
  }
  ctx.core.emit[`.${VAL.DATE}:setUTCMilliseconds`] = ctx.core.emit['.setUTCMilliseconds']

  // ── Stringification ───────────────────────────────────────────────────────

  ctx.core.emit['.toISOString'] = (dateExpr) => {
    inc('__date_to_iso_string')
    return typed(['call', '$__date_to_iso_string', emitDateLoad(dateExpr)], 'f64')
  }
  ctx.core.emit[`.${VAL.DATE}:toISOString`] = ctx.core.emit['.toISOString']

  ctx.core.emit['.toUTCString'] = (dateExpr) => {
    inc('__date_to_utc_string')
    return typed(['call', '$__date_to_utc_string', emitDateLoad(dateExpr)], 'f64')
  }
  ctx.core.emit[`.${VAL.DATE}:toUTCString`] = ctx.core.emit['.toUTCString']
}
