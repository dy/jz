// munsell.c – xyY to Munsell HVC over a batch of colors: color-space's wasm
// batch kernel (github.com/colorjs/color-space, wasm/batch.js) ported from
// munsell.js.
//
// xyy_munsell and the helpers it reaches (muAt, muCell, muCorner, muY, muV,
// muXyY) are ported as written, each a C function; a helper returns its small
// [x, y] or [x, y, Y] array as a struct by value. Per color: the Newhall value
// polynomial's Newton inverse, a coarse search over 40 hues × 19 chromas, then
// up to 60 2-D Newton steps on (H, C), each step three muXyY calls of four
// renotation lookups. The 1943 renotation table (RIT MCSL "real", 2734 colors,
// Illuminant C) is the JS's: the same packed strings, decoded once at start
// (untimed) into a byte array of per-cell chroma counts, an int32 array of cell
// offsets and a uint16 array of (x, y) × 1e4, as the JS decodes them at module
// load into Uint8Array, Int32Array and Uint16Array. The hue cell index is taken
// mod 40 in int (the JS's % on the integer-valued Math.floor gives the same
// values); the hue wrap itself stays fmod, JS `%` on doubles. Math.min and
// Math.max become plain comparisons: no value is ever NaN. `**` is libm pow,
// Math.cbrt and Math.hypot libm's.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every output value at
// single precision (checksum_f64_near, benchlib's checksumF64Near), which
// tolerates last-bit pow, cbrt and hypot differences between libms.
#include "../_lib/bench.h"
#include <math.h>
#include <stdbool.h>
#include <stdlib.h>

#define N_COLORS 256
#define N_RUNS   11
#define N_WARMUP 2

// small results: [x, y] and [a, b, c] in the JS
typedef struct { double x, y; } XY;
typedef struct { double a, b, c; } Tri;

static double min2(double a, double b) { return a < b ? a : b; }
static double max2(double a, double b) { return a > b ? a : b; }

// per (hue, value) cell, its chroma count as a character code + 48 (where two
// question marks meet, the second is escaped as \? so that C reads no trigraph)
static const char MU_COUNTS[] = "5789:98535789:9753578::9853577899853445689:63234679:731345789:41245679:41235678:612346789:1234678991234678991234678992345678:92456789:936789:;<948;=>>=<848;=>>=;648;=>>=:648;=>=<:647:<<;;95369:;::85368999985357889873356888862356788742456788642457898642467997531579:97531CCA=:7531?AA?;8642=?A@=9642;>@@>:752:<?@?<9639;=?\?=;738:;==<:7379:;<;963689:;:863678::9853";
// every renotation node's (x, y) × 1e4, little-endian uint16 pairs, base64
static const char MU_PACK[] = "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RQQsC4kKZwy6CE4MMwcmDH0F3QsaBIwLAQNAC7YKeAwnCYAM5Ad0DKcGVwyCBS4MhgT/C6wD0wvfAqMLRAJ8C+8KiAywCaAMhgioDGIHogxSBpMMYwV+DJIEYgzgA0UMPAMkDKMCAwwZC4oMHwquDDgJxgw0CNAMOgfQDE4G0AyoBcsM2wS9DBYErAyIA58MDQOLDDgLkwxYCr4MiQnaDLwI7wz1BwENNAcJDX4GDw3TBRENLQURDZAEEA1SC5kMmArFDO8J5gwyCQcNcwghDc0HMw0uBz4NiwZJDesFUg1kBVQNZwucDMAKzgwcCvYMcwkYDdgINw01CFQNpgdoDRYHeg1yC6AM0ArXDCcKCg2FCTIN/QhNDX4JzwumBtAKIwS1CVsKGgxyCKUL0wYlCy0FlgrfAxYK1AKuCYsKMAzgCOELiAeOC1QGOAsuBeAKPgSSCmoDQwqzAv8JzApMDH0JJAxBCOwLFwepCwQGXgsSBRgLRATWCpoDngoAA2sK/ApZDPYJTgz0CDUM7gcKDPAG2AsBBqALVAV0C48EQAvWAwwLIQtkDCwKYQxQCVMMewhCDKkHJgziBgkMMQbsC4AFyQvgBKULPgtuDG8KdQy6CXIM9AhqDC4IXQx6B0wM1wY5DDAGHQyTBQQMVAtvDJ4KgAzdCX4MMAl+DIgIfAzaB3QMTAdrDLkGYAxfC3QMqAqIDO8JlAw5CZkMpwiaDDoJQgt6BsAJMgRRCC4KwgswCOYKhQYKCuoEGwmhA1UIZArqC60IRgtFB6IKDwYLCuIEawn6A+kIHgNnCLQKEwxQCagLEQgvC+AGqgrIBSgK4AS0CQkESAl4A/oI7AonDNAJ4Au6CIgLsgcsC7QGyArNBWYKHAUWClQEuQkVCzwMEgoGDB8JxwtECIYLdQdBC6IG8gruBakKOQVbCp0EFQo1C0cMUgolDJAJ/Qu7CMYL8weMCzEHTAuHBhAL0QXQCk4LUAx+CjoMuQkbDP4I9wtICNELkQeiC/wGeAtbC1cMjApEDMUJLgwSCd0KcQYUCV4EdAcSCnwLDAhZClUGNgnOBBwIjwMkB0wKpwuHCLwKIgfoCecFGwnEBFQI3QOrB6cK3gs4CTgLAAiUCskG3Am3BTIJ3wShCAMECQiEA7UH5wr/C7wJiguiCAcLmwd/CqEG9Qm1BWYJAwX0CEIEdggTCxkMCwrACwgJUwsgCOUKVwd6CnwGAQrIBZsJDgUsCTMLJgxFCt4LcgmQC6AINwvKB9cKBQdwClgGFQqbBagJUQs0DGwK+wueCbgL2AhrCxIIFwtVB8AKXQs1DHgKAQzzCHUKgwZ4CLwE0Qb/CToLAAjWCVEGcgjdBCMHxQMWBjkKaQuACEgKKwdHCfcFRwjrBFcHEgSRBqMKsAs7Cd4KDAgMCt8GKQnoBWQIEwWrB0oE+QbqCtgLvQk/C6cIjQqmB9cJwQYrCeEFfAgoBeUHbARHBxoL9wsTCnoLEAnlCigISwpbB7cJlQYjCdgFkQgeBQAIOwsGDEkKnAtqCSYLnAipCsIHEwryBn4JTwYDCVwLGAxvCrYLmQlIC70IyQpnCx4Mcwq9C/MIEwq0BgAIFwVnBsgDAAXxCe8KDwhgCXoG6gchBZwGGwSOBTgKKQuYCOgJUwfSCC8Gwwc/BdwGawQGBq0KgwtUCZAKNgimCR0HuAhBBuwHcQUtB7QEdwbzCrgLzwn4CsgINArXB3EJAAe2CDAG+gd8BVYHzgSvBiYL3QsqCkELMAmUClQI6QmOB0YJxgabCBQG+wdgBVcHSAvyC1sKbwuECeMKsQhHCuAHogkaB/8IagsFDIAKjAuoCQULzAhsCnkLDwyACpELBQm7CfcGtgdwBRsGNQTCBP4JpQo2CAkJtAaRB3QFQwaFBEIFRwrxCsYIowmNB30IegZxB5gFiwbMBLQFKQQFBcEKXgt9CVgKbQhnCWUHcAiRBqIHzwXgBh4FLAaDBIgFBQuWC/MJxQr7CPQJEwgoCUQHZQiCBqwH1AUFBy4FYAazBOEFNwvEC00KGAtfCVoKjQikCdAH+ggLB0IIXQabB64F8gZcC98LfQpGC64JqArlCP8JHghOCVsHmwh3C/YLngpfC9AJyAr2CBsKhQsEDJgKbAs4CXQJZwd3BwMG0wX5BIUEIApzCn8IxQghB0EHBAb6BTQF/gSOBDQEZwrECggJZQnmBzUI9AYpBygGQAZ2BXMF4wTCBN4KPAu3CSUKuwgnCcsHLggNB2AHYgaiBsEF6QU4BUUFwgS4BB8LfgsoCqAKPQm4CW0I5giwBx4IAQdmB2oGwAbXBRcGUwWCBVELrwt8CvQKoQknCuIIZgkvCLEIeQf2B9oGTAd0C9ELqQogC+oJdQowCcIJcggFCY0L5wvGCj8LAgqVCp8L9wt7CUAJ3AdLB44GpwWnBWQEBQVmA04KQArXCJAIlgcTB5UG0wXcBdgEUwUYBOUEaQOUCp8KWQk5CUoIBAh0BwcHtgYaBhUGTAWXBaAEJgUABMwEfwMACxoLAgoAChUJ/Ag3CAIIhQczB+0GewZbBscF4AUlBXAFjwQIBQMEQgtrC2YKfwqPCZEJzwi/CCAI+Qd+B0IH7QaZBmYG8QXuBVUFawuiC64K2grlCf4JOAk9CZUIjAjqB88HUQceB4gLwwvVCgwLJApTCnsJmgnOCNsIngvfC+4KLQs2Cm4KrwvxC/MJBgm4CB0H0AeOBVAHdQQMB7YD4wYkA8oGsAK4BkcCrQYGAqUGxgGgBpIBmwZgAZkGNQGWBg4BlAbqAJIGygCSBrQAkQagAJAGjACYChYKdAlkCI0I/gbVB9cFWgfqBBUHRgTiBrsDwAZHA6UG5gKVBpoChgZSAnwGGgJ1BuwBbwbDAWgGmQFjBnUBXgZUAVwGNgFXBhgB2Qp/CtgJDwkHCdoHZQjhBtUHAAZvB0kFIAekBOUGGATCBrQDpgZjA40GDgN6BscCagaPAmAGYQJVBiwCTAb/AUgG4AEtCwMLYQrgCacJ2ggACecHbggTB/UHXQaVB7wFRQckBQYHoQTOBiIEsQbUA5QGgwN7BjkDZgtcC7MKagoDCnEJcQmcCO0I5AdtCCYH+gd9BpkH5wVGB1UFAgfXBIsLkwvuCsAKTgrjCckJKwlKCXgIwQi3B0cIBwemC7sLEQv5Cn8KNAryCXIJagmwCLsL2gsoCx4LjgpYCscL7At1CugImwkkB/IIvgWOCMwESAgFBBYIZQP2B+kC2Ad+AscHNAK4B+0BrQe0AaAHfAGWB0YBkAcZAYgH8ADzCgcKKApyCIgJMAf2CA8GmAgyBVsIkgQnCAIEBAiOA+UHKAPOB84CugeDAqoHQgKdBwgCkQfXAYUHpAF+B3sBdwdYAR8LbgpkCg8JzwnvB1MJ+gbmCB0Gngh/BV4I4gQsCF4EDAj8A+4HogPUB08DvgcEA6sHxAKeB4oCkgdXAoYHHgJ+B/cBXwv0CscK2gk6CtcIwQn2B1QJLQf6CHsGrAjfBXoIXQVICOgEGwh0BAAIKATkB9kDygeIA7MHSAOgBwoDjwtZCwULYwp+CmwJDAqjCK4J7gdQCUEH+wiiBrAIEwZ+CKQFSQgxBSIIyQSsC5ELLwu7CrQK5QlNCjAJ7AmACIgJzgcwCS8H2QiHBr0LuAtGC/EK2Ao0Cm4KeQkDCsAIoQkKCNML2wtfCyAL6ApZCnUKiwneC+4LXgsiC/gK+AhsClIHCgoXBsAJFwWJCVgEWgmsAzkJKgMbCbgCCAlqAvcIHgLnCNkB2giiAcsIYwFMCxcKxgqgCGUKgQcKCmMGxQmOBZEJ3QRmCUwERAnUAykJaQMQCQsD+gi4AuUIbQLUCCsCxQjrAbcIsAFqC3gK6AomCYMKGAg3CjUH9AlmBsIJyAWRCS0FagmuBEwJRgQyCesDGQmPAwEJQAPuCP0C3Ai6AswIfgLCCEsCtggfApIL9wonC+MJywr8CH0KKQg7Cm8H/wnCBs0JMQajCawFfgk0BVoJxQRDCXcELAkmBBIJ0gP+CI0D7QhPA9kIBgO4C2ALUgtrCvYKjAmoCsAIaQobCDAKeQcACu4G0wlsBqwJ/AWGCYsFYgkjBUQJxwQsCXQEyAuQC3QLxwoaC/YJ0gpECY8KnAhXCgQIIQp1B/QJ6AbICXoG1wu4C4YL+go5C0kK7wqbCakK8QhoCk8I6AvgC5ILIgtBC28K8Aq4CeoL6wuTCzELeAsaCSYLhwfqClwGtgpfBY0KmgRuCu4DVQpfA0EK6gI0CpsCKQpKAh4K/QGoCzQKXAvVCCILyAfnCqsGvArcBZUKKAV0CosEXAoVBEgKpwM0CkYDJQruAhYKnQIJClIC/wkNArULjApwC1IJNgtXCAMLdgfUCqsGswoDBpMKdQV4CvgEYQqLBE8KMgQ8CtIDKgp7Ax4KNgMTCu4CCAqyAv0JdgLOCwkLjgsFClcLKwknC2YI/gqvB9oKEAe7CnwGngrwBYUKgAVuChQFXArCBEsKbAQ6ChwEKArLAxwKiwMOCkED5QtwC6oLiwp0C7cJRQv4CB0LWQj2CrkH1wo3B7gKtgaeCkQGhgrbBXEKdgVcChgFSwrIBDoKbwTqC5cLuQvaCoYLGQpZC3UJLgvUCA0LSQjqCrsHyQo8B6sKygaOClUG8wvCC8ELDwuRC2cKZgvICTgLJwkRC5UI8QoUCPkL5wvECzQLkwuQCmIL5gk2C0wJ+wv0C7sLNgvWCzkJrwu2B5ALkgZ0C5UFWQvNBEQLIwQ0C4cDJAsWAxkLwgIPC3EC/wtXCugLEQnRCwoIuAv1BqMLIQaMC3AFegvTBGoLUgRgC+MDVguFA0oLHwNCC88CEAy0CgAMkAnxC6AI3Qu9B8wLAge7C1IGsAvDBaULTAWZC9cEkQt/BIkLIQSAC8cDegt8A3ILLANqC+4CFQwrCwwMPgoEDHAJ+gu0CPALDAjlC3EH2wvbBtQLVQbIC9wFwgt0BbkLGgWxC8kEqgtvBKMLJgSZC9MDkguKAx8MjwscDL4KFQz7CQ8MRwkIDLYI/wsgCPwLnwf0CyYH7AuvBuILRgbeC9wF1guPBc4LMwXKC+UEwguSBCMMsQsjDA8LHQxaChsMxgkUDC4JEgyuCAwMLwgIDLgHAwxOB/0L0Qb2C2YG8gsLBiUM3QsnDEALJwyqCiUMGAokDIoJIAwQCR0MkAgbDBoIFQyqByMM/gsqDGMLKgzhCiwMQgosDMEJLQxCCSMMCQwtDHALMAzkCjwMZAk8DPAHNgzJBioMyQUeDAIFFgxWBAwMuAMGDEcD/QvsAlkMgwp1DFYJhwxUCJMMRgeeDHsGoQzFBaMMJQWjDJ0EoQwnBJ8MwgOeDF0DYgzmCo4M1QmrDPUIxQwbCNYMYQflDLMG7QwkBvgMsAUBDTQFBA3YBAwNegQNDR8EDw3SA1oMVguKDH4KsAy9CdAMDgnqDHIIAw3eBxcNUwcqDdwGOg1aBkgN3AVTDZAFXQ05BWQN4ARoDZQEcA04BEwMqgt+DPcKqwxGCtAMoAnsDBgJBw2LCCANEgg2DZ8HSQ0wB14NxwZtDWwGeg0TBowNtAWWDWwFog0cBUoMygttDDcLmgycCrsMGArdDJIJ+QwZCRUNmwgqDS8IPA3LB1ENWgdiDfkGcQ2iBoENRAZCDO4LbQxoC5UM4gq4DF4K2AzjCfIMdwkNDQQJKA2QCD8NKAhSDcQHZg1bBzsMDAxnDIsLjQwNC7IMjArSDBYK8AymCQ4NLQk4DBYMaAyWC5IMHQuoDJsJ2gwvCPkMEwcODQ8GGg1HBSENnQQoDfwDKA2GA88Mwgo2DcAJjg3TCOMN0wchDggHVA5SBn8OqQWkDh4Fwg6kBNoOOATIDC0LSA1ACq0NeQkODrkIYQ4GCKoOagfqDt4GJA9dBlkP4gWBD4UFsg8YBZ8MhwsMDdIKcg0jCs0NhgkYDv0IYw5yCKQO9wffDoMHGQ8KB1YPjwZ/DzkGqw/gBdAPlAV/DMsL4gw1C0QNngqiDQoK6A2UCTMOFQl3DqMIsw48CO0O1wchD3UHVA8WB30PygarD3QGdAzoC8gMcQsiDe8KbQ2ACrUNEgr+DZ4JRA4zCYYOywi9Dm4I+Q4ICCUPugdXD2QHYgwEDLYMmwsKDSYLWQ25Cp8NWArjDfEJJA6QCWgOJgmnDsEI4w5fCFIMHAynDLgL/wxSC04N6QqXDYsK4A0iCiUOwAlNDCQMogzCC/oMXgsyDe4Jrw2UCAQOgAdMDn4Gjw6yBbwOAwXjDnIENw0NC+YNJQp8DkwJEg9cCIMPkwfwD+QGVBA+Bq0QrgXyEDwFKg18CwIOtgq1DgkKWg9bCekPuwhnECkI2RCYB0IREQeXEZ8G4RE5Bu4MwgujDTgLVw6tCvkOKAp4D7kJCBA5CYEQyQjzEFsIZxHnB9sRcgcwEh0HuAz5C10NigsBDhoLpA6pCigPRgq2D9sJLhB8CaUQGwkUEcIIhBFmCOURFAhLEroHoAwNDCsNuQvADVgLQA4EC7kOsgo8D1YKtw/4CSgQowmVEE4JEBHrCGERqwiGDCAMBA3YC44NhQsTDjULgQ7uCgEPlgp2D0QK7A/sCVoQmwlsDDAM7AzsC3ANogvyDVQLZQ4MC+oOtgpkDDYM5Qz0C2cNrAuqDTkKeQ78CBkP9AelDwEHJBAsBpAQeAWDDUwLdg57Ck4PugkpEOQI4RAiCIERbwcQEskGiBI7BnoNuQubDiMLlg+UCooQ/AldEXMJLhLhCN8SXAh/E9sHChRlBysN9QscDpMLCg8rC+gPvgqjEFsKYhHtCRUShQm/EhkJZROpCAoUNQjgDBoMuw3QC44OfQtcDyQLDBDVCs8QcwpmESQKCRLKCZkSdQkzExoJtRPICL0MKQxvDfALMw6rC88OcQt4DywLHRDgCr0QkQpgET4K5RH1CX8SoAmgDDUMPQ0HDOoNzguKDpMLHw9aC8gPEgtjEMoK+hCBCoAMQAwgDRQMwQ3iC2IOpwv2DnILog8rC3YMRQwWDRsMuA3sCy0OlgpQD3cJNxB5CAURgQepEa4GPBLqBcwNjQsKD9oKKxAwCkwRcwlGEr0ILxMMCAkUYAfGDfwLMQ+ZC3oQMAvIEbUK8xI6ChMUuQkEFUEJ/BXBCFkNIgyDDuILnw+cC7oQSguwEfsKtRKdCpwTPwpyFOIJWhV4CSoWDwkEDTsMCg4SDAsP3wsJEKQL7BBmC+MRGQufEtgKehOHCkEUPAoUFecJ3AxFDLQNKAycDgIMWg/eCzYQrQsIEXgLyBFBC60S/AphE78KugxMDHYNNQxADhoMCw/7C8gP1gukEKQLaBFzCygSPguSDFAMVA0/DBAOKAzYDgoMjw/pC4UMUwxIDUQMBg4uDA==";

static uint8_t mu_cnt[360];
static int32_t mu_off[361];
static uint16_t mu_xy[sizeof MU_PACK / 4 * 3 / 2];
static const double mu_wx = 0.31006, mu_wy = 0.31616; // Illuminant C 2° white chromaticity

static int b64_val(char ch) {
  if (ch >= 'A' && ch <= 'Z') return ch - 'A';
  if (ch >= 'a' && ch <= 'z') return ch - 'a' + 26;
  if (ch >= '0' && ch <= '9') return ch - '0' + 52;
  return ch == '+' ? 62 : 63;
}

// standard base64 (with '=' padding) to bytes, as atob decodes it; returns the byte count
static int b64_decode(const char* s, uint8_t* out) {
  int n = 0, bits = 0;
  uint32_t acc = 0;
  for (; *s && *s != '='; s++) {
    acc = acc << 6 | (uint32_t)b64_val(*s);
    bits += 6;
    if (bits >= 8) { bits -= 8; out[n++] = (uint8_t)(acc >> bits); }
  }
  return n;
}

static void init_tables(void) {
  for (int i = 0; i < 360; i++) { mu_cnt[i] = (uint8_t)(MU_COUNTS[i] - 48); mu_off[i + 1] = mu_off[i] + mu_cnt[i]; }
  uint8_t bin[sizeof MU_PACK / 4 * 3];
  int n = b64_decode(MU_PACK, bin);
  for (int i = 0; i < n >> 1; i++) mu_xy[i] = (uint16_t)(bin[i * 2] | bin[i * 2 + 1] << 8);
}

static XY mu_at(int hi, int vi, int ci) { int o = (mu_off[hi * 9 + vi] + ci) * 2; return (XY){ mu_xy[o] / 1e4, mu_xy[o + 1] / 1e4 }; }

// chroma-interpolated xy at fractional chroma C in cell (hi, vi), clamped to its gamut (cellXY)
static XY mu_cell(int hi, int vi, double C) {
  int n = mu_cnt[hi * 9 + vi];
  if (C <= 0) return (XY){ mu_wx, mu_wy };
  double ci = C / 2 - 1, c0 = floor(ci);
  if (c0 < 0) { XY p = mu_at(hi, vi, 0); double t = C / 2; return (XY){ mu_wx + (p.x - mu_wx) * t, mu_wy + (p.y - mu_wy) * t }; }
  if (c0 >= n - 1) return mu_at(hi, vi, n - 1);
  XY p0 = mu_at(hi, vi, (int)c0), p1 = mu_at(hi, vi, (int)c0 + 1);
  double t = ci - c0;
  return (XY){ p0.x + (p1.x - p0.x) * t, p0.y + (p1.y - p0.y) * t };
}

// an empty cell falls back to its hue neighbour, then to white (toXyY's corner)
static XY mu_corner(int hi, int vi, double C, int alt) {
  int k = mu_cnt[hi * 9 + vi] ? hi : mu_cnt[alt * 9 + vi] ? alt : -1;
  if (k < 0) return (XY){ mu_wx, mu_wy };
  return mu_cell(k, vi, C);
}

// Newhall 1943 value function V → Y (the renotation table's Y column), and its Newton inverse
static double mu_y(double V) { return 1.2219 * V - 0.23111 * pow(V, 2) + 0.23951 * pow(V, 3) - 0.021009 * pow(V, 4) + 0.0008404 * pow(V, 5); }

static double mu_v(double Y) {
  double V = 10 * cbrt(max2(Y, 0) / 100);
  for (int i = 0; i < 40; i++) {
    double f = mu_y(V) - Y;
    double d = 1.2219 - 0.46222 * V + 0.71853 * pow(V, 2) - 0.084036 * pow(V, 3) + 0.004202 * pow(V, 4);
    V -= f / d; if (fabs(f) < 1e-9) break;
  }
  return V;
}

static Tri mu_xyy(double H, double V, double C) {
  double Y = mu_y(V);
  if (C <= 0) return (Tri){ mu_wx, mu_wy, Y };
  double vi0 = max2(0, min2(8, floor(V) - 1)), vi1 = min2(8, vi0 + 1);
  double tv = max2(0, min2(1, (V - 1) - vi0));
  double hf = fmod(fmod(H - 1e-9, 100) + 100, 100) / 2.5 - 1;
  int h0 = ((int)floor(hf) % 40 + 40) % 40, h1 = (h0 + 1) % 40;
  double th = hf - floor(hf);
  XY a = mu_corner(h0, (int)vi0, C, h1), b = mu_corner(h1, (int)vi0, C, h0);
  XY c = mu_corner(h0, (int)vi1, C, h1), d = mu_corner(h1, (int)vi1, C, h0);
  double x0 = a.x + (b.x - a.x) * th, y0 = a.y + (b.y - a.y) * th, x1 = c.x + (d.x - c.x) * th, y1 = c.y + (d.y - c.y) * th;
  return (Tri){ x0 + (x1 - x0) * tv, y0 + (y1 - y0) * tv, Y };
}

// coarse search over the renotation's hue × chroma nodes at this value, then 2-D Newton on (H, C)
static Tri xyy_munsell(double x, double y, double Y) {
  double V = mu_v(Y);
  if (hypot(x - mu_wx, y - mu_wy) < 1e-4) return (Tri){ 0, V, 0 };
  double H = 0, C = 0, bd = 0;
  bool seen = false;
  for (int hi = 0; hi < 40; hi++) for (int c = 2; c <= 38; c += 2) {
    Tri f = mu_xyy(2.5 * (hi + 1), V, c);
    double d = pow(f.a - x, 2) + pow(f.b - y, 2);
    if (!seen || d < bd) { H = 2.5 * (hi + 1); C = c; bd = d; seen = true; }
  }
  for (int it = 0; it < 60; it++) {
    Tri f = mu_xyy(H, V, C);
    double ex = f.a - x, ey = f.b - y;
    if (hypot(ex, ey) < 1e-8) break;
    Tri h = mu_xyy(H + 0.05, V, C), k = mu_xyy(H, V, C + 0.05);
    double j00 = (h.a - f.a) / 0.05, j01 = (k.a - f.a) / 0.05;
    double j10 = (h.b - f.b) / 0.05, j11 = (k.b - f.b) / 0.05;
    double det = j00 * j11 - j01 * j10; if (fabs(det) < 1e-12) break;
    double sH = (j11 * -ex - j01 * -ey) / det, sC = (-j10 * -ex + j00 * -ey) / det;
    H = fmod(fmod(H + max2(-5, min2(5, sH)), 100) + 100, 100);
    C = max2(0, C + max2(-5, min2(5, sC)));
  }
  return (Tri){ H, V, C };
}

// setup, untimed: deterministic sRGB (XorShift32) → linear → XYZ → xyY, the library's own steps
static double sgn(double v) { return v < 0 ? -1 : 1; }
static double srgb_dec(double v) { double a = fabs(v); return sgn(v) * (a > 0.04045 ? pow((a + 0.055) / 1.055, 2.4) : a / 12.92); }
// black has no chromaticity: it sits at the D65 white's (x, y)
static Tri xyz_xyy(double X, double Y, double Z) {
  double sum = X + Y + Z;
  if (sum == 0) return (Tri){ 0.3127, 0.329, Y };
  return (Tri){ X / sum, Y / sum, Y };
}

static void mk_input(double* out, int n) {
  uint32_t s = 0x1234abcdu;
  for (int i = 0; i < n; i++) {
    double c[3] = { 0, 0, 0 };
    for (int k = 0; k < 3; k++) { s ^= s << 13; s ^= s >> 17; s ^= s << 5; c[k] = srgb_dec((double)s / 4294967296.0); }
    double X = 100 * (0.41239079926595 * c[0] + 0.35758433938387 * c[1] + 0.18048078840183 * c[2]);
    double Y = 100 * (0.21263900587151 * c[0] + 0.71516867876775 * c[1] + 0.072192315360733 * c[2]);
    double Z = 100 * (0.019330818715591 * c[0] + 0.11919477979462 * c[1] + 0.95053215224966 * c[2]);
    Tri p = xyz_xyy(X, Y, Z);
    out[3 * i] = p.a; out[3 * i + 1] = p.b; out[3 * i + 2] = p.c;
  }
}

static void to_munsell(const double* src, double* dst, int n) {
  for (int i = 0; i < n; i++) {
    int j = 3 * i;
    Tri m = xyy_munsell(src[j], src[j + 1], src[j + 2]);
    dst[j] = m.a; dst[j + 1] = m.b; dst[j + 2] = m.c;
  }
}

int main(void) {
  init_tables();
  double* src = malloc(sizeof(double) * 3 * N_COLORS);
  double* dst = malloc(sizeof(double) * 3 * N_COLORS);
  double samples[N_RUNS];
  mk_input(src, N_COLORS);

  for (int i = 0; i < N_WARMUP; i++) to_munsell(src, dst, N_COLORS);

  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    to_munsell(src, dst, N_COLORS);
    samples[i] = now_ms() - t0;
  }

  print_result(median_us(samples, N_RUNS), checksum_f64_near(dst, 3 * N_COLORS), N_COLORS, 1, N_RUNS);
  free(src);
  free(dst);
  return 0;
}
