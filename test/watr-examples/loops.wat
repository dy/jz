(module
  ;; import the browser console object, you'll need to pass this in from JavaScript
  (import "console" "log" (func $log (param i32)))

  ;; the difference between block and loop is: you cannot goto beginning of block again
  ;; block defines scope for variables, loop adds goto label

  (func
    ;; (loop xxx)
    ;; identical to
    ;; loop ... end

    ;; create a global variable and initialize it to 0
    (local $i i32)

    (loop $my_loop

      ;; add one to $i
      (local.set $i (i32.add (local.get $i) (i32.const 1)))

      ;; log the current value of $i
      (call $log (local.get $i))

      ;; if $i is less than 10 branch to loop
      (br_if $my_loop (i32.lt_s (local.get $i) (i32.const 10)))
    )
  )

  (start 1) ;; run the first function automatically
)
