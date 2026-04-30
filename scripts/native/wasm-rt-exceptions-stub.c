/*
 * A1: minimal exception stub for trap-only mode.
 *
 * Watr's wasm has 5 `throw` (in err() paths) and ZERO `try` blocks. So:
 * - wasm_rt_throw never has a wasm-level catcher; it always escapes to the host.
 * - wasm_rt_load_exception's payload is never read (no `(catch_all_ref)` etc).
 * - wasm_rt_set_unwind_target / get_unwind_target are dead.
 *
 * Replace with the smallest possible code: throw → trap directly. The harness's
 * outer WASM_RT_SETJMP catches the trap and returns. Removes:
 *   - 3 TLS reads/writes per throw (g_active_exception_*)
 *   - 1 TLS load per throw (g_unwind_target)
 *   - 256-byte TLS exception buffer
 *   - The level of indirection through g_unwind_target → longjmp
 *
 * Pre-condition: source has no `try { ... } catch { ... }` reachable at runtime.
 */

#include "wasm-rt.h"
#include "wasm-rt-exceptions.h"

WASM_RT_NO_RETURN void wasm_rt_throw(void) {
  wasm_rt_trap(WASM_RT_TRAP_UNCAUGHT_EXCEPTION);
}

void wasm_rt_load_exception(const wasm_rt_tag_t tag,
                            uint32_t size,
                            const void* values) {
  (void)tag; (void)size; (void)values;
}

WASM_RT_UNWIND_TARGET* wasm_rt_get_unwind_target(void) { return NULL; }
void wasm_rt_set_unwind_target(WASM_RT_UNWIND_TARGET* target) { (void)target; }
wasm_rt_tag_t wasm_rt_exception_tag(void) { return NULL; }
uint32_t wasm_rt_exception_size(void) { return 0; }
void* wasm_rt_exception(void) { return NULL; }
