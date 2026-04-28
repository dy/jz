;; test multiple values & stack
(module
  (global $g0 i32 (i32.const 12))

  (func (return (i32.const 0)))

  (func $get (export "get") (result i32 i32)
    ;; note: you cannot push more items to stack than needed for the next op
    ;; global.get $g0

    ;; (return (i32.add (global.get $g0) (global.get $g0)) (global.get $g0))
    ;; in case of returning multiple values js receives an array

    ;; equivalend notation is this
    (i32.add (global.get $g0) (global.get $g0))
    (global.get $g0)
  )

  (func $mul (export "mul") (param i32 i32) (result i32) (i32.mul (local.get 1) (local.get 0)))

  (func $swap (export "swap") (param i32 i32 i32) (param i32) (result i32 i32)
    (local.get 3) (local.get 0)
  )

  ;; (func $fac (param i64) (result i64)
  ;;   (i64.const 1) (local.get 0)
  ;;   (loop $l (param i64 i64) (result i64)
  ;;     (pick 1) (pick 1) (i64.mul)
  ;;     (pick 1) (i64.const 1) (i64.sub)
  ;;     (pick 0) (i64.const 0) (i64.gt_u)
  ;;     (br_if $l)
  ;;     (pick 1) (return)
  ;;   )
  ;; )
)

