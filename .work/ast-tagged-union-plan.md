# AST tagged-union (integer op tags) — migration plan

Green foundation built: src/ops.js (OP string->int, OPS int->string, internOps pass — validated).
Ceiling ~1.5-2.5pp self-host (perf only lands at the final Array-conversion phase).
BLOCKED for now: another agent has active WIP in emit.js/type.js (the migration core files).

Now I have enough to write the complete plan. Let me compose it.

---

## Concrete Plan: Integer-Tagged AST Op Representation

### Preamble — What the profiler actually says about this change

From `.work/selfhost-perf-groundtruth.md:57-62`, the hash/string budget is: `__str_hash` 5.7%, `__str_eq` 8.9%, `__dyn_get_t_h` 3.2%, `__ihash_get_local` 4.0%. Op-dispatch is one user of that budget, not the only one — `ctx.func.locals` (Map), `ctx.func.localReps` (Map), `ctx.schema`, string interning (FNV-1a loop at `compile/index.js:149`), and runtime string operations all pull from the same pool. Integer-tagging AST ops eliminates hash lookups specifically at `ctx.core.emit[op]` (emit.js:3560, :3518), `VT[op]` (kind.js:361), `handlers[op]` (prepare/index.js:839), and `OP_MODULES[op]` (autoload.js:150). Realistic upper bound on the saving is 1.5–2.5 pp of total self-host time. The groundtruth doc explicitly calls `i32-tag AST ops` a structural-level ratio-mover (line 241), meaning it reduces the NaN-box/string-map tax rather than a micro-optimization — that framing is correct, but the ceiling is modest because this only fixes the dispatch-key path, not the rest of the string machinery.

---

### 1. OP Enum Module Shape

**File:** `src/op.js` (new, ~130 lines)

The enum must be:
- A null-proto plain object (not a Map) — consistent with TYPEOF at `ast.js:28` which does the same pattern; null-proto prevents `constructor`/`toString` leakage under self-host.
- Integer values, dense, starting at 1 (NOT 0 — see null-op trap below).
- Frozen (`Object.freeze`) — prevents runtime mutation, lets jz's type inference treat it as a schema-fixed OBJECT with static slot types, which means `OP.ADD` field reads can be integer-constant-folded by the self-host kernel.
- Bidirectional: a reverse map `OP_NAME[int] = string` for error messages and the `typeof op === 'string'` WASM-passthrough guard.
- Trait bitmasks: worth adding as a second parallel constant object rather than embedding in the int value itself. Encoding traits in the tag integer (e.g., high bits = flags) tempts the self-host kernel to do bitwise ops on the tag value, which creates dependence between the integer value and its bit representation and makes renumbering hazardous.

```
// src/op.js  — canonical AST op integer constants
// null-proto prevents prototype member collision under arbitrary user strings.
// Frozen: self-host kernel can treat field access as static-slot reads.

export const OP = Object.freeze(Object.assign(Object.create(null), {
  // ── Literals / self-describing ──────────────────────────────────────
  LIT:        0,   // [null, value] — the null-op primitive sentinel; 0 chosen deliberately
                   // so `op == null` ↔ `op === OP.LIT` ↔ `!op` all converge after migration
  NAN:        1,   // ['nan']
  BOOL:       2,   // ['bool', 1|0]
  STR:        3,   // ['str', s]
  STRCAT:     4,   // ['strcat', ...]
  BIGINT:     5,   // ['bigint', s]
  ARRAY:      6,   // ['[', e0, e1, …]
  REGEX:      7,   // ['//']

  // ── Arithmetic ──────────────────────────────────────────────────────
  ADD:        8,   // '+'
  SUB:        9,   // '-'
  MUL:       10,   // '*'
  DIV:       11,   // '/'
  MOD:       12,   // '%'
  POW:       13,   // '**'
  UPLUS:     14,   // 'u+'
  UMINUS:    15,   // 'u-'
  PREINC:    16,   // '++'
  PREDEC:    17,   // '--'
  BITNOT:    18,   // '~'
  VOID:      19,   // 'void'

  // ── Bitwise binary ──────────────────────────────────────────────────
  BAND:      20,   // '&'
  BOR:       21,   // '|'
  BXOR:      22,   // '^'
  SHL:       23,   // '<<'
  SHR:       24,   // '>>'
  USHR:      25,   // '>>>'

  // ── Comparison / relational ─────────────────────────────────────────
  EQ:        26,   // '=='
  NEQ:       27,   // '!='
  SEQ:       28,   // '==='
  SNEQ:      29,   // '!=='
  LT:        30,   // '<'
  LTE:       31,   // '<='
  GT:        32,   // '>'
  GTE:       33,   // '>='
  IN:        34,   // 'in'
  INSTANCEOF:35,   // 'instanceof'
  TYPEOF:    36,   // 'typeof'

  // ── Logical ─────────────────────────────────────────────────────────
  NOT:       37,   // '!'
  AND:       38,   // '&&'
  OR:        39,   // '||'
  NULLISH:   40,   // '??'
  TERNARY:   41,   // '?:'  (prepared; raw '?' is consumed by prepare)

  // ── Assignment ──────────────────────────────────────────────────────
  ASSIGN:    42,   // '='
  ADDASSIGN: 43,   // '+='
  SUBASSIGN: 44,   // '-='
  MULASSIGN: 45,   // '*='
  DIVASSIGN: 46,   // '/='
  MODASSIGN: 47,   // '%='
  POWASSIGN: 48,   // '**='
  BANDASSIGN:49,   // '&='
  BORASSIGN: 50,   // '|='
  BXORASSIGN:51,   // '^='
  SHLASSIGN: 52,   // '<<='
  SHRASSIGN: 53,   // '>>='
  USHRASSIGN:54,   // '>>>='
  ORASSIGN:  55,   // '||='
  ANDASSIGN: 56,   // '&&='
  NULLASSIGN:57,   // '??='

  // ── Access / call / structure ────────────────────────────────────────
  CALL:      58,   // '()'
  DOT:       59,   // '.'
  INDEX:     60,   // '[]'
  OPTDOT:    61,   // '?.'
  OPTINDEX:  62,   // '?.[]'
  OPTCALL:   63,   // '?.()'
  ARROW:     64,   // '=>'
  NEW:       65,   // 'new'  (jzify-only; prepare strips or errors)
  DELETE:    66,   // 'delete'
  OBJECT:    67,   // '{}'
  PROP:      68,   // ':'   (object property pair in prepared AST)
  SPREAD:    69,   // '...'

  // ── Sequence / grouping ──────────────────────────────────────────────
  SEQ_:      70,   // ','   (sequence expression; not to be confused with SEQ '===')
  SEMI:      71,   // ';'
  PAREN:     72,   // '('
  BLOCK_:    73,   // '{'

  // ── Statements ───────────────────────────────────────────────────────
  LET:       74,   // 'let'
  CONST:     75,   // 'const'
  VAR:       76,   // 'var'
  IF:        77,   // 'if'
  FOR:       78,   // 'for'
  FORIN:     79,   // 'for-in'
  FOROF:     80,   // 'for-of'
  WHILE:     81,   // 'while'
  DO:        82,   // 'do'
  SWITCH:    83,   // 'switch'
  BREAK:     84,   // 'break'
  CONTINUE:  85,   // 'continue'
  RETURN:    86,   // 'return'
  THROW:     87,   // 'throw'
  TRY:       88,   // 'try'
  CATCH:     89,   // 'catch'
  FINALLY:   90,   // 'finally'
  LABEL:     91,   // 'label'

  // ── Declarations / modules ──────────────────────────────────────────
  IMPORT:    92,   // 'import'
  EXPORT:    93,   // 'export'
  FUNCTION:  94,   // 'function'
  CLASS:     95,   // 'class'
  CASE:      96,   // 'case'
  DEFAULT:   97,   // 'default'
  DEBUGGER:  98,   // 'debugger'

  // ── Synthetic (prepare-output only) ─────────────────────────────────
  AS:        99,   // 'as'    (import alias)
  BLOCK:    100,   // 'block' (synthetic wrapper from prepare / jzify)
  FROM:     101,   // 'from'  (import specifier)
}))

// Reverse map: OP_NAME[i] = the original string op (for error messages + WASM passthrough guard)
export const OP_NAME = []
for (const [name, id] of Object.entries(OP)) OP_NAME[id] = OP_STR[name]

// String-to-int lookup (used by internOps pass): maps every raw parse string to its OP integer.
export const OP_INT = Object.assign(Object.create(null), {
  nan: OP.NAN, bool: OP.BOOL, str: OP.STR, strcat: OP.STRCAT, bigint: OP.BIGINT,
  '[': OP.ARRAY, '//': OP.REGEX,
  '+': OP.ADD, '-': OP.SUB, '*': OP.MUL, '/': OP.DIV, '%': OP.MOD, '**': OP.POW,
  'u+': OP.UPLUS, 'u-': OP.UMINUS, '++': OP.PREINC, '--': OP.PREDEC, '~': OP.BITNOT, 'void': OP.VOID,
  '&': OP.BAND, '|': OP.BOR, '^': OP.BXOR, '<<': OP.SHL, '>>': OP.SHR, '>>>': OP.USHR,
  '==': OP.EQ, '!=': OP.NEQ, '===': OP.SEQ, '!==': OP.SNEQ,
  '<': OP.LT, '<=': OP.LTE, '>': OP.GT, '>=': OP.GTE,
  'in': OP.IN, 'instanceof': OP.INSTANCEOF, 'typeof': OP.TYPEOF,
  '!': OP.NOT, '&&': OP.AND, '||': OP.OR, '??': OP.NULLISH, '?:': OP.TERNARY,
  '=': OP.ASSIGN, '+=': OP.ADDASSIGN, '-=': OP.SUBASSIGN, '*=': OP.MULASSIGN,
  '/=': OP.DIVASSIGN, '%=': OP.MODASSIGN, '**=': OP.POWASSIGN,
  '&=': OP.BANDASSIGN, '|=': OP.BORASSIGN, '^=': OP.BXORASSIGN,
  '<<=': OP.SHLASSIGN, '>>=': OP.SHRASSIGN, '>>>=': OP.USHRASSIGN,
  '||=': OP.ORASSIGN, '&&=': OP.ANDASSIGN, '??=': OP.NULLASSIGN,
  '()': OP.CALL, '.': OP.DOT, '[]': OP.INDEX, '?.': OP.OPTDOT, '?.[]': OP.OPTINDEX,
  '?.()': OP.OPTCALL, '=>': OP.ARROW, 'new': OP.NEW, 'delete': OP.DELETE,
  '{}': OP.OBJECT, ':': OP.PROP, '...': OP.SPREAD,
  ',': OP.SEQ_, ';': OP.SEMI, '(': OP.PAREN, '{': OP.BLOCK_,
  'let': OP.LET, 'const': OP.CONST, 'var': OP.VAR, 'if': OP.IF, 'for': OP.FOR,
  'for-in': OP.FORIN, 'for-of': OP.FOROF, 'while': OP.WHILE, 'do': OP.DO,
  'switch': OP.SWITCH, 'break': OP.BREAK, 'continue': OP.CONTINUE, 'return': OP.RETURN,
  'throw': OP.THROW, 'try': OP.TRY, 'catch': OP.CATCH, 'finally': OP.FINALLY, 'label': OP.LABEL,
  'import': OP.IMPORT, 'export': OP.EXPORT, 'function': OP.FUNCTION, 'class': OP.CLASS,
  'case': OP.CASE, 'default': OP.DEFAULT, 'debugger': OP.DEBUGGER,
  'as': OP.AS, 'block': OP.BLOCK, 'from': OP.FROM,
})
```

**Trait bitmask object (separate from the tag integers):**

```js
// src/op.js (continued) — trait bitmasks, parallel to OP
// A plain dense BitArray[OP_COUNT] is faster to query than a Set.has() call under
// self-host (direct array index vs. hash probe). Index is the OP integer.
// Build at module init from the string-keyed sets in kind-traits.js.
export const OP_COUNT = 102  // max OP value + 1

// BOOL_RESULT[op] = 1 if op always yields a boolean (replaces BOOL_OPS Set)
export const BOOL_RESULT = new Uint8Array(OP_COUNT)
for (const s of ['!','<','<=','>','>=','==','!=','===','!==','in','instanceof'])
  BOOL_RESULT[OP_INT[s]] = 1

// NUMERIC_BIN[op] = 1 (replaces NUMERIC_BINARY_OPS list entries)
export const NUMERIC_BIN = new Uint8Array(OP_COUNT)
for (const s of ['-','u-','*','/','%','&','|','^','<<','>>'])
  NUMERIC_BIN[OP_INT[s]] = 1

// ASSIGN_OP[op] = 1 (replaces ASSIGN_OPS Set)
export const ASSIGN_OP = new Uint8Array(OP_COUNT)
for (const s of ['=','+=','-=','*=','/=','%=','**=','&=','|=','^=','<<=','>>=','>>>=','||=','&&=','??='])
  ASSIGN_OP[OP_INT[s]] = 1

// STMT_OP[op] = 1 (replaces STMT_OPS Set)
export const STMT_OP = new Uint8Array(OP_COUNT)
// ... filled from STMT_OPS list
```

`Uint8Array` indexed by integer is an array read — `O(1)`, no string hashing. Under self-host this compiles to a single `typed:[]` read on a typed-array local (a TYPED val), which jz emits as a direct i32 load without any pointer unwrapping (no NaN-box overhead on typed-array element reads). This is the fastest possible Set-membership operation for integers inside the wasm kernel.

**Critical: `OP.LIT = 0` choice.** Setting the null-op sentinel to `0` means:
- `!op` remains true for the LIT op — any code that currently tests `if (!op)` as a fast prior-check before `== null` continues to work.
- `op == null` becomes FALSE after migration (`0 == null` is false in JS). Every one of the 66 `op == null` sites MUST change to `op === OP.LIT` or `op === 0`. This is the most pervasive mechanical change and the highest-risk single site type. Using 0 is still better than a negative value or a Symbol because it lets `!op` serve as a fast guard at the 6 hot pre-dispatch checks in emit().

---

### 2. Strategy: Post-Parse Intern Pass, NOT Parse-Emits-Int

**Decision: post-parse intern pass.**

Why not parse-emits-int: `src/parse.js` is a three-line shim over `subscript/feature/jessie` (parse.js:15-29). Patching subscript's Pratt parser to emit integer tags at the operator-token level requires either forking subscript (breaking the dependency) or registering overrides for every operator token (~60+). The three `token()` overrides at parse.js:31-42 for `NaN`, `true`, `false` are already doing the maximum viable patching — they override value-token callbacks, not operator-token callbacks. The operator callbacks in subscript's parser produce `[op, left, right]` nodes inline inside the parser's infix/prefix dispatch; there is no single hook to intercept all of them. A parse-emits-int strategy would require understanding and patching subscript's internal Pratt mechanics, which is unacceptable scope.

**The intern pass: `internOps(ast)`**

Add a single recursive walk at `index.js:518` — between `liftIIFEs` and `jzify` — and a parallel call in `scripts/self.js:83`. The walk converts every `node[0]` from a string to its OP integer in-place (mutating the arrays is safe here; the parsed AST is freshly created and not referenced from anywhere else). The walk is O(N) in AST node count, N typically 500–5000 nodes for real programs; cost is negligible vs. the compile pipeline.

```js
// src/op.js — internOps (add here, not a separate file)
export function internOps(ast) {
  if (!Array.isArray(ast)) return ast
  const op = ast[0]
  if (typeof op === 'string') {
    const id = OP_INT[op]
    if (id !== undefined) ast[0] = id
    // if id is undefined: op is a raw-parse op consumed by prepare ('?', '`', '``', 'try')
    // or a prepare-synthesized op that comes from inside prepare itself. Leave as string
    // and let prepare handler look it up. (After stage 3 below, prepare will also intern.)
  }
  for (let i = 1; i < ast.length; i++) internOps(ast[i])
  return ast
}
```

Insertion point in `index.js`:
```
// index.js:509 — AFTER parse, BEFORE jzify
let parsed = time('parse', () => parse(code))
if (typeof code === 'string' && code.includes(T)) rejectReservedPrefix(parsed)
parsed = time('liftIIFE', () => liftIIFEs(parsed))
parsed = internOps(parsed)              // <-- NEW; single O(N) walk, negligible cost
if (!opts.strict) parsed = time('jzify', () => jzify(parsed))
const ast = time('prepare', () => prepare(parsed))
```

And in `scripts/self.js` at the parallel location (line ~83):
```js
return strict ? parsed : jzify(internOps(parsed))
// or for the strictly-correct staging:
parsed = internOps(parsed); return strict ? parsed : jzify(parsed)
```

Note: `jzify/` (transform.js, classes.js, bundler.js, hoist-vars.js, arguments.js, switch.js — 133 `[0] ===` sites) sees the AST AFTER `internOps`. This means jzify must also use OP constants or be migrated before internOps is inserted. The correct order is: migrate jzify first, THEN insert internOps before jzify.

**prepare/index.js** also synthesizes new nodes internally (e.g., `['str', s]` at line 836, `['u-', ...]`, `['?:', ...]`, `['catch', ...]`, `['block', ...]`). All internal `[string, ...]` constructions inside prepare must be updated to use OP constants simultaneously when the pass becomes int-aware. Until then, prepare's output (the nodes it synthesizes internally) comes out with string tags, and emit sees a mix. The fix: either (a) migrate prepare in one atomic step, or (b) run a second `internOps` after prepare (before emit) to catch prepare's synthetic nodes. Option (b) is the safer transitional strategy — add internOps in TWO places: after parse and after prepare.

---

### 3. Hot Dispatch Tables: Conversion to Integer-Indexed Arrays

#### 3a. `ctx.core.emit` — the primary hot table

Current: `ctx.core.emit = { ...proto }` where proto is the `emitter` export from `emit.js` — a plain POJO with ~53 string keys, extended at runtime by modules to ~270+ entries. The HASH probe fires at emit.js:3560 and :3518 on every array AST node.

Target: a plain `Array` indexed by `OP.*` integer, for structural ops (0–101). Method keys (`.push`, `.string:slice`, `math.sin`, etc.) remain in a separate string-keyed side object. This keeps the two concerns separate and avoids conflating structural dispatch (finite, closed, enumerable) with method/namespace dispatch (open, extensible, string-keyed).

**New `ctx.core` layout:**
```js
ctx.core = {
  emit: new Array(OP_COUNT),   // indexed by OP integer — structural AST ops
  emitStr: {},                 // string-keyed — method keys, callee strings, 'new.Map', etc.
  stdlib: {}, stdlibDeps: {}, includes: new Set(), ...
}
```

The `derive(proto)` call at `ctx.js:194` becomes:
```js
emit: proto.slice(),    // plain Array.from / .slice() of the base table
emitStr: { ...protoStr },
```

The `emitter` export at `emit.js:2392` becomes `const emitTable = new Array(OP_COUNT)` populated by:
```js
emitTable[OP.SEMI] = (...args) => { ... }
emitTable[OP.BLOCK_] = (...args) => ...
emitTable[OP.SEQ_] = (...args) => ...
// etc. for all 69 base entries
```

At `emit.js:3560`:
```js
// BEFORE: const handler = ctx.core.emit[op]
// AFTER:
const handler = typeof op === 'number' ? ctx.core.emit[op] : ctx.core.emitStr[op]
```

However: the `typeof op === 'number'` guard adds a branch that must fire on EVERY node. The cleaner form is to guarantee that after internOps, all structural ops ARE integers, so the check becomes:
```js
const handler = ctx.core.emit[op]   // array[int] — same syntax, different semantics
if (!handler) err(`Unknown op: ${op}`)
```

This is byte-identical syntax change; the array lookup `arr[int]` in JS is O(1) without hashing. Under jz's self-host compilation, a plain Array local typed as ARRAY (VAL.ARRAY) with integer index reads through `__typed_idx` (the typed-array element-read path) rather than `__dyn_get_t_h` (the HASH probe path). That is the core performance win.

**Self-host safety of Array dispatch:** The groundtruth doc's Deque failure (line 309-313) was about a single local variable that held sometimes-Array, sometimes-Deque — creating array/object polymorphism. The dispatch array (let's call it `emitTable`) would be a module-level constant array, never aliased with any object. `ctx.core.emit` would be a new Array (never confused with `ctx.core.emitStr` which is a plain POJO). The critical discipline: never assign `ctx.core.emit = { ... }` (would make it a HASH) and never assign `ctx.core.emitStr = new Array()` (would make it ARRAY). Keep the types consistent throughout initialization.

**Module registration at bridge.js:25-27 (`bind` function):** Currently `ctx.core.emit[name] = handler`. After the split:
```js
export const bind = (name, handler) => {
  if (typeof name === 'number') ctx.core.emit[name] = handler
  else ctx.core.emitStr[name] = handler
  return handler
}
```

**Module files (`core.js`, `array.js`, `math.js`, `collection.js`)** that do `ctx.core.emit['.'] = handler`, `ctx.core.emit['?.'] = handler`, etc. must use `bind(OP.DOT, handler)` or `ctx.core.emitStr['.'] = handler` depending on whether the op is a structural op (has an OP constant) or a method/namespace key. The 11 structural ops registered by modules (`.`, `?.`, `?.[]`, `?.()`, `typeof`, `[]`, `**`, `delete`, `in`, `for-in`, `{}`) all have OP constants and must move to `ctx.core.emit[OP.*]`. The remaining ~220 dotted-string entries (`math.sin`, `.push`, `.string:slice`, etc.) stay in `ctx.core.emitStr`.

The WASM passthrough guard at emit.js:3518:
```js
// BEFORE:
if (typeof op === 'string' && !ctx.core.emit[op] && (op.includes('.') || WASM_OPS.has(op))) return node
// AFTER: op is always a number for structural AST ops; WASM IR nodes have string ops
// (they are NOT passed through internOps — they are created by emit() itself).
// The guard becomes: only fire for string ops (WASM IR that re-enters emit).
if (typeof op === 'string') {
  if (!ctx.core.emitStr[op] && (op.includes('.') || WASM_OPS.has(op))) return node
  // else fall through to emitStr dispatch
}
```

This is cleaner than before — the `typeof op === 'string'` check also serves as the WASM passthrough discriminant.

#### 3b. `VT` in `kind.js` — the valTypeOf dispatch table

Current: `const VT = Object.create(null)` — null-proto POJO with ~30 string keys, HASH-typed in self-host.

Target: plain Array indexed by OP integer.

```js
// kind.js:103 — BEFORE
const VT = Object.create(null)
VT.bool = () => VAL.BOOL
for (const op of BOOL_OPS) VT[op] = VT.bool
// ...

// AFTER
const VT = new Array(OP_COUNT)   // indexed by OP.*
VT[OP.BOOL] = () => VAL.BOOL
for (const op of BOOL_OPS) VT[OP_INT[op]] = VT[OP.BOOL]
// ...
```

The dispatch at kind.js:361:
```js
// BEFORE: return VT[op]?.(args) ?? null
// AFTER (op is now an integer):
return VT[op]?.(args) ?? null   // same syntax; array[int] instead of hash[string]
```

The `op == null` guard at kind.js:353 becomes `op === OP.LIT` (or `op === 0`, or just `!op` since LIT = 0).

The hot BOOL_OPS.has(op) call at kind.js:37 becomes:
```js
// BEFORE: if (BOOL_OPS.has(op)) { ... }
// AFTER:
if (BOOL_RESULT[op]) { ... }   // Uint8Array[int], no hash probe
```

The `literalBool` function at kind.js:74-95 has an `includes()` check and a switch on string ops — both must convert to OP integer comparisons.

---

### 4. Migration Order — Minimizing Broken-Intermediate State

The key constraint: the test suite (`npm test` — 2400+ tests) must remain green after each commit. The output must stay byte-identical. There is one unavoidable atomic flip: the moment `internOps` is inserted before jzify/prepare AND emitter tables switch to integer keys, ALL consumers of AST `node[0]` must simultaneously understand integers. The strategy below defers that atomic moment as late as possible by building in dual-mode support and testing before the cutover.

#### Phase 0 — Create `src/op.js`, no behavior change (green after)

Write `src/op.js` with `OP`, `OP_INT`, `OP_NAME`, trait arrays (`BOOL_RESULT`, `NUMERIC_BIN`, `ASSIGN_OP`, `STMT_OP`). Import it nowhere yet. Tests pass trivially.

Verify: `npm test` green. Commit: "add src/op.js — OP enum constants (inactive)".

#### Phase 1 — Dual-key the emitter and VT tables (green after each sub-step)

**Step 1a:** Populate `emitter` with integer aliases without removing string aliases. At `emit.js:2392` after the object literal:
```js
// After the existing emitter object definition, add aliases:
import { OP, OP_INT } from '../op.js'
for (const [str, id] of Object.entries(OP_INT)) {
  if (emitter[str] !== undefined) emitter[id] = emitter[str]
}
```
Now `emitter[OP.ADD]` and `emitter['+']` both work. `ctx.core.emit` inherits both via `derive(proto)`. No behavior change — all existing lookups still use string keys. Green.

**Step 1b:** Dual-key VT table in `kind.js`:
```js
import { OP_INT } from './op.js'
// After existing VT assignments:
for (const [str, id] of Object.entries(OP_INT)) {
  if (VT[str] !== undefined) VT[id] = VT[str]
}
```
Green.

**Step 1c:** Dual-key `handlers` in `prepare/index.js` the same way. Green.

**Step 1d:** Dual-key `OP_MODULES` in `autoload.js`. Green.

At this point all tables respond to both string and integer keys. The system is backward-compatible.

#### Phase 2 — Add `internOps` in dual-readable mode (green after)

Add the `internOps` function to `src/op.js`. Do NOT insert it in the pipeline yet. Instead, add a utility function `opFromNode(node)` that returns the current `node[0]` as-is (works for both string and integer):
```js
// src/op.js
export const opOf = (node) => Array.isArray(node) ? node[0] : null
// After Phase 3: this returns an integer. Before: a string. Same API.
```

#### Phase 3 — Migrate jzify/ (133 sites, prerequisite to inserting internOps before jzify)

jzify runs BEFORE prepare and consumes the raw string-tagged AST from subscript/parse. After inserting internOps, jzify will see integer-tagged nodes. jzify must be migrated to use OP constants before internOps is activated.

In jzify files (`transform.js`, `classes.js`, `bundler.js`, `hoist-vars.js`, `arguments.js`, `switch.js`):
- Import `OP` from `'../src/op.js'`
- Replace every `node[0] === 'let'` with `node[0] === OP.LET`
- Replace every `node[0] = 'block'` with `node[0] = OP.BLOCK`
- Etc. for all 133 sites

This is mechanical. Since jzify is NOT self-hosted (it runs on the host-side JS engine), there are no self-host constraints here. The jzify migration can be done file-by-file with `npm test` after each file.

Commit after each jzify file. Total: 6 commits.

**Validation after each:** `npm test` green. Output byte-identical (jzify output nodes that reach emit must produce same IR — adding OP constants to jzify nodes doesn't change the nodes' semantics, only their tag representation).

Wait: at this point internOps has NOT been inserted yet. jzify still sees string-tagged nodes from subscript. So the jzify migration is premature — jzify would be using OP constants but receiving string-tagged input and outputting nodes that consumers (prepare) haven't been updated to read yet. The correct sequence is:

3.1. Migrate jzify to produce OP-integer-tagged output nodes (the nodes it CREATES, e.g., `['block', ...]` → `[OP.BLOCK, ...]`).
3.2. The nodes jzify READS from subscript still have string tags at this point. So jzify's comparison sites (`node[0] === 'let'`) must handle BOTH string and integer (from subscript). Use:
```js
const op = node[0]
if (op === 'let' || op === OP.LET) { ... }
```
This is the transitional form. After internOps is activated, the string case becomes dead code and can be stripped.

3.3. Migrate prepare/index.js to produce OP integers in its synthetic nodes (`['str', s]` → `[OP.STR, s]`, etc.). Also update its comparison dispatch (`const handler = handlers[op]` — already dual-keyed).

3.4. Activate internOps in the pipeline (insert in index.js:518 and scripts/self.js:83). From this point on, every node[0] is an integer when it reaches jzify and prepare (because internOps runs before both). The string fallbacks in the transitional `|| op === OP.LET` forms become dead.

3.5. After full activation, strip the dead string-comparison fallbacks.

#### Phase 4 — Migrate prepare/index.js (148 sites, atomic within the file)

All 148 `[0] ===` sites and the `handlers` dispatch at line 839. Since handlers is already dual-keyed (Phase 1c), the `handlers[op]` lookup works for integer ops immediately after internOps is activated. The comparison sites (`op === '='`, `op === 'try'`, etc.) must be updated. These can be done in a single commit after activating internOps, since at that point all input is integer-tagged.

Green gate: after this commit, `npm test` must still pass. If prepare synthesizes nodes with integer tags that flow into emit (which still has dual keys), it works.

#### Phase 5 — Migrate emit.js (74 sites, but only ~24 in the hot emit() body)

The 6 hot pre-dispatch guards at emit.js:3523, :3530, :3537, :3540, :3548, :3559 and the 18 warm comparison sites in helper functions. With dual-keyed `ctx.core.emit`, the table dispatch (line 3560) already works for both integer and string ops. Migrate comparisons file-by-file:

5.1. Convert the 6 hot guards first:
```js
// :3523 BEFORE: if (op === 'bigint')
if (op === OP.BIGINT)
// :3530 BEFORE: if (op === 'nan')
if (op === OP.NAN)
// :3537 BEFORE: if (op === 'bool')
if (op === OP.BOOL)
// :3540 BEFORE: if (op == null && args.length === 1)
if (op === OP.LIT && args.length === 1)
// :3548 BEFORE: if (op === '.' || op === '[]' || op === '()')
if (op === OP.DOT || op === OP.INDEX || op === OP.CALL)
// :3559 BEFORE: if (op === 'let' || op === 'const')
if (op === OP.LET || op === OP.CONST)
```

5.2. Convert the WASM passthrough guard at :3518:
```js
// BEFORE:
if (typeof op === 'string' && !ctx.core.emit[op] && (op.includes('.') || WASM_OPS.has(op))) return node
// AFTER: WASM IR nodes (created by emit() itself) still have string ops — internOps
// never touches them. So `typeof op === 'string'` correctly discriminates WASM IR.
if (typeof op === 'string' && !ctx.core.emitStr[op] && (op.includes('.') || WASM_OPS.has(op))) return node
```

Note: at this point `ctx.core.emitStr` exists (Phase 1 transition) or we can check `ctx.core.emit[op]` which doesn't have WASM op entries.

5.3. Migrate liftOptionalChain (emit.js:3350-3377, line 3353-3354 — the 6 optional-chain string comparisons):
```js
// BEFORE: cur[0] === '.' || cur[0] === '[]' || cur[0] === '()'
if (cur[0] === OP.DOT || cur[0] === OP.INDEX || cur[0] === OP.CALL ||
    cur[0] === OP.OPTDOT || cur[0] === OP.OPTINDEX || cur[0] === OP.OPTCALL)
```

5.4. Migrate the 18 warm comparison sites in helpers (lines 414, 692-694, 788, 793, 904-905, 1359, 1363, 2613-2615, 3045-3046, 3082, 3089-3091).

Green after each sub-step.

#### Phase 6 — Migrate kind.js (26 sites in valTypeOf + literalTruthiness + literalBool)

The `VT` array dispatch already works (Phase 1b). Migrate comparison sites:

6.1. `op == null` at kind.js:353 → `op === OP.LIT` (or `op === 0`).
6.2. `op === 'bool'` at lines 33, 66 → `op === OP.BOOL`.
6.3. `op === 'nan'` at line 34 → `op === OP.NAN`.
6.4. `op === 'str'` at line 35 → `op === OP.STR`.
6.5. `op === '()'` at lines 36, 48, 70 → `op === OP.CALL`.
6.6. `BOOL_OPS.has(op)` at line 37 → `BOOL_RESULT[op]` (Uint8Array lookup).
6.7. `op === '?:'` at line 41 → `op === OP.TERNARY`.
6.8. `op === '?'` at line 41 → raw '?' never reaches kind.js (prepare rewrites it); defensive: `op === OP.TERNARY`.
6.9. Comparisons in `literalBool` at lines 77-93 → OP constants.
6.10. `VT[op]?.(args)` at line 361 — already integer-indexed after Phase 1b; syntax unchanged.

#### Phase 7 — Migrate ast.js, static.js, type.js (STMT_OPS/ASSIGN_OPS Sets → Uint8Arrays; 36+22+34 sites)

Replace `STMT_OPS`, `ASSIGN_OPS`, `JZ_BLOCK_OPS`, `LABEL_BODY_OPS`, `STMT_ONLY_OPS` Sets with `STMT_OP`, `ASSIGN_OP` Uint8Arrays (already built in op.js). Update all `.has(op)` to `ASSIGN_OP[op]`. The isBlockBody function at ast.js:62 becomes:
```js
export const isBlockBody = (body) =>
  Array.isArray(body) && body[0] === OP.OBJECT && (body.length === 1 || STMT_OP[body[1]?.[0]])
```

`isLiteralStr` at ast.js:66 → `idx[0] === OP.STR`.

All `== null` sites in ast.js → `=== OP.LIT`.

#### Phase 8 — Migrate compile/analyze.js, analyze-scans.js, type.js, narrow.js, program-facts.js, plan/* (55+48+34+20+23+~100 sites)

These are WARM paths (per function compilation, not per node). Migrate in bulk file-by-file after the hot-path (Phases 5-7) changes are committed and verified.

#### Phase 9 — Switch ctx.core.emit from dual-keyed POJO to integer-indexed Array

This is the structural change that actually eliminates the hash probe. Until Phase 9, `ctx.core.emit[OP.ADD]` is still a property read on a POJO (HASH type in self-host) — just keyed by integer. The hash probe still fires; it just finds the key faster (integer hashes faster than string). Phase 9 converts `ctx.core.emit` to an actual `Array`:

9.1. Change `ctx.core.emit = derive(proto)` in `ctx.js:194` to:
```js
emit: proto.slice(),      // Array.prototype.slice() returns new Array
emitStr: { ...protoStr }, // separate POJO for string-keyed entries
```

9.2. Change `const emitter = { ... }` in `emit.js:2392` to `const emitter = new Array(OP_COUNT)` with integer-indexed assignments.

9.3. Add `const emitterStr = {}` for all the dotted-string entries currently inline in `ctx.core.emit` assignments from modules.

9.4. Update `ctx.js:reset()` to populate both:
```js
ctx.core = {
  emit: Array.from(proto),   // proto is now an Array[OP_COUNT]
  emitStr: { ...protoStr },  // proto is also passed as protoStr
  ...
}
```

9.5. All module registrations (`ctx.core.emit['typeof']`, `ctx.core.emit['.']`, etc.) split:
- Structural ops (`typeof`, `.`, `?.`, `?.[]`, `?.()`, `[]`, `**`, `delete`, `in`, `for-in`, `{}`) → `ctx.core.emit[OP.TYPEOF]`, `ctx.core.emit[OP.DOT]`, etc.
- Method/namespace keys (`.push`, `math.sin`, `.string:slice`, `Error`, etc.) → `ctx.core.emitStr['.push']`, etc.

The emit() dispatch at line 3560:
```js
const handler = typeof op === 'number' ? ctx.core.emit[op] : ctx.core.emitStr[op]
```
Or with the guarantee that only integer ops reach here (string ops caught by the WASM passthrough guard at :3518):
```js
const handler = ctx.core.emit[op]   // array[int]
```

9.6. The `node.includes('.')` dotted-callee path at emit.js:3493:
```js
if (node.includes('.') && ctx.core.emitStr[node]) {   // was ctx.core.emit
```

Similarly emit.js:3321:
```js
if (typeof callee === 'string' && ctx.core.emitStr[callee] && ...)
```

**Self-host safety of Array:** A plain `Array` (not TypedArray) holding function references is ARRAY-typed in self-host (VAL.ARRAY). Subscript's own parser (`node_modules/subscript/src/parse.js`) already uses a charcode-indexed dispatch array — precisely the same pattern — and this compiles and runs under self-host. The risk: DO NOT mix `ctx.core.emit` (Array) and `ctx.core.emitStr` (POJO) through a common binding. Never assign one to the other. Keep them separate named properties on `ctx.core`.

Under self-host, `ctx.core.emit[op]` where `op` is an i32 variable compiles as:
```
local.get $op         ; i32
local.get $ctx_core_emit   ; array ptr (f64 NaN-box)
... __arr_get or typed:[] read
```
This routes through `__typed_idx` (2.1% of profile currently!) for typed arrays, or `__arr_get` for plain arrays. Plain array element reads use `__dyn_get_t` with integer key, which calls `__ihash_get_local` — wait, does it?

Let me reconsider. Under jz's runtime, a plain `Array` (VAL.ARRAY) indexed by integer uses the array-element read path, NOT the hash path. The `__dyn_get_t` dispatcher checks the receiver type first:
- If receiver is ARRAY: goes to the array-element read (fast integer offset)
- If receiver is HASH/OBJECT: goes to `__ihash_get_local` (string hash probe)

So `ctx.core.emit[op]` with an Array receiver and integer index does NOT invoke `__ihash_get_local`. It uses the integer-indexed array path, which is just: `ptr_offset + i * 8` (f64 element read from linear memory). This is the win — one memory read, no hash, no string comparison.

However: plain Array element reads in jz currently still go through `__dyn_get_t` which has type-dispatch overhead (checking PTR type, unwrapping, checking index bounds). The marginal cost versus HASH lookup is that HASH pays `__str_hash` + `__ihash_get_local` (probing), while Array pays just the index-path in `__dyn_get_t`. This is the saving: eliminating `__str_hash` (5.7%) and part of `__ihash_get_local` (4.0%) for the dispatch sites.

---

### 5. Validation Protocol Per Step

**After each commit:**

1. **Correctness gate:** `npm test` — 2400+ tests must all pass.

2. **Byte-identical gate:** Before starting, snapshot a corpus of compiled outputs:
   ```
   for case in bench/*/; do node index.js <(cat $case/*.js) --compile > expected/$case.wasm; done
   ```
   After each Phase commit:
   ```
   for case in bench/*/; do node index.js <(cat $case/*.js) --compile | diff - expected/$case.wasm; done
   ```
   Zero diffs required. The change is purely representational — no semantic change — so output MUST be byte-identical.

3. **Self-host gate (Phase 9 only):** `npm run test:self` — verifies jz compiles itself correctly and the wasm output is valid. Run `npm run test:wasm` after Phase 9 to verify the rebuilt `jz.wasm` produces identical output for the corpus.

4. **Benchmark delta:** After Phase 9:
   ```
   node scripts/bench-selfhost.mjs > after.txt
   ```
   Compare to baseline. Target: measure reduction in `__str_hash`/`__ihash_get_local` ticks, and overall corpus-compile time.

   For per-function profiling: `node --prof scripts/bench-selfhost.mjs && node --prof-process isolate-*.log | grep -A 5 "Bottom up"` to isolate `__str_hash` tick fraction before and after.

---

### 6. Soundness / Self-Host Traps

**Trap 1 — `OP.LIT = 0` and the falsy danger.** The null-op literal `[null, value]` currently uses `null` as node[0]. With `OP.LIT = 0`, tests for `op == null` become FALSE (0 == null is false). If ANY `op == null` or `!op` check survives unpatched, it silently miscompiles all numeric/boolean/null/undefined literals — the most common AST node type. Every one of the 66 sites must be mechanically updated. Use a grep+fix script after Phase 4 to find survivors:
```
grep -rn "== null\|!op\b\|!node\[0\]" src/ jzify/ | grep -v "node_modules\|// "
```

**Trap 2 — Array vs. POJO type pollution.** After Phase 9, `ctx.core.emit` is an Array. If any code path does `ctx.core.emit = { ...something }` (assigns a POJO), jz's monomorphic type inference bakes in ARRAY for the local and will mismatch — silently miscompiling accesses. Audit: grep for `ctx.core.emit =` and ensure it always assigns an Array. The `derive(proto)` at ctx.js:194 must use `proto.slice()` not `{ ...proto }` once proto is an Array.

**Trap 3 — `op.includes('.')` at emit.js:3493.** This test runs on string identifiers (resolved callee names like `'math.sin'`) — these are NOT AST op tags, they are string nodes (a string `node` where the full node IS the string). After migration, `op` (= `node[0]`) is always an integer for array nodes, so `node.includes('.')` would be called on a number when `node` is an array with integer op. The guard at 3493 actually checks if the entire `node` (not `node[0]`) is a string:
```js
// emit.js:3493 — `node` here is the full AST node being emitted, not `node[0]`
if (node.includes('.') && ctx.core.emitStr[node])
```
This is invoked when `node` is a string (identifier) reaching the `emit()` string branch, not when it's an array. This path is unaffected by integer tagging — it handles string identifiers, not array nodes. No change needed.

**Trap 4 — The `handlers['?']` in prepare.** Raw parse produces `'?'` (ternary raw form); prepare's handler at prepare/index.js:~1700 consumes it and synthesizes `['?:', ...]`. The `'?'` key must remain in `handlers` as a string key OR be converted to `OP_INT['?']` if we define an `OP.RAWTERNARY`. Since raw `'?'` nodes are consumed by prepare before emit ever sees them, they don't need to be in `emitter` or `VT`. They only need to be in `handlers`. Define `OP.RAWTERNARY` in op.js and add it to `OP_INT['?']`. Update the handlers table. Similar for `'?'`, `` '`' ``, `` '``' ``, `'try'`.

**Trap 5 — Static analysis of frozen `OP` object.** `Object.freeze(Object.assign(Object.create(null), {...}))` produces a schema-fixed frozen object. Under jz's self-host, frozen objects may be typed OBJECT (not HASH) if their schema is resolvable at compile time. The `OP_INT` lookup object is NOT frozen (it has ~100 entries used as a string→int map for the intern pass). This is fine — it's only used once per compile (during internOps, once per AST), not on the hot per-node path. But if `OP` itself is needed on the hot path (e.g., `OP.DOT` referenced from inside emit()), it being a POJO means `OP.DOT` is a HASH read — BUT since `OP` is imported at module load and `OP.DOT` is a constant-valued property, jz's schema inference may constant-fold it. To be safe: destructure `OP` at the top of each file:
```js
import { OP } from '../op.js'
const { DOT, INDEX, CALL, LET, CONST, LIT, BOOL, NAN, STR } = OP
```
After destructuring, each `DOT`, `INDEX`, etc. is a local constant with inferred type `VAL.NUMBER` (integer), and comparisons like `op === DOT` compile to a direct i32.eq without any object lookup.

**Trap 6 — module/core.js `ctx.core.emit['.'] = ...` pattern.** After Phase 9, this must be `ctx.core.emit[OP.DOT] = ...`. Since `OP.DOT` is a number, the assignment goes to the array slot. If a stale string assignment `ctx.core.emit['.'] = ...` runs after the array-based `emit` is created, it adds a numeric-string key `'.'` to the Array object (arrays are objects; `arr['.'] = x` is valid JS but writes a non-index property). The test for `.` dispatch would fail because `ctx.core.emit[OP.DOT]` (integer 59) ≠ `ctx.core.emit['.']` (string key). Mitigation: in Phase 9, audit every `ctx.core.emit[stringKey] =` in module/*.js and bridge.js, ensure each either has an OP constant (use it) or goes to `ctx.core.emitStr` (method/namespace keys).

**Trap 7 — `emitter(deps, fn)` factory in ctx.js:118.** The `emitter` function (ctx.js:118, exported) wraps a handler with dep-tracking. It's named identically to the `emitter` table (emit.js:2392), which would become a naming collision after the table rename. Rename the base table: `const emitTable = new Array(OP_COUNT)` in emit.js, exported as `export { emitTable as emitter }` for backward compat with imports in bridge.js:11 (`import { emitter } from './ctx.js'`). Actually the `emitter` factory is in ctx.js and is re-exported from bridge.js:59 as `emitter(depsOrOpts, maybeFn)`. The BASE TABLE is `emit.js`'s export also named `emitter`. These are two different exports from two different files. The base table lives in emit.js; the factory lives in ctx.js. The name collision is only in human reading, not in module scope. Rename the base table to `emitTable` in emit.js for clarity, update all imports.

**Trap 8 — `bench-selfhost.mjs` output checksums.** The bench script currently checksums the compiled wasm output and compares wasm/JS results for parity (scripts/bench-selfhost.mjs:~48-70). After Phase 9, if ctx.core.emit is an Array, self-host mode will compile the modified compiler correctly ONLY after `jz.wasm` is rebuilt from the modified source. The dev loop during Phase 9 is: edit → `npm test` (js path) → rebuild jz.wasm → `npm run test:self` → bench. Until the wasm is rebuilt, `npm run test:self` tests the OLD wasm against the NEW JS source; they should still agree on output (byte-identical) because the change is representational, but the `jz.wasm`'s INTERNAL representation differs. Run `npm run build` after Phase 9 is verified green on the JS path.

---

### 7. Honest 6-Hour Scope

**What is achievable:**

Phase 0 (1h): Write `src/op.js` in full — all 101 OP constants, `OP_INT` reverse map, `OP_NAME`, `BOOL_RESULT`/`ASSIGN_OP`/`STMT_OP` Uint8Arrays, `internOps` function. Run test: green. This file alone is the foundation for everything.

Phase 1 (1h): Dual-key all four tables (emitter, VT, handlers, OP_MODULES). Three files touched: `emit.js`, `kind.js`, `prepare/index.js`, `autoload.js`. Run test: green. This makes the system forward-compatible.

Phase 3 partial (2h): Migrate `jzify/` — 6 files, 133 sites. Mechanical find-replace for each file. Run test after each file. Commit after each.

Phase 5 partial (1h): Migrate the 6 hot pre-dispatch guards in `emit()` body (emit.js:3523-3559) plus liftOptionalChain (6 sites). This is the highest-value change per site — these run on EVERY array node. Run test: green.

Phase 6 partial (1h): Migrate kind.js's 26 sites — especially `BOOL_OPS.has(op)` → `BOOL_RESULT[op]` and the `literalTruthiness`/`VT` dispatch. Run test: green.

**Total Phase 0+1+3+5partial+6partial in 6h:** The pipeline is dual-mode, internOps is written but not yet activated, jzify is migrated, and the two hottest comparison clusters (emit.js, kind.js) use OP constants. The dispatch tables still do HASH probes (Phase 9 not done). But the migration is partially visible: new code uses `OP.*` constants throughout.

**What is NOT achievable in 6h:**

Phase 9 (Array conversion) requires Phase 3-8 to be complete first — all consumers must use integer ops before the tables lose string key access. Phase 9 is the 4-6h project on its own. The internOps activation (Phase 3.4) requires jzify and prepare both migrated — prepare alone has 148 sites. Realistic total time for Phases 0-9 fully complete: 20-30h of careful mechanical work with continuous test validation.

**Highest-value first order:**

1. `src/op.js` — foundational, no risk.
2. Dual-key tables — zero risk, enables incremental migration.
3. Hot emit.js guards — 6 sites, highest per-site throughput impact.
4. kind.js `BOOL_OPS.has` → `BOOL_RESULT[]` — eliminates one Set.has call from valTypeOf hot path.
5. jzify/ migration — prerequisite for activating internOps.
6. prepare/index.js 148 sites — prerequisite for full activation.
7. internOps activation.
8. ast.js ASSIGN_OPS/STMT_OPS → Uint8Arrays.
9. analyze.js, type.js, plan/\* — warm paths.
10. Phase 9 Array conversion — structural win, highest risk.

**First concrete file edits:**

`/Users/div/projects/jz/src/op.js` — create, ~130 lines. The OP enum, OP_INT, OP_NAME, BOOL_RESULT/ASSIGN_OP/STMT_OP Uint8Arrays, internOps function.

`/Users/div/projects/jz/src/compile/emit.js:2392` — after the emitter object literal, add:
```js
import { OP, OP_INT } from '../op.js'
for (const [str, id] of Object.entries(OP_INT)) {
  if (str in emitter) emitter[id] = emitter[str]
}
```

`/Users/div/projects/jz/src/kind.js:103` — after VT assignments, add integer aliases:
```js
import { OP_INT, BOOL_RESULT } from './op.js'
for (const [str, id] of Object.entries(OP_INT)) {
  if (VT[str] !== undefined) VT[id] = VT[str]
}
```

Then:
```js
// kind.js:37 — BEFORE: if (BOOL_OPS.has(op)) {
if (BOOL_RESULT[op]) {
```

These three edits — adding op.js, dual-keying emitter, dual-keying VT + replacing BOOL_OPS.has — are all safe, green-keeping, and non-atomic. They can be done first and committed in 1-2 hours, leaving the full pipeline in dual-mode ready for the rest of the migration.
---
## Validated ready-to-use src/ops.js (drop in at Phase 0 to resume)
```js
// === AST op tags — integer-tagged-union representation ===
// Generated canonical op vocabulary. The intern pass (prepare boundary) converts
// array node[0] from these op STRINGS to the integer tag; the compile half then
// dispatches via integer-indexed arrays (no per-node string-hash lookup in self-host).
// OP: string -> int (1-based; 0 reserved so a missing tag is falsy). OPS: int -> string.
export const OP = {
  "!": 1,
  "!=": 2,
  "!==": 3,
  "%": 4,
  "%=": 5,
  "&": 6,
  "&&": 7,
  "&&=": 8,
  "&=": 9,
  "(": 10,
  "()": 11,
  "*": 12,
  "**": 13,
  "*=": 14,
  "+": 15,
  "++": 16,
  "+=": 17,
  ",": 18,
  "-": 19,
  "--": 20,
  "-=": 21,
  ".": 22,
  "...": 23,
  "/": 24,
  "//": 25,
  "/=": 26,
  ";": 27,
  "<": 28,
  "<<": 29,
  "<<=": 30,
  "<=": 31,
  "=": 32,
  "==": 33,
  "===": 34,
  "=>": 35,
  ">": 36,
  ">=": 37,
  ">>": 38,
  ">>=": 39,
  ">>>": 40,
  ">>>=": 41,
  "?": 42,
  "?:": 43,
  "??": 44,
  "??=": 45,
  "[": 46,
  "[]": 47,
  "^": 48,
  "^=": 49,
  "async": 50,
  "await": 51,
  "bigint": 52,
  "block": 53,
  "bool": 54,
  "break": 55,
  "call": 56,
  "catch": 57,
  "const": 58,
  "continue": 59,
  "default": 60,
  "delete": 61,
  "export": 62,
  "finally": 63,
  "for": 64,
  "if": 65,
  "import": 66,
  "in": 67,
  "instanceof": 68,
  "label": 69,
  "let": 70,
  "nan": 71,
  "new": 72,
  "return": 73,
  "spread": 74,
  "str": 75,
  "strcat": 76,
  "switch": 77,
  "throw": 78,
  "typeof": 79,
  "u+": 80,
  "u-": 81,
  "void": 82,
  "while": 83,
  "yield": 84,
  "{": 85,
  "{}": 86,
  "|": 87,
  "|=": 88,
  "||": 89,
  "||=": 90,
  "~": 91,
}
export const OPS = [null, "!", "!=", "!==", "%", "%=", "&", "&&", "&&=", "&=", "(", "()", "*", "**", "*=", "+", "++", "+=", ",", "-", "--", "-=", ".", "...", "/", "//", "/=", ";", "<", "<<", "<<=", "<=", "=", "==", "===", "=>", ">", ">=", ">>", ">>=", ">>>", ">>>=", "?", "?:", "??", "??=", "[", "[]", "^", "^=", "async", "await", "bigint", "block", "bool", "break", "call", "catch", "const", "continue", "default", "delete", "export", "finally", "for", "if", "import", "in", "instanceof", "label", "let", "nan", "new", "return", "spread", "str", "strcat", "switch", "throw", "typeof", "u+", "u-", "void", "while", "yield", "{", "{}", "|", "|=", "||", "||=", "~"]
export const OP_COUNT = 92

// Intern pass: convert array node[0] from op-STRING to its integer tag, recursively.
// Runs once per node at the prepare boundary; downstream dispatch then indexes by int.
// Unknown op-strings (not in OP) are left as strings — dual-keyed tables + dual-form
// comparisons handle them until the final int-only (Array) phase. node[0]===null
// (numeric literal) is left null. Identifiers (bare strings at n[1+]) are untouched.
export const internOps = (n) => {
  if (!Array.isArray(n)) return n
  const t = n[0]
  if (typeof t === 'string') { const id = OP[t]; if (id !== undefined) n[0] = id }
  for (let i = 1; i < n.length; i++) if (Array.isArray(n[i])) internOps(n[i])
  return n
}
```

---
## SESSION STATE (intern GATED OFF — CI green, foundation laid)

DONE (byte-identical no-op while gated off; flip the 2 lines in src/compile/index.js:~1476 to activate):
- src/ops.js: OP (91 string→int), OPS (int→string), internOps pass — validated.
- Dual-keyed emitter (emit.js) + VT (kind.js); ctx.core.emit dual-key + dispatch fallback (gated).
- 1379 dual-form comparisons across 33 compile-half files (codemod: .work/codemod.mjs + run-codemod.mjs).
- switch(op)→switch(OPS[op]??op) (6 sites); .has(op)/.includes(op)→normalized arg (16 files).
- When ACTIVE: corpus byte-identical (fc9e6bc) — core compile correct — but suite 2392/2413.

REMAINING (the ~16 edge-case failures on activation — surgical per-construct work):
- class-static (7): `C.x`→0, `C.get()`→err. Class lowers to `(()=>{let C=fac; C.x=v; return C})()`
  (jzify/classes.js:314). Hand-written repros of this shape ALL work; the real class fails →
  a subtle inference/dispatch interaction not yet pinned (deepest lead: arrow params=null, but
  extractParams(null)=[] so that's a red herring). NOT a missed dual-form (sweep found 0 real misses).
- timers (6): compile OK; runtime/async behavior off — investigate timer module emit under int.
- JSON runtime schemas (1), minimal element-write target (1), IIFE-after-object semicolon (1),
  watr metacircular + compiled-compile.js (2: self-host — needs rebuilt dist/jz.wasm + check).
- CODEMOD CAVEAT: blind dual-form is over-broad — it added harmless false-positives like
  `c.kind === OP['default']` (c.kind is a param-classification, not an op). A surgical approach
  (per-construct, AST-aware) would be cleaner than the blind codemod for a real landing.

HONEST: blind-codemod got ~95% (byte-identical corpus) but the edge cases reveal it needs a
surgical implementation. Ceiling ~1.5-2.5pp. Not urgent. Phase-4 (Array-convert for the actual
perf) not started — only lands after all edge cases green + intern active.
