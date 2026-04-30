;; Simple "Hello World" - basic WebAssembly exports
(module
  ;; Export a constant
  (global (export "answer") i32 (i32.const 42))

  ;; Add two numbers
  (func (export "add") (param i32 i32) (result i32)
    (i32.add (local.get 0) (local.get 1)))

  ;; Multiply two numbers
  (func (export "mul") (param i32 i32) (result i32)
    (i32.mul (local.get 0) (local.get 1)))

  ;; Factorial using recursion
  (func $factorial (export "factorial") (param $n i32) (result i32)
    (if (result i32) (i32.le_s (local.get $n) (i32.const 1))
      (then (i32.const 1))
      (else
        (i32.mul
          (local.get $n)
          (call $factorial (i32.sub (local.get $n) (i32.const 1)))))))
)
