(module
  (import "js" "log" (func $log (param i32)))

  ;; (import "js" "g1" (global $g1 (mut i32)))  ;; identical to line below
  (global $g1 (import "js" "g1") (mut i32))  ;; import from js
  ;; (global $g1 (import "js" "g1") i32)  ;; immutable import

  ;; (global $g0 i32 (i32.const 1)) ;; local global immutable (not imported)
  (global $g0 (mut i32) (i32.const 1)) ;; local global mutable, initialized

  ;; ? is that mandatory to initialize that?
  ;; yep, initializer is needed, same time we cannot push to stack in global scope, so we use lispy style

  ;; ? is there a short way to initialize?
  ;; − this is short way, reminds lispy syntax (operator a b)

  (func (export "getG0") (result i32)
    (global.get $g0)
  )

  (func $getG1 (export "getG1") (result i32)
    (global.get $g1)
  )
  (func $setG1 (export "setG1") (param i32)
    (global.set $g1 (local.get 0))
  )
)
