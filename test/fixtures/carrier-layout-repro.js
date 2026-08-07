// Fixture for test/pointers.js's carrier-box "boxed schema field" pin
// (.work/carrier-representation-design.md §15). Imports the REAL layout.js
// (not a hand-mimicked shape — round-3/§13's own lesson: a mimic doesn't
// reproduce this class of bug) so `LAYOUT`'s real many-call-site i64Hex/
// atomNanHex family and its real needsDynShadow-eligible export shape are
// both exercised exactly as scripts/self.js's own module graph exercises
// them.
import { LAYOUT, PTR, i64Hex, atomNanHex, ptrBits } from '../../layout.js'
export let rawField = () => LAYOUT.NAN_PREFIX_BITS
export let undefAtom = () => atomNanHex(2)
export let nullAtom = () => atomNanHex(1)
export let ptrHex = () => i64Hex(ptrBits(PTR.OBJECT, 3, 1024))
