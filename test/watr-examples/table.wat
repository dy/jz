(module
  (table $x 2 funcref)
  (table $y 2 funcref)
  (elem (table $y) (i32.const 0) funcref $f1 $f2)

  ;; w is this?
  (elem funcref (ref.func 1) (ref.null func))
  (elem declare func 0)

  (type $return_i32 (func (result i32)))
  (func $f1 (result i32) (i32.const 42))
  (func $f2 (result i32) (i32.const 13))

  ;; initializing type after creates duplicate - watr limitation, since we don't init types upfront
  ;; (type $return_i32 (func (result i32)))

  (func (export "c") (param $i i32) (result i32)
    (call_indirect $y (type $return_i32) (local.get $i))
  )

  (func (export "g") (param $i i32) (result funcref)
    (return (ref.func $f2)) ;; return direct function
    ;; return from table
    ;; (table.get $y (local.get $i))
  )
)
