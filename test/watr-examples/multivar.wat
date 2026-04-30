;; test passing array to and back
(module
  (import "console" "log" (func $log (param i32 f32)))
  (import "js" "mem" (memory 1))

  (global $blockSize (import "js" "blockSize") (mut i32))
  (global $len (mut i32) (i32.const 0))
  ;; len = blockSize * 4
  (func (global.set $len (i32.mul (global.get $blockSize) (i32.const 4))))
  (start 1)

  ;; NOTE: see array.wat
)
