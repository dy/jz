export const JZWatStdLib = {
  math: {
    "f64.add": "(func $f64.add (param f64 f64) (result f64) (f64.add (local.get 0) (local.get 1)))",
    "f64.sub": "(func $f64.sub (param f64 f64) (result f64) (f64.sub (local.get 0) (local.get 1)))",
    "f64.mul": "(func $f64.mul (param f64 f64) (result f64) (f64.mul (local.get 0) (local.get 1)))",
    "f64.div": "(func $f64.div (param f64 f64) (result f64) (f64.div (local.get 0) (local.get 1)))",
    "f64.rem": "(func $f64.rem (param f64 f64) (result f64) (f64.sub (local.get 0) (f64.mul (f64.floor (f64.div (local.get 0) (local.get 1))) (local.get 1))))",
    
    "f64.eq": "(func $f64.eq (param f64 f64) (result f64) (select (f64.const 1.0) (f64.const 0.0) (f64.eq (local.get 0) (local.get 1))))",
    "f64.ne": "(func $f64.ne (param f64 f64) (result f64) (select (f64.const 1.0) (f64.const 0.0) (f64.ne (local.get 0) (local.get 1))))",
    "f64.lt": "(func $f64.lt (param f64 f64) (result f64) (select (f64.const 1.0) (f64.const 0.0) (f64.lt (local.get 0) (local.get 1))))",
    "f64.le": "(func $f64.le (param f64 f64) (result f64) (select (f64.const 1.0) (f64.const 0.0) (f64.le (local.get 0) (local.get 1))))",
    "f64.gt": "(func $f64.gt (param f64 f64) (result f64) (select (f64.const 1.0) (f64.const 0.0) (f64.gt (local.get 0) (local.get 1))))",
    "f64.ge": "(func $f64.ge (param f64 f64) (result f64) (select (f64.const 1.0) (f64.const 0.0) (f64.ge (local.get 0) (local.get 1))))",
    
    "f64.sqrt": "(func $f64.sqrt (param f64) (result f64) (f64.sqrt (local.get 0)))",
    "f64.abs": "(func $f64.abs (param f64) (result f64) (f64.abs (local.get 0)))",
    "f64.ceil": "(func $f64.ceil (param f64) (result f64) (f64.ceil (local.get 0)))",
    "f64.floor": "(func $f64.floor (param f64) (result f64) (f64.floor (local.get 0)))",
    "f64.trunc": "(func $f64.trunc (param f64) (result f64) (f64.trunc (local.get 0)))",
    "f64.nearest": "(func $f64.nearest (param f64) (result f64) (f64.nearest (local.get 0)))",
    
    "f64.pi": "(global $PI f64 (f64.const 3.141592653589793))",
    "f64.e": "(global $E f64 (f64.const 2.718281828459045))"
  },

  array: {
    "arr.ref": "(func $arr.ref (param i32 i32) (result f64) (f64.reinterpret_i64 (i64.or (i64.extend_i32_u (local.get 0)) (i64.shl (i64.extend_i32_u (local.get 1)) (i64.const 24)))))",
    "arr.addr": "(func $arr.addr (param f64) (result i32) (i32.trunc_f64_u (local.get 0)))",
    "arr.len": "(func $arr.len (param f64) (result i32) (i32.wrap_i64 (i64.shr_u (i64.reinterpret_f64 (local.get 0)) (i64.const 24))))",
    "arr.get": "(func $arr.get (param f64 i32) (result f64) (local $addr i32) (local.set $addr (call $arr.addr (local.get 0))) (f64.load (i32.add (local.get $addr) (i32.mul (local.get 1) (i32.const 8)))))",
    "arr.set": "(func $arr.set (param f64 i32 f64) (result f64) (local $addr i32) (local.set $addr (call $arr.addr (local.get 0))) (f64.store (i32.add (local.get $addr) (i32.mul (local.get 1) (i32.const 8))) (local.get 2)) (local.get 0))"
  }
}

export function generateModuleWithStdLib(mainCode, options = {}) {
  const { memorySize = 1, memoryMax = 10 } = options
  
  let wat = `(module
  (memory ${memorySize} ${memoryMax})
`

  for (const category of Object.values(JZWatStdLib)) {
    for (const code of Object.values(category)) {
      wat += `  ${code}\n`
    }
  }

  wat += `
  (func $main (result f64)
    ${mainCode}
  )
  
  (export "main" (func $main))
  (export "memory" (memory 0))
)`

  return wat
}