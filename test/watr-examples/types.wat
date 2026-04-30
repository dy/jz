;; test passing array to and back
(module
  (import "console" "log" (func $log (param i32 f32 externref)))

  ;; NOTE: JS doesn't allow functions with v128 arguments
  ;; (func $run (export "run") (param i32 f32) (param v128) (result i32 f32 v128)
  ;;   (call $log (local.get 0) (local.get 1) (local.get 2))
  ;;   (return (local.get 0) (local.get 1) (local.get 2))
  ;; )

  (func $run (export "run") (param i32 f32) (param externref) (result i32 f32 externref)
    (call $log (local.get 0) (local.get 1) (local.get 2))
    (ref.null extern)
    (return (local.get 0) (local.get 1) (local.get 2))
  )

  (elem func 0)
  (func $f (export "f") (result funcref)
    (return (ref.func 0))
  )
)
