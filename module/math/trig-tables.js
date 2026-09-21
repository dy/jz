/** Shared coefficients and reduction constants for scalar/f64x2 math and folding.
 *  Trig coefficients are fitted by scripts/minimax-trig.mjs; each consumer
 *  evaluates the same table in the same order. */

// Reduced-interval absolute-error target: < 1e-11.
// sin(r)/r and cos(r) on the reduced range |r| <= pi/2, as their Maclaurin
// series with EXACT 1/n! coefficients — ten terms for sin and eleven for cos,
// the lengths that land within a few ulp (4.4e-16 and 1.8e-15 relative where
// the result is not cancelling toward a zero). The seven-term minimax pair
// they replace stopped at 1.2e-12 and 2.2e-11. Near a zero of the function
// the argument reduction, not the series, sets the error.
export const SIN_C = [1, -0.16666666666666666, 0.008333333333333333, -0.0001984126984126984, 0.0000027557319223985893, -2.505210838544172e-8, 1.6059043836821613e-10, -7.647163731819816e-13, 2.8114572543455206e-15, -8.22063524662433e-18]
export const COS_C = [1, -0.5, 0.041666666666666664, -0.001388888888888889, 0.0000248015873015873, -2.755731922398589e-7, 2.08767569878681e-9, -1.1470745597729725e-11, 4.779477332387385e-14, -1.5619206968586225e-16, 4.110317623312165e-19]
// 2^f over the reduced range f ∈ [-0.5, 0.5] for $math.exp2 (rel. err ≤ 6e-9). Lets the
// base-2 power `2**y` skip the ×ln2 / ÷ln2 round-trip exp(y·ln2) pays — see $math.exp2.
/**
 * The polynomial evaluation tree THREE evaluators share — the scalar WAT builder
 * (module/math.js), the two-wide one (module/math/simd.js) and the JS constant
 * folder (src/prepare/math-kernel.js). They must agree bit for bit: a folded
 * `Math.cos(0.7)` is compared against the compiled kernel's own answer, and a
 * vectorized loop against its scalar tail. Sharing the tree makes that agreement
 * structural instead of three copies that have to be kept in step by hand.
 *
 * Estrin's scheme: pair the coefficients, then fold the pairs with x², x⁴, x⁸ …
 * Horner's chain is one multiply-add deep per coefficient, so a series long
 * enough to be accurate spends its time waiting on itself; this tree is log2(n)
 * deep and its halves evaluate side by side. The powers repeat across the tree
 * and the WAT optimizer's CSE shares them, so the cost over Horner is one
 * multiply per power (x², x⁴, x⁸: log2 of the length) while the critical path
 * shrinks by the same factor.
 *
 * `ops` supplies the three constructors for the target: a constant, a multiply
 * and an add. `x` is the variable already in the target's own form.
 */
export const polyTree = (cs, ops, x) => {
  const { konst, mul, add } = ops
  let terms = []
  for (let i = 0; i < cs.length; i += 2)
    terms.push(i + 1 < cs.length ? add(konst(cs[i]), mul(x, konst(cs[i + 1]))) : konst(cs[i]))
  let pow = mul(x, x)
  while (terms.length > 1) {
    const next = []
    for (let i = 0; i < terms.length; i += 2)
      next.push(i + 1 < terms.length ? add(terms[i], mul(pow, terms[i + 1])) : terms[i])
    terms = next
    pow = mul(pow, pow)
  }
  return terms[0]
}

// atanh's series for log: log((1+s)/(1-s)) = 2s * (1 + s^2/3 + s^4/5 + …), the
// coefficients 1/(2k+1) EXACTLY, k = 0..9. log reduces to |s| <= 0.1716, where
// ten terms land within 2 ulp (measured against log1p(s) - log1p(-s), which has
// no cancellation to hide behind). The five-term minimax this replaces stopped
// at 1.7e-11 and set the accuracy of log2, log1p, asinh, acosh and atanh with it.
export const LOG_C = [1, 0.3333333333333333, 0.2, 0.14285714285714285, 0.1111111111111111, 0.09090909090909091, 0.07692307692307693, 0.06666666666666667, 0.058823529411764705, 0.05263157894736842]

// (e^x - 1)/x on |x| < 0.5 as the Maclaurin series 1/n!, n = 1..14 — the length
// that lands within 2 ulp (measured against the host over 200k points; the
// 8-term series this replaces stopped at 1.3e-8 relative, the one function that
// sat outside jz's own ~1e-9 transcendental budget). expm1 keeps its own series
// rather than `exp(x) - 1` because that subtraction cancels away the answer near
// zero, which is the whole reason the function exists.
export const EXPM1_C = [1, 0.5, 0.16666666666666666, 0.041666666666666664, 0.008333333333333333, 0.001388888888888889, 0.0001984126984126984, 0.0000248015873015873, 0.0000027557319223985893, 2.755731922398589e-7, 2.505210838544172e-8, 2.08767569878681e-9, 1.6059043836821613e-10, 1.1470745597729725e-11]

// The table $math.exp2 and $math.exp reduce to: 2^(j/64), j = 0..63, as the
// double nearest the exact power and the relative tail its rounding dropped
// ((exact − T)/T), interleaved. scripts/exp-table.mjs derives both from
// 2^(1/64) at 200 bits; test/math.js re-derives them. With the tail, the
// kernels' T + T·(q + tail) — q the small remainder 2^f − 1 or e^r − 1 —
// rounds once: 0.52 ulp over the whole range for both functions against the
// 200-bit reference (the 14-term series over |f| ≤ ½ this replaces reached
// 2 ulp at twice the flops, and exp through 2^(x·log2 e) lost |x| ulp on top).
export const EXP2_TAB = [
  1, 0,
  1.0108892860517005, -1.5070669769260386e-17,
  1.0218971486541166, 4.9997448722726326e-17,
  1.0330248790212284, 7.357846871247418e-18,
  1.0442737824274138, 8.189317638195515e-17,
  1.0556451783605572, 1.6665881442326749e-18,
  1.0671404006768237, -7.402825309426177e-17,
  1.0787607977571199, -6.170654745608694e-17,
  1.0905077326652577, -2.7939114859515733e-17,
  1.102382583307841, 4.776959425256223e-17,
  1.1143867425958924, 9.341710609905046e-17,
  1.1265216186082418, 4.585670326662351e-17,
  1.1387886347566916, 7.826573258636076e-17,
  1.1511892299529827, 2.823784425951061e-17,
  1.1637248587775775, 3.2904726646008416e-17,
  1.1763969916502812, 4.721368121170128e-17,
  1.189207115002721, 3.3484623336251524e-17,
  1.202156731452703, 5.52755004850525e-17,
  1.215247359980469, -6.346552106729484e-17,
  1.22848053610687, -1.5456342819397733e-17,
  1.241857812073484, 3.750854201303127e-17,
  1.255380757024691, -5.346099009198751e-18,
  1.2690509571917332, 2.1023049675215718e-18,
  1.2828700160787783, 1.335751008883454e-17,
  1.2968395546510096, 1.9572585293112036e-17,
  1.3109612115247644, -5.478069123926778e-17,
  1.3252366431597413, -2.1571477251208756e-17,
  1.339667524053303, 6.663804589232195e-17,
  1.3542555469368927, 5.68648095791174e-17,
  1.3690024229745905, 7.007875046906996e-17,
  1.383909881963832, -4.8923067513522756e-17,
  1.3989796725383112, -6.872303720902018e-17,
  1.4142135623730951, -6.835808657661923e-17,
  1.42961333839197, -8.416011634717156e-18,
  1.4451808069770467, -2.0923043818433526e-17,
  1.460917794180647, -3.833464968654295e-17,
  1.4768261459394993, -2.3591094770850053e-17,
  1.4929077282912648, 9.50689710108796e-18,
  1.5091644275934228, -6.735219232374683e-17,
  1.5255981507445384, -7.226635472101257e-17,
  1.5422108254079407, 5.154830117078679e-17,
  1.559004400237837, 2.4253985766689806e-17,
  1.5759808451078865, -6.432131775424189e-18,
  1.593142151342267, -6.336161863401293e-17,
  1.6104903319492543, 1.5341410053603723e-17,
  1.6280274218573478, -4.123367330661149e-17,
  1.645755478153965, -6.152602891550265e-17,
  1.6636765803267364, 3.540948262646183e-17,
  1.681792830507429, 4.875160526227061e-17,
  1.7001063537185235, -4.719539664590972e-18,
  1.718619298122478, -1.0772487078934056e-17,
  1.7373338352737062, 1.821405440362259e-17,
  1.7562521603732995, 1.685487290628973e-17,
  1.7753764925265212, 3.621615935336894e-17,
  1.7947090750031072, 1.0156219011641499e-17,
  1.8142521755003989, -5.495118966122004e-17,
  1.8340080864093424, 1.7901269076045134e-17,
  1.8539791250833855, 5.265370768556274e-17,
  1.8741676341103, -3.2669241009013184e-17,
  1.8945759815869656, 1.7963932659833022e-17,
  1.9152065613971474, -5.545065618639427e-17,
  1.9360617934922943, 5.336805878514151e-17,
  1.9571441241754002, 4.5784915277060095e-17,
  1.978456026387951, 2.0414278897578303e-17,
]
// The same doubles as the data table's little-endian bytes (module/math.js
// hands them to the assembler; test/math.js checks the two agree).
export const EXP2_TAB_HEX = '000000000000f03f00000000000000006180773e9a2cf03f5cdcd89c136071bc748515d3b059f03f13f6673552d28c3cc89b75184587f03f61c8e6614ef7603c0f89f96c58b5f03f6d7b835da69a973ca2d1d332ece3f03fd29c2f703dbe3e3c515b12d00113f13f0ebd2f2a525695bce02da9ae9a42f13f15f4d5b923c991bc7b517d3cb872f13f4893a5ea151b80bc75cb6feb5ba3f13fbf53133f8c898b3caab9683187d4f13f602f3a3ef7ec9a3cd68c62883b06f23f8dc3a644416f8a3c3862756e7a38f23f94a8a8e3fd8e963cdd7ce265456bf23ff2e71f982b47803ce1de1ff59d9ef23f31ab096de1f7823c0b03e4a685d2f23fb40a0c7282378b3c15b7310afe06f33fb6abb04d754d833cff1664b2083cf33f4bf8d35d39dd8f3ccba93a37a771f33f69504bcced4a92bcf79fe534dba7f33fd236943ee8d171bc2234124ca6def33f6d4c2aa7489f853c2a2ef7210a16f43f5b8917488fa758bc2d896160084ef43f12acc260ed63433cd03cc1b5a286f43f7803a1dae1cc6e3c272a36d5dabff43fb0af7abbce90763ca72c9d76b2f9f43f8ea3710034948fbc824f9d562b34f53f60380fbdc6de78bcda27b536476ff53f8ed7fd180535933c295448dd07abf53f09541ce2e163903c4821ad156fe7f53f36c0642be632943c85553ab07e24f63fa84def3bc5338cbc252255823862f63f58585678ddce93bccd3b7f669ea0f63f29225ebfefb393bc2f1a653cb2dff63feea96db8ef6763bc745fece8751ff73fce3e5a7e641f78bcc9674256eb5ff73f8ae6551e321986bc8701eb7314a1f73f1da54db9dc327bbc624ecf36f3e2f73f556cd6abe1eb653c13ce4c998925f83f34373bf1b66993bced92449bd968f83f6e5772d850d494bcdba02a42e5acf83fb5eaf0c12fb78d3c36771599aef1f83f445ff35983f67b3ce5c5cdb03737f93f291e6c8bb8a95dbc504ede9f827df93faaf9f422434392bc90f0a38291c4f93f27ce912bfcaf713c65e55d7b660cfa3f6322622204c587bc5d253eb20355fa3f15bbbcd3d1bb91bcbffd79556b9efa3fb35a736e8469843cadd35a999fe8fa3f8633cb92771a8c3cfb154fb8a233fb3fbaaedc56d9c355bc475efbf2767ffb3f3493ad38f4d668bcd2c14b901eccfb3fcddd5f0ad7ff743c9c5285dd9b19fc3fb30caf30ae6e733c4bd1572ef167fc3fac5909d18fe0843c6990efdc20b7fc3f6719926c2c6b673c7c89074a2d07fd3f6efaff3f5dad8fbc87a4fbdc1858fd3fa8073da685a3743c8532db03e6a9fd3fac92c1d5505a8e3c5f9b7b3397fcfd3f203eb40721d582bcf63f8be72e50fe3fd3883a6004b6743cda90a4a2afa4fe3ff091d38f12f78fbc275a61ee1bfafe3f0820aa41bcc38e3c40456e5b7650ff3fee85d131a9648a3cd8909e81c1a7ff3f9dcd914d3b89773c'
// (2^f − 1)/f on |f| ≤ 1/128 as ln2^n/n!, n = 1..6, and (e^r − 1)/r on
// |r| ≤ ln2/128 as 1/n!, n = 1..6 — the degree at which the table kernels
// land within 0.52 ulp (0.76 at degree 5, 348 at 4).
export const EXP2_Q = [0.6931471805599453, 0.2402265069591007, 0.055504108664821576, 0.009618129107628477, 0.0013333558146428441, 0.00015403530393381606]
export const EXP_Q = [1, 0.5, 0.16666666666666666, 0.041666666666666664, 0.008333333333333333, 0.001388888888888889]
// ln2/64 split for exp's reduction r = (x − k·L1) − k·L2: L1 keeps 36 bits, so
// k·L1 is exact for every |k| < 2^17 (every finite result), L2 the rest.
export const EXP_L1 = 0.010830424696223417, EXP_L2 = 2.572804622327669e-14
// Range-reduction constants via plain number interpolation: `${number}` now formats
// through the Ryū shortest-round-trip __ftoa in BOTH legs (host and self-compiled
// kernel), so the full-precision f64 bakes into the WAT verbatim — the former
// string-literal workaround for the kernel's 9-digit dtoa is obsolete.
export const PI = Math.PI, INV_PI = 1 / Math.PI, HALF_PI = Math.PI / 2
