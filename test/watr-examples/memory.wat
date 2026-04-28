(module
  (import "js" "log" (func $log (param i32)))

  ;; reexport memory
  ;; note: it requires import.
  (import "js" "mem" (memory 2))
  ;; (export "mem" (memory $mem))

  ;; (memory $mem (import "js" "mem") (export "mem") 1) ;; create memory with 1 page - per module

  ;; (import "js" "g" (global $g f32))
  ;; (export "g" (global $g))

  ;; (global (export "g") (mut f32) (f32.const 1.5))
  ;; (memory $xxx 1) ;; create memory with 1 page - per module

  (func $populate (export "populate")
    (i32.store (i32.const 0) (i32.const 123))
    (i32.store (i32.const 10) (i32.const 1230))
  )

  (func $get (export "get") (param i32) (result i32)
    (i32.load (local.get 0))
  )

  (func $set (export "set") (param i32) (param i32)
    (i32.store (local.get 0) (local.get 1))
  )
)
