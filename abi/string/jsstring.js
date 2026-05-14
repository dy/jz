/**
 * abi/string/jsstring — string rep: native JS strings via JS String Builtins.
 *
 * Under this rep, JS string values flow across the wasm boundary as
 * `externref` instead of nanbox-tagged heap offsets. String operations
 * (`length`, `charCodeAt`, `concat`, `fromCharCode`, …) are emitted as calls
 * to imports from the `wasm:js-string` namespace — engine-provided builtins
 * that read/write the engine's native String representation directly.
 *
 *   - Spec: https://webassembly.github.io/js-string-builtins/js-api/
 *   - Engine support: V8 17+, Safari 18.4+, Firefox behind a flag.
 *
 * Wire shape (eventual):
 *   (import "wasm:js-string" "length"        (func ... (param externref) (result i32)))
 *   (import "wasm:js-string" "charCodeAt"    (func ... (param externref i32) (result i32)))
 *   (import "wasm:js-string" "concat"        (func ... (param externref externref) (result (ref extern))))
 *   (import "wasm:js-string" "fromCharCode"  (func ... (param i32) (result (ref extern))))
 *
 * Status — **architectural scaffold**, not a working codegen path yet.
 * Today this rep exists to:
 *   1. Slot into `abi/index.js` PRESETS so the dispatch infrastructure
 *      (preset selection, `jz:abi` section emit/sniff, driver routing) is
 *      exercised end-to-end with two distinct presets.
 *   2. Document the shape future string-codegen rerouting will plug into.
 *
 * Until string codegen (module/string.js, module/property.js, etc.) reads
 * from `ctx.abi.string.ops.<op>`, picking this rep produces wasm that's
 * byte-identical to nanbox output except for the `jz:abi` discriminant. The
 * mass-routing work that makes this rep observable lives in Step 5 of
 * `.work/todo.md`.
 *
 * @module abi/string/jsstring
 */

export default {
  // Wasm slot types a string value occupies. Today's nanbox-f64 number rep
  // implicitly uses `['f64']`; jsstring will declare `['externref']` once
  // the compiler signature synthesizer reads slotTypes.
  slotTypes: ['externref'],

  // Names of `wasm:js-string` imports this rep relies on. Used (eventually)
  // by the compiler to declare the import nodes once any op references them.
  imports: ['length', 'charCodeAt', 'concat', 'fromCharCode', 'substring',
            'codePointAt', 'compare', 'test', 'intoCharCodeArray', 'fromCharCodeArray'],

  // Op hooks — string operations the compiler will route through here once
  // module/string.js delegates to ctx.abi.string. Each hook receives the
  // operand IR(s) and returns the lowered wasm IR. Empty until the routing
  // sites land — the rep is currently inert.
  ops: {
    // length: (s) => ['call', '$jsstring_length', s],
    // charCodeAt: (s, i) => ['call', '$jsstring_charCodeAt', s, i],
    // concat: (a, b) => ['call', '$jsstring_concat', a, b],
    // fromCharCode: (n) => ['call', '$jsstring_fromCharCode', n],
  },

  // No peephole rules — string ops don't share the nanbox layout's
  // reinterpret/wrap surface, so there's nothing rep-specific to fold here.
  // (The nanbox-f64 number rep keeps its peephole hook; reps that don't
  // need one simply don't expose it.)
}
