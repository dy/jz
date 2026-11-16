// Fixture for test/pointers.js's carrier-box "CONSERVATIVE PAIRING" pin. Same
// shape as carrier-layout-repro.js (the REAL layout.js, not a hand-mimicked
// one) PLUS a `corrupt` helper whose `obj[key] = val` (unresolvable
// receiver/key) trips `collectSlotWriteHazards`'s `pointsTo==='ALL'` blanket
// exactly the way the real self-hosted `scripts/self.js` compile does.
import { LAYOUT, PTR, i64Hex, atomNanHex, ptrBits } from '../../layout.js'
function corrupt(obj, key, val) { obj[key] = val }
export let poke = () => { const o = { z: 1 }; corrupt(o, 'z', 'x'); return 0 }
export let rawField = () => LAYOUT.NAN_PREFIX_BITS
export let undefAtom = () => atomNanHex(2)
export let nullAtom = () => atomNanHex(1)
export let ptrHex = () => i64Hex(ptrBits(PTR.OBJECT, 3, 1024))
