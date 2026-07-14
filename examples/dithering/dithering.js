// Dithering — eight ways to render a smooth grayscale image with only black & white pixels.
// The subject is one BAS-RELIEF plate seen from straight above, lit by an orbiting light: a
// three-sided pyramid standing on it, sculpted LIPS embossed as a medallion (the classic
// atelier cast, drawn from arithmetic alone), a cube standing flat whose swinging cast shadow
// tells its height, a torus and a full sphere each sunk to their equator — all reduced to
// 1-bit by `mode`:
//   0 threshold · 1 random · 2 ordered Bayer 4×4 · 3 ordered Bayer 8×8 · 4 clustered-dot halftone
//   5 Floyd–Steinberg · 6 Jarvis–Judice–Ninke · 7 Atkinson
// The threshold/random/ordered/halftone passes are per-pixel; the three error-diffusion passes
// are inherently SEQUENTIAL — each pixel pushes its quantization error onto pixels not yet visited
// — a tight scalar sweep that jz turns into clean wasm. resize(w,h) → Uint32Array; frame(t,mode,shape).
// Everything is deterministic (the "random" mode is a per-pixel hash), so JS and jz match exactly.

let W = 0, H = 0, px
let gray            // Float64Array — continuous-tone source AND the error-diffusion work buffer
let hf              // Float64Array — per-frame heightfield of the relief plate (pixel units)
let sb              // Float64Array — shadow ceiling: the height sunlight clears above each pixel
let bayer4          // Int32Array(16) — 4×4 ordered-dither threshold matrix (values 0..15)
let bayer8          // Int32Array(64) — 8×8 dispersed-dot threshold matrix (values 0..63)
let halftone        // Int32Array(64) — 8×8 clustered-dot screen (ink grows as a dot from the centre)

export let resize = (w, h) => {
  W = w; H = h
  px = new Uint32Array(w * h)
  gray = new Float64Array(w * h)
  hf = new Float64Array(w * h)
  sb = new Float64Array(w * h)
  bayer4 = new Int32Array([
     0,  8,  2, 10,
    12,  4, 14,  6,
     3, 11,  1,  9,
    15,  7, 13,  5
  ])
  // Classic 8×8 Bayer matrix (recursive dispersed-dot), values 0..63.
  bayer8 = new Int32Array([
     0, 32,  8, 40,  2, 34, 10, 42,
    48, 16, 56, 24, 50, 18, 58, 26,
    12, 44,  4, 36, 14, 46,  6, 38,
    60, 28, 52, 20, 62, 30, 54, 22,
     3, 35, 11, 43,  1, 33,  9, 41,
    51, 19, 59, 27, 49, 17, 57, 25,
    15, 47,  7, 39, 13, 45,  5, 37,
    63, 31, 55, 23, 61, 29, 53, 21
  ])
  // Clustered-dot halftone screen: threshold lowest at each 8×8 tile's centre, rising outward, so
  // as a region darkens the ink fills from the centre into a growing dot — the newspaper look.
  halftone = new Int32Array(64)
  let i = 0
  while (i < 64) {
    let x = i % 8, y = (i / 8) | 0
    let fx = ((x + 0.5) / 8.0) * 2.0 - 1.0
    let fy = ((y + 0.5) / 8.0) * 2.0 - 1.0
    let v = Math.cos(Math.PI * fx) + Math.cos(Math.PI * fy)   // 2 at centre → −2 at corners
    halftone[i] = (((2.0 - v) / 4.0) * 63.0) | 0              // 0 at centre (fills first)
    i++
  }
  return px
}

// Deterministic per-pixel hash → [0,1): an integer scramble (i32 wraps identically in JS and jz),
// so "random" dithering is reproducible and JS/jz stay bit-exact.
let hash01 = (x, y) => {
  let h = (x * 1103515245 + 12345) ^ (y * 12820163 + 9301)
  h = h & 0x7fffffff
  return (h % 4096) / 4096.0
}

// x^0.75 via two chained sqrt() calls instead of Math.pow(x, 0.8-ish): every exponent here is
// exactly 0.5, the one fractional power jz folds to f64.sqrt and so is bit-identical to V8 by
// construction — a general Math.pow(x,y) is NOT guaranteed bit-exact across engines, and even a
// 1-ULP gap can flip a threshold decision that then cascades through the sequential
// error-diffusion passes below. Same gamma "family" as a 0.8 exponent (visually indistinguishable
// after dithering), but provably exact.
let pow75 = (d) => { let s = Math.sqrt(d); return s * Math.sqrt(s) }

// cos via exact range reduction + a fixed Taylor polynomial (u = x², Horner) — engine sin/cos
// differ from wasm's by an ULP, and the shadow sweep below would AMPLIFY a 1-ULP light tilt
// through its running max into visibly different dithers under error diffusion. floor, ÷, +, ×
// are all exactly-rounded in BOTH engines, so this cos is bit-identical everywhere by
// construction — and a light direction only needs ~1e-6 accuracy, which degree 14 gives on
// the reduced range. With it, the whole kernel is exact with NO tolerated-ULP exceptions.
let cosT = (x) => {
  let TAU = 6.283185307179586
  x = x - Math.floor(x / TAU) * TAU                     // → [0, 2π)
  if (x > 3.141592653589793) x = TAU - x                // cos(2π−x) = cos(x) → [0, π]
  let u = x * x
  return 1.0 + u * (-0.5 + u * (0.041666666666666664 + u * (-0.001388888888888889
    + u * (0.0000248015873015873 + u * (-2.755731922398589e-7 + u * (2.08767569878681e-9
    + u * -1.1470745597729725e-11))))))
}

// The lips of Michelangelo's David — REAL geometry: an orthographic depth map of the mouth,
// baked offline from Scan the World's photogrammetric scan of the full statue (Wikimedia
// Commons "File:David (Michelangelo).stl", CC BY-SA 4.0 — this derived table inherits that
// license; sculpture itself is PD). The bake rasterized 1.2M triangles at the face's azimuth,
// high-passed away the head's global curvature, zeroed the skin level and masked by the
// lips' own blurred silhouette (bytes are signed around 128 = plate, grooves below), so the fragment
// sits on the plate as a carved medallion. 76×39 texels, packed 4 per int, row-major.
const LP_W = 76, LP_H = 39
let LP = new Int32Array([-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,2139062400,2122219134,-2139127938,-2088598911,-2038004348,-2004318329,-1987475064,-2004318072,-2021095288,-2054846841,-2071690107,-2088533117,-2088533117,-2088533117,-2088533117,-2105376126,-2105376126,-2105376126,-2139062143,2088665216,2054781050,-2105508228,-1903523963,-1768581999,-1667524200,-1667392099,-1684366694,-1701012324,-1818913128,-1886350958,-1920103026,-1953723252,-1953789045,-1953723253,-1970632054,-1970632054,-2037872246,-2139061885,2038267776,2021028982,-2021425285,-1667853940,-1414945118,-1263358035,-1330465612,-1364349523,-1313688912,-1482052434,-1599953754,-1667457633,-1734763877,-1751672936,-1751607145,-1802201963,-1802201964,-1953459565,-2138995833,2021425024,2054648949,-1886813313,-1465738348,-1145522769,-993804099,-1111374908,-1145456198,-1044201283,-1195721280,-1330465610,-1448432466,-1549424984,-1600085598,-1616797280,-1667457634,-1684235108,-1886021222,-2138995575,2038267776,2138732407,-1802598269,-1347903077,-1027621706,-892745788,-1060845366,-1094927171,-943274815,-1060977209,-1195721282,-1330465610,-1465143889,-1532713561,-1549491037,-1616928607,-1633771617,-1869112420,-2138995575,2055044992,-2105705863,-1718383225,-1246845024,-926497860,-791621941,-993407537,-1044332607,-825505596,-926233394,-1060977466,-1212564546,-1380928587,-1498961750,-1532582234,-1566399581,-1616862815,-1852269410,-2138995574,2071822208,-2055177094,-1634233973,-1145787227,-808662590,-673786670,-926034987,-960183099,-724447799,-791489323,-926233394,-1094663226,-1313556293,-1465209938,-1498896216,-1532713819,-1600019805,-1835426401,-2138995574,2088664960,-2021491333,-1550019186,-1044794710,-707538999,-572662824,-824977188,-875902518,-606612530,-639968036,-791423530,-976696370,-1246118207,-1431523663,-1482053464,-1515870554,-1583176796,-1835426401,-2138995573,2088664960,-1987871108,-1482712944,-943736913,-589637937,-454761761,-723918877,-758066991,-488711723,-505158428,-639836449,-858729257,-1161837624,-1414614603,-1482053207,-1515805018,-1583176796,-1835426401,-2138995574,2088664960,-1954251140,-1415341165,-809058892,-438116649,-320083224,-589174806,-640100391,-353967651,-370479892,-471472409,-707142176,-1077622064,-1397705543,-1482118999,-1515870554,-1600019548,-1835426402,-2138995574,2071887744,-1937473925,-1331192171,-674380871,-286463776,-202116368,-403967757,-471735581,-252777754,-303107855,-353702933,-538712344,-993275175,-1380862018,-1515739223,-1532713819,-1616862557,-1852269411,-2138995574,2071822208,-1903853958,-1247043177,-522859840,-202182679,-118032908,-218761224,-286396945,-185273359,-319950862,-320017173,-404034324,-892085278,-1380730174,-1549424984,-1566399837,-1650483039,-1869112676,-2138995575,2055044992,-1887076999,-1129273958,-421604409,-202116371,-118033165,-100992262,-134744072,-168298248,-319950862,-303174420,-336728594,-757275672,-1397441081,-1599954010,-1616863072,-1667391841,-1886021222,-2138995831,2021425024,-1853522825,-994596194,-371008816,-185273362,-151718925,-50529544,-50463492,-151389188,-303107853,-286396948,-319951122,-656349719,-1414151987,-1667325788,-1667457892,-1701077860,-1902864488,-2138995832,1987805056,-1786283403,-893406813,-354099756,-168430353,-168495884,-33817865,-258,-151388930,-319950862,-286397204,-336728338,-639704089,-1447574320,-1768383841,-1718052969,-1751606887,-1919773290,-2138995833,1937407872,-1719175311,-859654488,-370942764,-168430353,-185338892,-50661387,-16843011,-185074948,-370414096,-320083223,-404034324,-757604637,-1497971507,-1886350951,-1802268016,-1802135915,-1953459308,-2139061626,1886944896,-1685687701,-910117206,-404628782,-202116371,-235802126,-101190414,-67306245,-252381191,-437786131,-387455515,-488183832,-925902883,-1599030334,-2038069362,-1869706360,-1852665198,-1970368367,-2139061626,1819770496,-1736218012,-977555034,-438380594,-252645397,-303173905,-168562450,-151521289,-319818763,-589372440,-505356579,-622927647,-1127952683,-1767395146,2088335489,-1937144448,-1886417010,-2004054386,-2139061627,1735753344,-1871094180,-1095456354,-539438905,-353703451,-437917719,-286529307,-252579088,-471274257,-892677669,-707538739,-825109804,-1380531767,2090442918,1953458536,-2004582278,-1936946038,-2020963188,-2139061884,1651801728,-2140713391,-1331324273,-741620806,-606216744,-875834921,-471935025,-420943642,-841424925,-1212761920,-977027142,-1128349245,-1750946377,1517784206,1886020445,-2055111305,-1970632312,-2037871990,-2139061885,1584561536,1732524358,-1702068106,-1095258203,-960051260,-1145060924,-876365128,-841887025,-1178680633,-1179207753,-1044201797,-1178812480,-1784632396,1516798859,1886020445,-2088797322,-2004383867,-2054781048,-2139061886,1534164352,908602945,-1955371435,-1263820138,-1044201286,-1161903935,-1162300233,-1195853640,-1212763470,-1044530247,-943142972,-1044003128,-1616202821,1634896791,1869309281,-2139260299,-2054847357,-2088467067,-2139062142,1534164352,740765506,-2039393727,-1263754860,-960052036,-1027357243,-1229341505,-1263225676,-1095059275,-876034879,-758001458,-875638574,-1380532539,1787009957,1902995815,2138863989,-2088533375,-2105310333,-2139062143,1551007104,774320196,-1837144760,-1095390304,-808530746,-892547634,-1111374648,-1145390405,-960315459,-758133559,-623257643,-757737255,-1178614067,1955177393,1919970669,2122020981,-2105441921,-2122153342,-2139062144,1584561536,975778118,-1668516007,-977423191,-690563891,-774646571,-993539378,-1044332351,-876034621,-673918514,-539042598,-673456674,-1060581934,2055971251,1953722995,2105243766,-2122284930,-2138996351,-2139062144,1601404288,1144075079,-1533771676,-876365136,-606348845,-707274277,-909324334,-976894522,-808662585,-606546478,-488447778,-606150174,-1077161001,2139987631,1987474808,2105244023,-2139062402,-2139062144,-2139062144,1635024512,1194801482,-1500349600,-825835852,-555819818,-673522467,-858861100,-926431031,-774976567,-572860460,-454761760,-572398620,-1228615465,-2121491544,2004383867,2105309816,-2139127938,-2139062144,-2139062145,1668644480,1228684622,-1668779427,-808993361,-538976809,-639902242,-841952298,-909522485,-758133557,-556017451,-454761503,-639573020,-1363622705,-2104780893,2038069884,2105310074,-2139127938,2139127936,-2139062145,1719041664,1279345490,-1904317349,-876563809,-555820333,-623059490,-825109289,-875836468,-774976052,-572860717,-522067746,-892019745,-1481656126,-2104847458,2071755901,2122153083,-2139127937,2139127936,-2139062145,1769438848,1330071895,-2055771813,-1179869038,-623390266,-639968293,-841886762,-943142196,-892876856,-758001716,-808332590,-1144928307,-1599623500,-2104979303,2105376126,2122218877,-2139062401,-2139062144,-2139062144,1819836288,1380732764,2121492316,-1482779511,-994002255,-892614201,-1161837368,-1431523147,-1347638615,-1212762958,-1145259335,-1347176776,-1683970646,-2105045611,2122284671,2138996350,-2139062401,-2139062144,-2139062144,1870299008,1448170849,2037409373,-1667986301,-1364415837,-1397837905,-1650350422,-1886284648,-1718316657,-1516068708,-1398036057,-1515672917,-1768251742,-2105111663,2139127936,2139062143,-2139062145,-2139062144,-2139062144,1920696192,1498831461,1986880862,-1819507330,-1600086375,-1700946272,-1987145066,1987673732,-2038400393,-1751871349,-1600152423,-1650483296,-1852467302,-2105177715,-2138996351,2139062144,-2139062144,-2139062144,-2139062144,1954316160,1549426537,1936483680,-1937342342,-1785293423,-1936748141,2038334344,1768648307,1970301800,-1953987972,-1785425265,-1785293162,-1919970925,-2105243766,-2122153342,-2139062144,-2139062144,-2139062144,-2139062144,2004713344,1684301679,1936616038,-2055111560,-1970566264,-2122021240,1920301437,1819176816,1886285164,-2105640588,-1970763899,-1936946037,-2021029237,-2105310074,-2105310334,-2139062143,-2139062144,-2139062144,-2139062144,2071888000,1886417527,2004185969,-2139194246,-2088532862,2105442433,2004318586,2004318071,2038004088,2122152826,-2105442177,-2071690109,-2088532860,-2105376126,-2122153342,-2139062143,-2139062144,-2139062144,-2139062144,2139127936,2071755901,2105375868,-2139128194,-2139062144,2122284928,2122219134,2138996350,2139062143,-2139062145,-2139062144,-2122219136,-2122219135,-2122284927,-2138996351,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144,-2139062144])

// unpack one texel (0..255) + bilinear sampler over the packed table, clamped at the rim —
// pure integer unpacks and f64 mixes, bit-exact across JS and jz
let lpPx = (ix, iy) => {
  let idx = iy * LP_W + ix
  return (LP[idx >> 2] >>> ((idx & 3) << 3)) & 255
}
let lpSample = (u, v) => {
  let iu = u | 0, iv = v | 0
  let iu1 = iu + 1; if (iu1 > LP_W - 1) iu1 = LP_W - 1
  let iv1 = iv + 1; if (iv1 > LP_H - 1) iv1 = LP_H - 1
  let fu = u - iu, fv = v - iv
  return (lpPx(iu, iv) * (1.0 - fu) + lpPx(iu1, iv) * fu) * (1.0 - fv)
    + (lpPx(iu, iv1) * (1.0 - fu) + lpPx(iu1, iv1) * fu) * fv
}

// Continuous-tone source image to be dithered — a BAS-RELIEF plate seen from DIRECTLY ABOVE,
// lit by one ORBITING light (in-plane azimuth circles with t, elevation fixed). Every subject
// is a true HEIGHTFIELD z(x,y) standing on the plate, and ONE engine renders them all:
//   · surface normal from the height gradient (central differences) → n·light raking shade
//   · a real CAST SHADOW from an O(N) horizon sweep over the same heightfield — hard at the
//     contact, melting away toward its tip, swinging as the light orbits. Every subject
//     self-shadows too: the lips shade their own hollows, the torus bowl its far rim.
//   · curvature accents — convex breaks (ridges, rims, the lip line) draw themselves as fine
//     dark lines, and steep walls press a thin contact seam into the plate around each subject.
// Subjects: 0 = three-sided pyramid standing on the plate · 1 = the lips of Michelangelo's David
// (real scan geometry) embossed as a medallion · 2 = cube standing flat on the plate (only its square top face is visible from
// above — the LONG shadow, side ≈ its length, is what says "cube") · 3 = torus sunk to its
// tube's equator · 4 = full sphere sunk to its equator.
let source = (t, shape) => {
  let lpx = cosT(t * 0.6), lpy = cosT(t * 0.6 - 1.5707963267948966)   // orbiting light azimuth
  let LEL = 0.62                                          // light elevation as a slope (rise/run)
  let sh = shape | 0
  let cx = W * 0.5, cy = H * 0.5
  let PS = (W < H ? W : H) * 0.5                          // plate scale: half the short side, px

  // ---- pass 1: build the heightfield (pixel units, so gradients are dimensionless slopes) ----
  let zmax = 1.0                 // tallest point, px — normalizes the height lift in shading
  if (sh === 0) {
    // Three-sided pyramid: equilateral triangle base, apex over the centroid. Height at any
    // inside point is set by the nearest base edge — that IS the plane of the face above it,
    // so the three faces come out perfectly flat and their ridges perfectly straight.
    let Rt = 0.62 * PS, hA = 0.55 * PS, inr = 0.5 * Rt
    let pcy = cy + 0.04 * PS
    let axp = 0.0, ayp = -Rt
    let bxp = -0.8660254037844386 * Rt, byp = 0.5 * Rt
    let cxp = 0.8660254037844386 * Rt, cyp = 0.5 * Rt
    let eLen = 1.7320508075688772 * Rt                    // all three edges are √3·Rt long
    let hs = hA / inr                                     // face slope: apex height per inradius
    zmax = hA
    let py = 0
    while (py < H) {
      let dy = py - pcy
      let qx = 0
      while (qx < W) {
        let dx = qx - cx
        let e1 = (bxp - axp) * (dy - ayp) - (byp - ayp) * (dx - axp)
        let e2 = (cxp - bxp) * (dy - byp) - (cyp - byp) * (dx - bxp)
        let e3 = (axp - cxp) * (dy - cyp) - (ayp - cyp) * (dx - cxp)
        let eMax = e1
        if (e2 > eMax) eMax = e2
        if (e3 > eMax) eMax = e3
        let z = -eMax / eLen * hs
        hf[py * W + qx] = z > 0.0 ? z : 0.0
        qx++
      }
      py++
    }
  } else if (sh === 1) {
    // The lips of David — the real depth map (see the LP table above) laid on the plate as a
    // medallion. The bake's feathered borders blend to plate height 0 on their own.
    let lw = 0.62 * (W < 1.55 * H ? W : 1.55 * H)         // fragment width — fits any aspect
    let lh = lw * 39.0 / 76.0
    let sxm = (LP_W - 1) / lw, sym = (LP_H - 1) / lh
    let lx0 = cx - lw * 0.5, ly0 = cy - lh * 0.5
    zmax = 0.13 * lw
    let zs = zmax / 127.0                                 // bytes are SIGNED around 128 = plate
    let py = 0
    while (py < H) {
      let v = (py - ly0) * sym
      let qx = 0
      while (qx < W) {
        let z = 0.0
        if (v >= 0.0 && v <= LP_H - 1) {
          let u = (qx - lx0) * sxm
          if (u >= 0.0 && u <= LP_W - 1) z = (lpSample(u, v) - 128.0) * zs
        }
        hf[py * W + qx] = z
        qx++
      }
      py++
    }
  } else if (sh === 2) {
    // Cube standing flat on the plate, seen from straight above: only the square top face is
    // visible — its four beveled edges catch the orbiting light (bright toward it, dark away),
    // and the LONG cast shadow (the block is as tall as it is wide) swings around it.
    let a = 0.40 * PS, hC = 0.80 * PS
    let bev = 0.055 * PS, bevH = 0.10 * PS
    zmax = hC
    let py = 0
    while (py < H) {
      let dy = py - cy; if (dy < 0.0) dy = -dy
      let qx = 0
      while (qx < W) {
        let dx = qx - cx; if (dx < 0.0) dx = -dx
        let dm = dx > dy ? dx : dy
        let z = 0.0
        if (dm < a) {
          z = hC
          let dE = a - dm
          if (dE < bev) z = hC - (1.0 - dE / bev) * bevH
        }
        hf[py * W + qx] = z
        qx++
      }
      py++
    }
  } else if (sh === 3) {
    // Torus lying flat, sunk to its tube's equator: an annulus bulging out of the plate.
    let Router = 0.62 * PS, Rinner = 0.30 * PS
    let Rmid = (Router + Rinner) * 0.5, tubeR = (Router - Rinner) * 0.5
    zmax = tubeR
    let py = 0
    while (py < H) {
      let dy = py - cy
      let qx = 0
      while (qx < W) {
        let dx = qx - cx
        let r = Math.sqrt(dx * dx + dy * dy) - Rmid
        let s = tubeR * tubeR - r * r
        hf[py * W + qx] = s > 0.0 ? Math.sqrt(s) : 0.0
        qx++
      }
      py++
    }
  } else {
    // A full sphere sunk to its equator: a hemispheric dome flush in the plate.
    let R = 0.60 * PS
    zmax = R
    let py = 0
    while (py < H) {
      let dy = py - cy
      let qx = 0
      while (qx < W) {
        let dx = qx - cx
        let s = R * R - dx * dx - dy * dy
        hf[py * W + qx] = s > 0.0 ? Math.sqrt(s) : 0.0
        qx++
      }
      py++
    }
  }

  // ---- pass 1.5: shadow ceiling — the classic O(N) terrain-shadow horizon sweep. Walk the
  // grid AWAY from the light, one row (or column, whichever axis the azimuth leans on) at a
  // time: each pixel's ceiling is its own height, or the light-side neighbour's ceiling
  // dropped by the light's slope over one step — whichever is higher. sb−hf is then exactly
  // how far below the sunlight line each pixel sits: 0 in the open, large in deep shade.
  // The light-side neighbour lies at a fractional position, so read it with a 2-tap linear
  // interpolation from the already-swept row — pure add/mul/max, bit-exact in JS and jz.
  let adx = lpx < 0.0 ? -lpx : lpx, ady = lpy < 0.0 ? -lpy : lpy
  if (ady >= adx) {
    let offX = lpx / ady                   // x drift toward the light per row step
    let drop = LEL / ady                   // ceiling drop per row step (path length 1/ady)
    let rs = lpy >= 0.0 ? 1 : -1           // row step TOWARD the light
    let y = lpy >= 0.0 ? H - 1 : 0
    let yEnd = lpy >= 0.0 ? -1 : H
    while (y !== yEnd) {
      let ys = y + rs
      let row = y * W
      let x = 0
      if (ys < 0 || ys > H - 1) {
        while (x < W) { sb[row + x] = hf[row + x]; x++ }
      } else {
        let srow = ys * W
        while (x < W) {
          let xs = x + offX
          if (xs < 0.0) xs = 0.0
          if (xs > W - 1) xs = W - 1
          let xi = xs | 0
          let xi1 = xi + 1; if (xi1 > W - 1) xi1 = W - 1
          let xf = xs - xi
          let c = sb[srow + xi] * (1.0 - xf) + sb[srow + xi1] * xf - drop
          let z = hf[row + x]
          sb[row + x] = c > z ? c : z
          x++
        }
      }
      y = y - rs
    }
  } else {
    let offY = lpy / adx                   // y drift toward the light per column step
    let drop = LEL / adx
    let cs = lpx >= 0.0 ? 1 : -1           // column step TOWARD the light
    let x = lpx >= 0.0 ? W - 1 : 0
    let xEnd = lpx >= 0.0 ? -1 : W
    while (x !== xEnd) {
      let xsrc = x + cs
      let y = 0
      if (xsrc < 0 || xsrc > W - 1) {
        while (y < H) { sb[y * W + x] = hf[y * W + x]; y++ }
      } else {
        while (y < H) {
          let ysf = y + offY
          if (ysf < 0.0) ysf = 0.0
          if (ysf > H - 1) ysf = H - 1
          let yi = ysf | 0
          let yi1 = yi + 1; if (yi1 > H - 1) yi1 = H - 1
          let yf = ysf - yi
          let c = sb[yi * W + xsrc] * (1.0 - yf) + sb[yi1 * W + xsrc] * yf - drop
          let z = hf[y * W + x]
          sb[y * W + x] = c > z ? c : z
          y++
        }
      }
      x = x - cs
    }
  }

  // ---- pass 2: one relief engine for every subject — normals, raking light, cast shadow ----
  let invZ = 1.0 / zmax
  let invSoft = 1.0 / (0.045 * PS)         // penumbra scale: how much ceiling reads as full shade
  let seamZ = 1.0 / (0.05 * PS)            // contact seams live below this height
  let py = 0
  while (py < H) {
    let qx = 0
    while (qx < W) {
      let i = py * W + qx
      let z = hf[i]
      // central-difference gradient (clamped at the frame border)
      let gl = hf[qx > 0 ? i - 1 : i], gr = hf[qx < W - 1 ? i + 1 : i]
      let gu = hf[py > 0 ? i - W : i], gd = hf[py < H - 1 ? i + W : i]
      let gx = (gr - gl) * 0.5, gy = (gd - gu) * 0.5
      let inv = 1.0 / Math.sqrt(1.0 + gx * gx + gy * gy)
      let d = (LEL - gx * lpx - gy * lpy) * inv            // n·light with n = (−gx,−gy,1)/|·|
      if (d < 0.0) d = 0.0
      let zn = z * invZ
      if (zn < 0.0) zn = 0.0
      if (zn > 1.0) zn = 1.0
      // plate sheen leaning toward the light + height lift + raking shade
      let lum = 0.075 + 0.10 * (qx / W - 0.5) * lpx + 0.10 * (0.5 - py / H) * lpy
        + 0.04 * (qx / W + 1.0 - py / H)
        + 0.18 * zn + 0.62 * pow75(d) * (0.5 + 0.5 * zn)
      // curvature accent: convex breaks (ridges, rims, the lip line) draw as fine dark lines
      let lap = gl + gr + gu + gd - 4.0 * z
      if (lap < 0.0) {
        let cvv = -lap * 0.55; if (cvv > 1.0) cvv = 1.0
        lum = lum * (1.0 - 0.30 * cvv)
      }
      // contact seam: steep walls press a thin dark line into the plate around each subject
      let wA = 1.0 - z * seamZ
      if (wA > 0.0) {
        let ao = (gx * gx + gy * gy) * 1.4; if (ao > 1.0) ao = 1.0
        lum = lum * (1.0 - 0.30 * wA * ao)
      }
      // cast shadow: how far below the swept sunlight ceiling this pixel sits. The ceiling
      // decays at the light's slope, so shadows are hard at the contact and melt away at the
      // tip — and every subject self-shadows for free (the lips shade their own hollows, the
      // torus bowl catches its far rim's shade).
      let sraw = sb[i] - z - 0.8
      if (sraw > 0.0) {
        let s1 = sraw * invSoft
        if (s1 > 1.0) s1 = 1.0
        lum = lum * (1.0 - 0.52 * s1)
      }
      gray[i] = lum
      qx++
    }
    py++
  }
}

let putBW = (idx, on) => {
  let v = on ? 255 : 0
  px[idx] = (255 << 24) | (v << 16) | (v << 8) | v
}

export let frame = (t, mode, shape) => {
  source(t, shape)
  let md = mode | 0
  let n = W * H

  if (md === 0) {
    // Threshold at 50% — pure black/white, no spatial dither
    let i = 0
    while (i < n) { putBW(i, gray[i] >= 0.5 ? 1 : 0); i++ }
  } else if (md === 1) {
    // Random — threshold against a per-pixel hash (white-noise dither, the naive baseline)
    let py = 0
    while (py < H) {
      let qx = 0
      while (qx < W) { let idx = py * W + qx; putBW(idx, gray[idx] >= hash01(qx, py) ? 1 : 0); qx++ }
      py++
    }
  } else if (md === 2 || md === 3 || md === 4) {
    // Ordered — compare each pixel to a tiled threshold screen: Bayer 4×4, Bayer 8×8, or the
    // clustered-dot halftone. (One loop, three screens — the matrix + tile mask differ only.)
    let py = 0
    while (py < H) {
      let qx = 0
      while (qx < W) {
        let idx = py * W + qx
        let thr = md === 2 ? (bayer4[(py & 3) * 4 + (qx & 3)] + 0.5) / 16.0
          : md === 3 ? (bayer8[(py & 7) * 8 + (qx & 7)] + 0.5) / 64.0
          : (halftone[(py & 7) * 8 + (qx & 7)] + 0.5) / 64.0
        putBW(idx, gray[idx] >= thr ? 1 : 0)
        qx++
      }
      py++
    }
  } else if (md === 5) {
    // Floyd–Steinberg — push the quantization error to 4 forward neighbours (7,3,5,1)/16
    let py = 0
    while (py < H) {
      let qx = 0
      while (qx < W) {
        let idx = py * W + qx
        let old = gray[idx]
        let on = old >= 0.5 ? 1 : 0
        let err = old - on
        if (qx + 1 < W) gray[idx + 1] = gray[idx + 1] + err * 0.4375
        if (py + 1 < H) {
          if (qx > 0) gray[idx + W - 1] = gray[idx + W - 1] + err * 0.1875
          gray[idx + W] = gray[idx + W] + err * 0.3125
          if (qx + 1 < W) gray[idx + W + 1] = gray[idx + W + 1] + err * 0.0625
        }
        putBW(idx, on)
        qx++
      }
      py++
    }
  } else if (md === 6) {
    // Jarvis–Judice–Ninke — a wider 12-neighbour diffusion (/48) → smoother gradients, less texture
    let py = 0
    while (py < H) {
      let qx = 0
      while (qx < W) {
        let idx = py * W + qx
        let old = gray[idx]
        let on = old >= 0.5 ? 1 : 0
        let e = (old - on) / 48.0
        if (qx + 1 < W) gray[idx + 1] = gray[idx + 1] + e * 7.0
        if (qx + 2 < W) gray[idx + 2] = gray[idx + 2] + e * 5.0
        if (py + 1 < H) {
          let r = idx + W
          if (qx - 2 >= 0) gray[r - 2] = gray[r - 2] + e * 3.0
          if (qx - 1 >= 0) gray[r - 1] = gray[r - 1] + e * 5.0
          gray[r] = gray[r] + e * 7.0
          if (qx + 1 < W) gray[r + 1] = gray[r + 1] + e * 5.0
          if (qx + 2 < W) gray[r + 2] = gray[r + 2] + e * 3.0
        }
        if (py + 2 < H) {
          let r = idx + 2 * W
          if (qx - 2 >= 0) gray[r - 2] = gray[r - 2] + e * 1.0
          if (qx - 1 >= 0) gray[r - 1] = gray[r - 1] + e * 3.0
          gray[r] = gray[r] + e * 5.0
          if (qx + 1 < W) gray[r + 1] = gray[r + 1] + e * 3.0
          if (qx + 2 < W) gray[r + 2] = gray[r + 2] + e * 1.0
        }
        putBW(idx, on)
        qx++
      }
      py++
    }
  } else {
    // Atkinson — spread only 6/8 of the error to 6 neighbours (1/8 each) → airier, higher contrast
    let py = 0
    while (py < H) {
      let qx = 0
      while (qx < W) {
        let idx = py * W + qx
        let old = gray[idx]
        let on = old >= 0.5 ? 1 : 0
        let err = (old - on) * 0.125
        if (qx + 1 < W) gray[idx + 1] = gray[idx + 1] + err
        if (qx + 2 < W) gray[idx + 2] = gray[idx + 2] + err
        if (py + 1 < H) {
          if (qx > 0) gray[idx + W - 1] = gray[idx + W - 1] + err
          gray[idx + W] = gray[idx + W] + err
          if (qx + 1 < W) gray[idx + W + 1] = gray[idx + W + 1] + err
        }
        if (py + 2 < H) gray[idx + 2 * W] = gray[idx + 2 * W] + err
        putBW(idx, on)
        qx++
      }
      py++
    }
  }
}
