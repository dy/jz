// Fixture for test/pointers.js's carrier-box "CONSERVATIVE PAIRING" pin
// (.work/carrier-representation-design.md — the §15/§16/§17-21 chain's
// closing move). Same shape as carrier-layout-repro.js (the REAL layout.js,
// not a hand-mimicked one — round-3/§13's own lesson) PLUS a `corrupt`
// helper whose `obj[key] = val` (unresolvable receiver/key) trips
// `collectSlotWriteHazards`'s `hz.all` blanket exactly the way the real
// self-hosted `scripts/self.js` compile does (§16/§17's own diagnosis) —
// so `LAYOUT`'s own schema NEVER reaches `slotBigintProven` here, only
// `slotBigintBoxed` (write-side, fail-open, unaffected by hz.all). This is
// the isolated repro for the class §16 could only close the PROVEN half of.
import { LAYOUT, PTR, i64Hex, atomNanHex, ptrBits } from '../../layout.js'
function corrupt(obj, key, val) { obj[key] = val }
export let poke = () => { const o = { z: 1 }; corrupt(o, 'z', 'x'); return 0 }
export let rawField = () => LAYOUT.NAN_PREFIX_BITS
export let undefAtom = () => atomNanHex(2)
export let nullAtom = () => atomNanHex(1)
export let ptrHex = () => i64Hex(ptrBits(PTR.OBJECT, 3, 1024))
