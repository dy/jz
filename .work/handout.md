# jz Session Handout — Watr WASM Execution

## Status
- **8/8 WAT**, **7/8 WASM binary**, **1/8 valid WASM** (const.js), **704 jz tests pass**
- All watr source files compile to WAT and 7 produce WASM binaries
- const.js validates and instantiates; 6 others fail WASM validation (type errors)
- compile.js WAT compiles but WASM binary fails on a `for...of` + destructuring + multi-value edge case

## What Was Done (across 3 sessions)

### Restructure (Phase 0-13)
Unified ABI sentinels, centralized schema, canonicalized heap layout (`__alloc_hdr`), consolidated hash table (genProbe templates), unified property dispatch (`emitLengthAccess`/`__length` stdlib), for...in on HASH, remaining methods (.at, Object.fromEntries/create), boxed method delegation.

### Watr Compilation (~40 fixes)
- **Parser/ASI**: moved `}` ASI to subscript (`parse.js:54`), 1-line `}\n[` regex remains in jz
- **jzify**: function body `{}` wrapping, export default function splitting, import-before-hoist
- **prepare.js**: IIFE detection, object/array destructuring (let/const/for-of/assignment/params), `for (const [...] of ...)`, `in` operator, `?.()` optional call, `Boolean`/`Number` as value identity, `parseFloat`/`Boolean` module loading, `throw`/`try`/`catch` in block body detection, `++`/`--` on `.prop`/`[idx]`
- **compile.js**: `flat()` fix (string opcode check), `';'` flattening, `emitFlat`/`isBlockBody` with shared `STMT_OPS`, bare `return`, `block` handler WASM IR passthrough, `if`/`for` body routing, comma void fix, `??=`/`||=`/`&&=` complex LHS, multi-value return spread exclusion, BigInt i64 range wrapping, `extractParams`/`collectParamNames` shared utilities, nested closure capture (recurse through `=>`), auto-box scan across function bodies, `boxedAddr` helper for f64 cell pointers, WASM IR passthrough (`/^[a-z]/`)
- **Cross-module**: mangled name resolution, function body rename walk (all module funcs + closures), non-exported function renaming, `savedFuncCount` tracking, `const` scope shadowing
- **typedarray.js**: `ArrayBuffer`/`DataView`/`BigInt64Array` as f64 pointers, set/get methods, `.buffer` property, `Uint8Array(buf, off, len)` view constructor
- **watr**: `Array.prototype.valueOf` → `._s` marker (watr 531 tests pass)

## Some more cleanup and reorganization

P0-1: Delete dead .some emitter (trivial)
P0-2: Add br early exit to .some/.every/.findIndex/.find
P0-3: Replace Math.random() with deterministic counter in jzify.js
P0-4: Sync STMT_OPS with emitBody inline list; add missing compound ops
P1-8: Replace emitStringLiteral in object.js with ctx.emit['str']
P1-5: Parameterize __str_upper/__str_lower into single __str_case
P2-12: Refactor auto-import chains into declarative map
P2-14: Extend compoundAssign to handle bitwise ops

## Remaining: 6 WASM Validation Errors

All 6 failing files have the same two root causes:

### 1. Boxed Capture Type Mismatch
**Root cause**: Boxed captures in closures store cell pointers. In outer functions, cell locals are `i32`. In closures, captures are now `f64` (to avoid type conflicts with other paths). The `boxedAddr()` helper converts f64→i32 with `i32.trunc_f64_u`, but some code paths still emit raw `local.get $cell` (f64) where i32 is expected.

**Where to look**:
- `compile.js` `boxedAddr()` (~line 1108) — helper exists, needs consistent use
- Anywhere `ctx.boxed.get(name)` is used to construct addresses
- `.push` writeback in `array.js:234` — already fixed
- `emitDecl` boxed init at `compile.js:267` — uses i32 cell, correct for outer functions
- Closure compilation at `compile.js:893-917` — captures now f64, but body analysis may override

**Specific error**: `local.set[0] expected type i32, found X of type f64` or `not enough arguments on stack for f64.convert_i32_s`

**Fix approach**: Search generated WAT for all `local.set $X` where `$X` is i32 and value is f64. Each points to a boxed variable write that doesn't use `boxedAddr()`. Also check `f64.load`/`f64.store` with f64 addresses (need i32).

### 2. Uint8Array(array) Constructor
**Root cause**: `new Uint8Array(regularArray)` is compiled as `new.Uint8Array(lenExpr)` which treats the arg as a numeric length. It should use `Uint8Array.from(arr)` conversion.

**Where**: `typedarray.js:230` has a partial fix (checks `ctx.valTypes?.get(lenExpr) === 'array'`), but fails when the source isn't a known array variable (e.g., function return value).

**Fix**: In `new.Uint8Array`, if the single arg isn't obviously numeric (not a literal number, not from `.length`), try `from()` path. Or: at prepare time, detect `new Uint8Array(arr)` where `arr` is non-numeric and rewrite to `Uint8Array.from(arr)`.

**Affected**: util.js (`unescape = s => tdec.decode(new Uint8Array(str(s)))`), encode.js (similar pattern).

### 3. compile.js WASM Binary (7→8)
Separate from validation — `compile.js` fails WAT→WASM with `local.set,$d45,block,result,f64,...` in `$memarg` function. Root cause: multi-value return function + destructuring + `.shift()` creates a `block` inside `local.set` that gets flattened. The `memarg` function has 2 results.

**Fix**: The `';'` handler's `flat()` doesn't handle multi-instruction results from comma expressions nested inside multi-value return destructuring. Needs targeted debugging of `$memarg` function WAT output.

## Key Architecture Notes

### Type System
- Everything is f64 (NaN-boxed). Integers are f64 too.
- i32 locals exist ONLY for: loop counters, cell pointers (boxed), arg array pointers
- The `exprType` and `analyzeLocals` determine local types statically
- In closures, ALL captures should be f64 (cell pointer stored as f64, convert to i32 on use)

### Boxed Variables
- Mutably-captured variables get "boxed": allocated 8-byte cell, i32 pointer
- In outer function: `$cell_x` (i32) = alloc(8), read/write via `f64.load/store($cell_x)`
- In closure: `$x` (f64) = env[offset], read via `f64.load(i32.trunc($x))`, write via `f64.store(i32.trunc($x), val)`
- `boxedAddr(name)` helper at compile.js:1108 does the right thing — USE IT everywhere

### Cross-Module Imports
- `prepareModule()` in prepare.js bundles imported modules into one WASM
- Exported funcs renamed `prefix$name`, non-exported also renamed
- Rename walk processes all function bodies created during module prep
- `savedFuncCount` tracks which funcs belong to which module

### Closure Compilation
- `findFreeVars()` detects captures, now recurses through nested `=>` arrows
- `analyzeBoxedCaptures()` marks mutably-captured vars for boxing
- Closure bodies compiled separately with `ctx.boxed` mapping `name → name` (self-referencing)
- Arg arrays packed as heap arrays, passed via `call_indirect`

## Files Changed
- `~/projects/subscript/parse.js:54` — ASI after `}`
- `~/projects/subscript/feature/asi.js` — unchanged (ASI via newline)
- `~/projects/watr/src/util.js:75` — `._s` marker on byte arrays
- `~/projects/watr/src/compile.js:354` — `._s` check instead of `Array.prototype.valueOf`
- `~/projects/jz/index.js` — removed ASI scanner, 1-line `}\n[` regex
- `~/projects/jz/src/compile.js` — `extractParams`, `collectParamNames`, `boxedAddr`, `flat()`, `findFreeVars`, `emitBody`, `emitFlat`, `isBlockBody`, `STMT_OPS`, comma handler, `??=`/`||=`/`&&=`, `++`/`--`, block handler, WASM passthrough, BigInt, bare return, closure param destructuring, auto-box scan, nested capture
- `~/projects/jz/src/prepare.js` — `extractParams`/`collectParamNames` imports, IIFE detection, destructuring (array/object/param/assignment), `in` operator, `?.()`, `Boolean`/`Number` identity, `throw`/`try`/`catch` in blocks, `for (const [...] of ...)`, cross-module rename walk, `savedFuncCount`
- `~/projects/jz/src/jzify.js` — function body wrapping, export default function, import-before-hoist
- `~/projects/jz/module/typedarray.js` — ArrayBuffer/DataView f64, Uint8Array view constructor
- `~/projects/jz/module/array.js` — .push boxed writeback
- `~/projects/jz/module/schema.js` — extracted from core.js
- `~/projects/jz/module/collection.js` — genProbe templates, `in` operator, for-in emitter
- `~/projects/jz/module/core.js` — `__alloc_hdr`, `__length`, `emitLengthAccess`, `?.()`, `initSchema`
- `~/projects/jz/module/object.js` — Object.fromEntries, Object.create, `__alloc_hdr` usage
- `~/projects/jz/module/math.js` — Math.max/min spread, `emitArrayReduce`
- `~/projects/jz/module/number.js` — `Boolean`, `parseFloat`

## Quick Test Commands
```bash
# jz tests
npm test

# watr compilation check
node --input-type=module -e "
const jz = (await import('./index.js')).default;
const fs = await import('fs');
const modules = {};
for (const f of ['util.js','const.js','encode.js','parse.js','print.js','compile.js','optimize.js','polyfill.js'])
  modules['./' + f] = fs.readFileSync('/Users/div/projects/watr/src/' + f, 'utf8');
for (const f of ['util.js','const.js','encode.js','parse.js','print.js','optimize.js','polyfill.js','compile.js']) {
  try { const w = jz.compile(modules['./' + f], { pure: false, modules }); new WebAssembly.Module(w); console.log('✓', f) }
  catch(e) { console.log('✗', f, '—', e.message.split('\n')[0].slice(0, 50)) }
}
"

# watr tests
cd ~/projects/watr && npm test

# subscript tests
cd ~/projects/subscript && npm test
```
