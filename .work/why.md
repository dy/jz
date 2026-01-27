# Why jz Exists

## The Pain

JS has too much:
- Implicit globals (`Math`, `console`, `JSON` - where do they come from?)
- Legacy syntax (`var`, `function`, `this`, `class`, `prototype`)
- Runtime surprises (coercion, hoisting, `==` vs `===`)
- No compilation (can't catch errors until runtime)

I want **JS as it should have been**:
- Explicit imports for everything
- Clean functional syntax only
- Compile-time errors
- Runs at native speed (WASM)

```js
// jz: everything explicit
import { sin, PI } from 'math'
export let tone = t => sin(t * 440 * PI * 2 / 44100)
```

## The Identity

**jz = Crockford's safe JS subset → WASM**

Not "JS compatibility". Not "JS subset".
**JS as it was supposed to be. JavaScript Zero**

| JS | jz |
|----|-----|
| Implicit `Math.sin` | `import { sin } from 'math'` |
| Implicit `console.log` | `import { log } from 'console'` |
| Implicit `JSON.parse` | `import { parse } from 'json'` |
| `var`, hoisting | `let`, `const` only |
| `function`, `this` | Arrow functions only |
| `class`, `new Foo()` | Plain objects, composition |
| `==` coercion | `==` means `===` |
| Runtime errors | Compile-time errors |

## The Architecture

```
┌────────────────────────────────────────────────┐
│                  user code                     │
│  import { sin } from 'math'                    │
│  export let f = t => sin(t * 440)              │
└────────────────────────────────────────────────┘
                      │
                      ▼
┌────────────────────────────────────────────────┐
│                 jz compiler                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │  parse    │→│ analyze  │→ │ compile  │      │
│  │(subscript)│ │  scope   │  │   WAT    │      │
│  └──────────┘  └──────────┘  └──────────┘      │
│                      ↑                         │
│              ┌───────┴───────┐                 │
│              │   prelude     │                 │
│              │ (math, array, │                 │
│              │  string, etc) │                 │
│              └───────────────┘                 │
└────────────────────────────────────────────────┘
                      │
                      ▼
┌────────────────────────────────────────────────┐
│                   WASM                         │
└────────────────────────────────────────────────┘
```

### Preludes (importable capabilities)

| Prelude | Provides | Compiles to |
|---------|----------|-------------|
| `math` | sin, cos, sqrt, PI, E... | WASM f64 ops + stdlib |
| `array` | map, filter, reduce... | inline WASM loops |
| `string` | slice, indexOf, split... | WASM string ops |
| `console` | log, warn, error | WASM imports (host) |
| `json` | parse, stringify | WASM JSON codec |

### Compiler options

```js
import { compile } from 'jz'

// Minimal: no preludes, pure numeric
compile(code)

// With preludes
compile(code, { preludes: ['math', 'array'] })

// JS-compat mode: implicit globals (escape hatch)
compile(code, { implicit: true })
```

## Who Benefits

**Me.** I am the user.

- Floatbeat formulas (clean audio DSL)
- Mridanga tools (metronome, drones, mantra player)
- color-space → WASM
- piezo (music DSL) compiles through jz
- subscript, watr self-hosting

**Others who want:**
- Principled JS without the cruft
- Formulas that compile to WASM
- Explicit, auditable code (no hidden globals)
- Educational: "this is what JS should look like"

## The Stack

```
┌─────────────────────────────────────┐
│  mridanga / floatbeat / piezo       │  ← offerings
├─────────────────────────────────────┤
│            jz                       │  ← JS done right → WASM
├─────────────────────────────────────┤
│     subscript │ watr                │  ← parse │ assemble
└─────────────────────────────────────┘
```

---

# Roadmap

## Phase 1: Explicit Imports Architecture

**Deliverable**: jz with no implicit globals

* [ ] Remove all implicit globals from core
* [ ] Define prelude interface
* [ ] Implement `import { x } from 'prelude'` resolution
* [ ] Core preludes: math, array, string
* [ ] Optional preludes: console, json, set, map
* [ ] `implicit: true` option for JS-compat mode

**Value**: Principled foundation. No magic.

---

## Phase 2: Ship Floatbeat

**Deliverable**: Single HTML page, works in browser

* [ ] Formula editor
* [ ] Play/stop
* [ ] Waveform display
* [ ] 10 preset formulas
* [ ] Share via URL

**Value**: Proves the architecture. Demonstrates the value.

---

## Phase 3: Mridanga Tools

* [ ] **Metronome**: Taal patterns, tempo, visual beat
* [ ] **Drone**: Sa-Pa-Sa, pitch control, harmonics
* [ ] **Mantra**: Syllable-to-sound mapping

**Value**: Real tools I use daily.

---

## Phase 4: color-space/wasm

**Value**: Validates non-audio use case.

---

## Phase 5: piezo Foundation

```
piezo: t ~ 440hz |> sin |> *0.5
  ↓
jz: import { sin } from 'math'
    export let f = t => sin(t * 440 * PI * 2 / sr) * 0.5
  ↓
WASM
```

**Value**: The vision realized.

---

## Phase 6: Plugin Architecture (if needed)

Only if piezo needs features beyond preludes:

* [ ] Custom operators (piezo's `|>`, `~`)
* [ ] Custom syntax (units: `440hz`)
* [ ] Plugin interface for subscript extensions

---

# Success Criteria

- [ ] `import { sin } from 'math'` works
- [ ] No implicit globals by default
- [ ] Floatbeat playground running
- [ ] Mridanga metronome I use daily
- [ ] color-space/wasm published
- [ ] piezo → jz → WASM pipeline
- [ ] Code < 3K lines core

---

# What jz Is

**JS as it should have been:**
- Explicit over implicit
- Functional over OOP
- Compile-time over runtime
- Native speed (WASM)

**Crockford's vision, realized:**
- The Good Parts, nothing else
- No `this`, no `class`, no `var`
- No coercion, no hoisting
- Safe, predictable, fast

---

# What jz Is NOT

- Not trying to run arbitrary JS
- Not competing on compatibility
- Not a transpiler (output is WASM, not JS)
- Not seeking mass adoption

---

# The Offering

The offering is not jz itself.

The offering is:
- **Floatbeat** — audio formula playground
- **Mridanga tools** — practice instruments
- **piezo** — the music DSL
- **A vision** — JS done right, for those who care

jz is the foundation. Clean, explicit, principled.
