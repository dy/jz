// munsell.rs – xyY to Munsell HVC over a batch of colors: color-space's wasm
// batch kernel (github.com/colorjs/color-space, wasm/batch.js) ported from
// munsell.js.
//
// xyy_munsell and the helpers it reaches (muAt, muCell, muCorner, muY, muV,
// muXyY) are ported as written, each a Rust fn; a helper returns its small
// [x, y] or [x, y, Y] array as a [f64; 2] or [f64; 3] destructured at once.
// Per color: the Newhall value polynomial's Newton inverse, a coarse search
// over 40 hues × 19 chromas, then up to 60 2-D Newton steps on (H, C), each
// step three muXyY calls of four renotation lookups. The 1943 renotation table
// (RIT MCSL "real", 2734 colors, Illuminant C) is the JS's: the same packed
// strings, decoded once at start (untimed) into a Renotation struct of per-cell
// chroma counts ([u8; 360]), cell offsets ([i32; 361]) and (x, y) × 1e4
// (Vec<u16>), as the JS decodes them at module load into Uint8Array,
// Int32Array and Uint16Array; the table lookups are its methods. The hue cell
// index is taken mod 40 in integers (the JS's % on the integer-valued
// Math.floor gives the same values); the hue wrap itself stays f64 `%`, JS `%`
// on doubles. Math.min and Math.max become plain comparisons: no value is ever
// NaN. `**` is powf (libm pow), Math.cbrt and Math.hypot libm's.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every output value at
// single precision (benchlib's checksumF64Near), which tolerates last-bit pow,
// cbrt and hypot differences between libms.
use std::time::Instant;

const N_COLORS: usize = 256;
const N_RUNS: usize = 11;
const N_WARMUP: usize = 2;

fn mix(h: u32, x: u32) -> u32 {
    (h ^ x).wrapping_mul(0x0100_0193)
}

// FNV-1a over every value rounded to f32 (benchlib checksumF64Near)
fn checksum_f64_near(out: &[f64]) -> u32 {
    let mut h = 0x811c_9dc5u32;
    for &x in out {
        h = mix(h, (x as f32).to_bits());
    }
    h
}

fn median_us(samples: &mut [f64]) -> u64 {
    for i in 1..samples.len() {
        let v = samples[i];
        let mut j = i;
        while j > 0 && samples[j - 1] > v {
            samples[j] = samples[j - 1];
            j -= 1;
        }
        samples[j] = v;
    }
    (samples[(samples.len() - 1) >> 1] * 1000.0) as u64
}

fn min2(a: f64, b: f64) -> f64 { if a < b { a } else { b } }
fn max2(a: f64, b: f64) -> f64 { if a > b { a } else { b } }

// per (hue, value) cell, its chroma count as a character code + 48
const MU_COUNTS: &str = "5789:98535789:9753578::9853577899853445689:63234679:731345789:41245679:41235678:612346789:1234678991234678991234678992345678:92456789:936789:;<948;=>>=<848;=>>=;648;=>>=:648;=>=<:647:<<;;95369:;::85368999985357889873356888862356788742456788642457898642467997531579:97531CCA=:7531?AA?;8642=?A@=9642;>@@>:752:<?@?<9639;=??=;738:;==<:7379:;<;963689:;:863678::9853";
// every renotation node's (x, y) × 1e4, little-endian u16 pairs, base64
const MU_PACK: &str = "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RQQsC4kKZwy6CE4MMwcmDH0F3QsaBIwLAQNAC7YKeAwnCYAM5Ad0DKcGVwyCBS4MhgT/C6wD0wvfAqMLRAJ8C+8KiAywCaAMhgioDGIHogxSBpMMYwV+DJIEYgzgA0UMPAMkDKMCAwwZC4oMHwquDDgJxgw0CNAMOgfQDE4G0AyoBcsM2wS9DBYErAyIA58MDQOLDDgLkwxYCr4MiQnaDLwI7wz1BwENNAcJDX4GDw3TBRENLQURDZAEEA1SC5kMmArFDO8J5gwyCQcNcwghDc0HMw0uBz4NiwZJDesFUg1kBVQNZwucDMAKzgwcCvYMcwkYDdgINw01CFQNpgdoDRYHeg1yC6AM0ArXDCcKCg2FCTIN/QhNDX4JzwumBtAKIwS1CVsKGgxyCKUL0wYlCy0FlgrfAxYK1AKuCYsKMAzgCOELiAeOC1QGOAsuBeAKPgSSCmoDQwqzAv8JzApMDH0JJAxBCOwLFwepCwQGXgsSBRgLRATWCpoDngoAA2sK/ApZDPYJTgz0CDUM7gcKDPAG2AsBBqALVAV0C48EQAvWAwwLIQtkDCwKYQxQCVMMewhCDKkHJgziBgkMMQbsC4AFyQvgBKULPgtuDG8KdQy6CXIM9AhqDC4IXQx6B0wM1wY5DDAGHQyTBQQMVAtvDJ4KgAzdCX4MMAl+DIgIfAzaB3QMTAdrDLkGYAxfC3QMqAqIDO8JlAw5CZkMpwiaDDoJQgt6BsAJMgRRCC4KwgswCOYKhQYKCuoEGwmhA1UIZArqC60IRgtFB6IKDwYLCuIEawn6A+kIHgNnCLQKEwxQCagLEQgvC+AGqgrIBSgK4AS0CQkESAl4A/oI7AonDNAJ4Au6CIgLsgcsC7QGyArNBWYKHAUWClQEuQkVCzwMEgoGDB8JxwtECIYLdQdBC6IG8gruBakKOQVbCp0EFQo1C0cMUgolDJAJ/Qu7CMYL8weMCzEHTAuHBhAL0QXQCk4LUAx+CjoMuQkbDP4I9wtICNELkQeiC/wGeAtbC1cMjApEDMUJLgwSCd0KcQYUCV4EdAcSCnwLDAhZClUGNgnOBBwIjwMkB0wKpwuHCLwKIgfoCecFGwnEBFQI3QOrB6cK3gs4CTgLAAiUCskG3Am3BTIJ3wShCAMECQiEA7UH5wr/C7wJiguiCAcLmwd/CqEG9Qm1BWYJAwX0CEIEdggTCxkMCwrACwgJUwsgCOUKVwd6CnwGAQrIBZsJDgUsCTMLJgxFCt4LcgmQC6AINwvKB9cKBQdwClgGFQqbBagJUQs0DGwK+wueCbgL2AhrCxIIFwtVB8AKXQs1DHgKAQzzCHUKgwZ4CLwE0Qb/CToLAAjWCVEGcgjdBCMHxQMWBjkKaQuACEgKKwdHCfcFRwjrBFcHEgSRBqMKsAs7Cd4KDAgMCt8GKQnoBWQIEwWrB0oE+QbqCtgLvQk/C6cIjQqmB9cJwQYrCeEFfAgoBeUHbARHBxoL9wsTCnoLEAnlCigISwpbB7cJlQYjCdgFkQgeBQAIOwsGDEkKnAtqCSYLnAipCsIHEwryBn4JTwYDCVwLGAxvCrYLmQlIC70IyQpnCx4Mcwq9C/MIEwq0BgAIFwVnBsgDAAXxCe8KDwhgCXoG6gchBZwGGwSOBTgKKQuYCOgJUwfSCC8Gwwc/BdwGawQGBq0KgwtUCZAKNgimCR0HuAhBBuwHcQUtB7QEdwbzCrgLzwn4CsgINArXB3EJAAe2CDAG+gd8BVYHzgSvBiYL3QsqCkELMAmUClQI6QmOB0YJxgabCBQG+wdgBVcHSAvyC1sKbwuECeMKsQhHCuAHogkaB/8IagsFDIAKjAuoCQULzAhsCnkLDwyACpELBQm7CfcGtgdwBRsGNQTCBP4JpQo2CAkJtAaRB3QFQwaFBEIFRwrxCsYIowmNB30IegZxB5gFiwbMBLQFKQQFBcEKXgt9CVgKbQhnCWUHcAiRBqIHzwXgBh4FLAaDBIgFBQuWC/MJxQr7CPQJEwgoCUQHZQiCBqwH1AUFBy4FYAazBOEFNwvEC00KGAtfCVoKjQikCdAH+ggLB0IIXQabB64F8gZcC98LfQpGC64JqArlCP8JHghOCVsHmwh3C/YLngpfC9AJyAr2CBsKhQsEDJgKbAs4CXQJZwd3BwMG0wX5BIUEIApzCn8IxQghB0EHBAb6BTQF/gSOBDQEZwrECggJZQnmBzUI9AYpBygGQAZ2BXMF4wTCBN4KPAu3CSUKuwgnCcsHLggNB2AHYgaiBsEF6QU4BUUFwgS4BB8LfgsoCqAKPQm4CW0I5giwBx4IAQdmB2oGwAbXBRcGUwWCBVELrwt8CvQKoQknCuIIZgkvCLEIeQf2B9oGTAd0C9ELqQogC+oJdQowCcIJcggFCY0L5wvGCj8LAgqVCp8L9wt7CUAJ3AdLB44GpwWnBWQEBQVmA04KQArXCJAIlgcTB5UG0wXcBdgEUwUYBOUEaQOUCp8KWQk5CUoIBAh0BwcHtgYaBhUGTAWXBaAEJgUABMwEfwMACxoLAgoAChUJ/Ag3CAIIhQczB+0GewZbBscF4AUlBXAFjwQIBQMEQgtrC2YKfwqPCZEJzwi/CCAI+Qd+B0IH7QaZBmYG8QXuBVUFawuiC64K2grlCf4JOAk9CZUIjAjqB88HUQceB4gLwwvVCgwLJApTCnsJmgnOCNsIngvfC+4KLQs2Cm4KrwvxC/MJBgm4CB0H0AeOBVAHdQQMB7YD4wYkA8oGsAK4BkcCrQYGAqUGxgGgBpIBmwZgAZkGNQGWBg4BlAbqAJIGygCSBrQAkQagAJAGjACYChYKdAlkCI0I/gbVB9cFWgfqBBUHRgTiBrsDwAZHA6UG5gKVBpoChgZSAnwGGgJ1BuwBbwbDAWgGmQFjBnUBXgZUAVwGNgFXBhgB2Qp/CtgJDwkHCdoHZQjhBtUHAAZvB0kFIAekBOUGGATCBrQDpgZjA40GDgN6BscCagaPAmAGYQJVBiwCTAb/AUgG4AEtCwMLYQrgCacJ2ggACecHbggTB/UHXQaVB7wFRQckBQYHoQTOBiIEsQbUA5QGgwN7BjkDZgtcC7MKagoDCnEJcQmcCO0I5AdtCCYH+gd9BpkH5wVGB1UFAgfXBIsLkwvuCsAKTgrjCckJKwlKCXgIwQi3B0cIBwemC7sLEQv5Cn8KNAryCXIJagmwCLsL2gsoCx4LjgpYCscL7At1CugImwkkB/IIvgWOCMwESAgFBBYIZQP2B+kC2Ad+AscHNAK4B+0BrQe0AaAHfAGWB0YBkAcZAYgH8ADzCgcKKApyCIgJMAf2CA8GmAgyBVsIkgQnCAIEBAiOA+UHKAPOB84CugeDAqoHQgKdBwgCkQfXAYUHpAF+B3sBdwdYAR8LbgpkCg8JzwnvB1MJ+gbmCB0Gngh/BV4I4gQsCF4EDAj8A+4HogPUB08DvgcEA6sHxAKeB4oCkgdXAoYHHgJ+B/cBXwv0CscK2gk6CtcIwQn2B1QJLQf6CHsGrAjfBXoIXQVICOgEGwh0BAAIKATkB9kDygeIA7MHSAOgBwoDjwtZCwULYwp+CmwJDAqjCK4J7gdQCUEH+wiiBrAIEwZ+CKQFSQgxBSIIyQSsC5ELLwu7CrQK5QlNCjAJ7AmACIgJzgcwCS8H2QiHBr0LuAtGC/EK2Ao0Cm4KeQkDCsAIoQkKCNML2wtfCyAL6ApZCnUKiwneC+4LXgsiC/gK+AhsClIHCgoXBsAJFwWJCVgEWgmsAzkJKgMbCbgCCAlqAvcIHgLnCNkB2giiAcsIYwFMCxcKxgqgCGUKgQcKCmMGxQmOBZEJ3QRmCUwERAnUAykJaQMQCQsD+gi4AuUIbQLUCCsCxQjrAbcIsAFqC3gK6AomCYMKGAg3CjUH9AlmBsIJyAWRCS0FagmuBEwJRgQyCesDGQmPAwEJQAPuCP0C3Ai6AswIfgLCCEsCtggfApIL9wonC+MJywr8CH0KKQg7Cm8H/wnCBs0JMQajCawFfgk0BVoJxQRDCXcELAkmBBIJ0gP+CI0D7QhPA9kIBgO4C2ALUgtrCvYKjAmoCsAIaQobCDAKeQcACu4G0wlsBqwJ/AWGCYsFYgkjBUQJxwQsCXQEyAuQC3QLxwoaC/YJ0gpECY8KnAhXCgQIIQp1B/QJ6AbICXoG1wu4C4YL+go5C0kK7wqbCakK8QhoCk8I6AvgC5ILIgtBC28K8Aq4CeoL6wuTCzELeAsaCSYLhwfqClwGtgpfBY0KmgRuCu4DVQpfA0EK6gI0CpsCKQpKAh4K/QGoCzQKXAvVCCILyAfnCqsGvArcBZUKKAV0CosEXAoVBEgKpwM0CkYDJQruAhYKnQIJClIC/wkNArULjApwC1IJNgtXCAMLdgfUCqsGswoDBpMKdQV4CvgEYQqLBE8KMgQ8CtIDKgp7Ax4KNgMTCu4CCAqyAv0JdgLOCwkLjgsFClcLKwknC2YI/gqvB9oKEAe7CnwGngrwBYUKgAVuChQFXArCBEsKbAQ6ChwEKArLAxwKiwMOCkED5QtwC6oLiwp0C7cJRQv4CB0LWQj2CrkH1wo3B7gKtgaeCkQGhgrbBXEKdgVcChgFSwrIBDoKbwTqC5cLuQvaCoYLGQpZC3UJLgvUCA0LSQjqCrsHyQo8B6sKygaOClUG8wvCC8ELDwuRC2cKZgvICTgLJwkRC5UI8QoUCPkL5wvECzQLkwuQCmIL5gk2C0wJ+wv0C7sLNgvWCzkJrwu2B5ALkgZ0C5UFWQvNBEQLIwQ0C4cDJAsWAxkLwgIPC3EC/wtXCugLEQnRCwoIuAv1BqMLIQaMC3AFegvTBGoLUgRgC+MDVguFA0oLHwNCC88CEAy0CgAMkAnxC6AI3Qu9B8wLAge7C1IGsAvDBaULTAWZC9cEkQt/BIkLIQSAC8cDegt8A3ILLANqC+4CFQwrCwwMPgoEDHAJ+gu0CPALDAjlC3EH2wvbBtQLVQbIC9wFwgt0BbkLGgWxC8kEqgtvBKMLJgSZC9MDkguKAx8MjwscDL4KFQz7CQ8MRwkIDLYI/wsgCPwLnwf0CyYH7AuvBuILRgbeC9wF1guPBc4LMwXKC+UEwguSBCMMsQsjDA8LHQxaChsMxgkUDC4JEgyuCAwMLwgIDLgHAwxOB/0L0Qb2C2YG8gsLBiUM3QsnDEALJwyqCiUMGAokDIoJIAwQCR0MkAgbDBoIFQyqByMM/gsqDGMLKgzhCiwMQgosDMEJLQxCCSMMCQwtDHALMAzkCjwMZAk8DPAHNgzJBioMyQUeDAIFFgxWBAwMuAMGDEcD/QvsAlkMgwp1DFYJhwxUCJMMRgeeDHsGoQzFBaMMJQWjDJ0EoQwnBJ8MwgOeDF0DYgzmCo4M1QmrDPUIxQwbCNYMYQflDLMG7QwkBvgMsAUBDTQFBA3YBAwNegQNDR8EDw3SA1oMVguKDH4KsAy9CdAMDgnqDHIIAw3eBxcNUwcqDdwGOg1aBkgN3AVTDZAFXQ05BWQN4ARoDZQEcA04BEwMqgt+DPcKqwxGCtAMoAnsDBgJBw2LCCANEgg2DZ8HSQ0wB14NxwZtDWwGeg0TBowNtAWWDWwFog0cBUoMygttDDcLmgycCrsMGArdDJIJ+QwZCRUNmwgqDS8IPA3LB1ENWgdiDfkGcQ2iBoENRAZCDO4LbQxoC5UM4gq4DF4K2AzjCfIMdwkNDQQJKA2QCD8NKAhSDcQHZg1bBzsMDAxnDIsLjQwNC7IMjArSDBYK8AymCQ4NLQk4DBYMaAyWC5IMHQuoDJsJ2gwvCPkMEwcODQ8GGg1HBSENnQQoDfwDKA2GA88Mwgo2DcAJjg3TCOMN0wchDggHVA5SBn8OqQWkDh4Fwg6kBNoOOATIDC0LSA1ACq0NeQkODrkIYQ4GCKoOagfqDt4GJA9dBlkP4gWBD4UFsg8YBZ8MhwsMDdIKcg0jCs0NhgkYDv0IYw5yCKQO9wffDoMHGQ8KB1YPjwZ/DzkGqw/gBdAPlAV/DMsL4gw1C0QNngqiDQoK6A2UCTMOFQl3DqMIsw48CO0O1wchD3UHVA8WB30PygarD3QGdAzoC8gMcQsiDe8KbQ2ACrUNEgr+DZ4JRA4zCYYOywi9Dm4I+Q4ICCUPugdXD2QHYgwEDLYMmwsKDSYLWQ25Cp8NWArjDfEJJA6QCWgOJgmnDsEI4w5fCFIMHAynDLgL/wxSC04N6QqXDYsK4A0iCiUOwAlNDCQMogzCC/oMXgsyDe4Jrw2UCAQOgAdMDn4Gjw6yBbwOAwXjDnIENw0NC+YNJQp8DkwJEg9cCIMPkwfwD+QGVBA+Bq0QrgXyEDwFKg18CwIOtgq1DgkKWg9bCekPuwhnECkI2RCYB0IREQeXEZ8G4RE5Bu4MwgujDTgLVw6tCvkOKAp4D7kJCBA5CYEQyQjzEFsIZxHnB9sRcgcwEh0HuAz5C10NigsBDhoLpA6pCigPRgq2D9sJLhB8CaUQGwkUEcIIhBFmCOURFAhLEroHoAwNDCsNuQvADVgLQA4EC7kOsgo8D1YKtw/4CSgQowmVEE4JEBHrCGERqwiGDCAMBA3YC44NhQsTDjULgQ7uCgEPlgp2D0QK7A/sCVoQmwlsDDAM7AzsC3ANogvyDVQLZQ4MC+oOtgpkDDYM5Qz0C2cNrAuqDTkKeQ78CBkP9AelDwEHJBAsBpAQeAWDDUwLdg57Ck4PugkpEOQI4RAiCIERbwcQEskGiBI7BnoNuQubDiMLlg+UCooQ/AldEXMJLhLhCN8SXAh/E9sHChRlBysN9QscDpMLCg8rC+gPvgqjEFsKYhHtCRUShQm/EhkJZROpCAoUNQjgDBoMuw3QC44OfQtcDyQLDBDVCs8QcwpmESQKCRLKCZkSdQkzExoJtRPICL0MKQxvDfALMw6rC88OcQt4DywLHRDgCr0QkQpgET4K5RH1CX8SoAmgDDUMPQ0HDOoNzguKDpMLHw9aC8gPEgtjEMoK+hCBCoAMQAwgDRQMwQ3iC2IOpwv2DnILog8rC3YMRQwWDRsMuA3sCy0OlgpQD3cJNxB5CAURgQepEa4GPBLqBcwNjQsKD9oKKxAwCkwRcwlGEr0ILxMMCAkUYAfGDfwLMQ+ZC3oQMAvIEbUK8xI6ChMUuQkEFUEJ/BXBCFkNIgyDDuILnw+cC7oQSguwEfsKtRKdCpwTPwpyFOIJWhV4CSoWDwkEDTsMCg4SDAsP3wsJEKQL7BBmC+MRGQufEtgKehOHCkEUPAoUFecJ3AxFDLQNKAycDgIMWg/eCzYQrQsIEXgLyBFBC60S/AphE78KugxMDHYNNQxADhoMCw/7C8gP1gukEKQLaBFzCygSPguSDFAMVA0/DBAOKAzYDgoMjw/pC4UMUwxIDUQMBg4uDA==";

const MU_WX: f64 = 0.31006; // Illuminant C 2° white chromaticity
const MU_WY: f64 = 0.31616;

// standard base64 (with '=' padding) to bytes, as atob decodes it
fn base64_decode(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0);
    for ch in s.bytes().take_while(|&ch| ch != b'=') {
        let v = match ch {
            b'A'..=b'Z' => ch - b'A',
            b'a'..=b'z' => ch - b'a' + 26,
            b'0'..=b'9' => ch - b'0' + 52,
            b'+' => 62,
            _ => 63,
        };
        acc = acc << 6 | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

struct Renotation { cnt: [u8; 360], off: [i32; 361], xy: Vec<u16> }

impl Renotation {
    fn new() -> Renotation {
        let (mut cnt, mut off) = ([0u8; 360], [0i32; 361]);
        for (i, ch) in MU_COUNTS.bytes().enumerate() { cnt[i] = ch - 48; off[i + 1] = off[i] + cnt[i] as i32; }
        let xy = base64_decode(MU_PACK).chunks_exact(2).map(|b| b[0] as u16 | (b[1] as u16) << 8).collect();
        Renotation { cnt, off, xy }
    }

    fn at(&self, hi: usize, vi: usize, ci: usize) -> [f64; 2] {
        let o = (self.off[hi * 9 + vi] as usize + ci) * 2;
        [self.xy[o] as f64 / 1e4, self.xy[o + 1] as f64 / 1e4]
    }

    // chroma-interpolated xy at fractional chroma c in cell (hi, vi), clamped to its gamut (cellXY)
    fn cell(&self, hi: usize, vi: usize, c: f64) -> [f64; 2] {
        let n = self.cnt[hi * 9 + vi] as usize;
        if c <= 0.0 { return [MU_WX, MU_WY]; }
        let ci = c / 2.0 - 1.0;
        let c0 = ci.floor();
        if c0 < 0.0 { let [x, y] = self.at(hi, vi, 0); let t = c / 2.0; return [MU_WX + (x - MU_WX) * t, MU_WY + (y - MU_WY) * t]; }
        if c0 >= n as f64 - 1.0 { return self.at(hi, vi, n - 1); }
        let ([x0, y0], [x1, y1]) = (self.at(hi, vi, c0 as usize), self.at(hi, vi, c0 as usize + 1));
        let t = ci - c0;
        [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]
    }

    // an empty cell falls back to its hue neighbour, then to white (toXyY's corner)
    fn corner(&self, hi: usize, vi: usize, c: f64, alt: usize) -> [f64; 2] {
        let k = if self.cnt[hi * 9 + vi] != 0 { hi } else if self.cnt[alt * 9 + vi] != 0 { alt } else { return [MU_WX, MU_WY] };
        self.cell(k, vi, c)
    }
}

// Newhall 1943 value function V → Y (the renotation table's Y column), and its Newton inverse
fn mu_y(v: f64) -> f64 { 1.2219 * v - 0.23111 * v.powf(2.0) + 0.23951 * v.powf(3.0) - 0.021009 * v.powf(4.0) + 0.0008404 * v.powf(5.0) }

fn mu_v(y: f64) -> f64 {
    let mut v = 10.0 * (max2(y, 0.0) / 100.0).cbrt();
    for _ in 0..40 {
        let f = mu_y(v) - y;
        let d = 1.2219 - 0.46222 * v + 0.71853 * v.powf(2.0) - 0.084036 * v.powf(3.0) + 0.004202 * v.powf(4.0);
        v -= f / d;
        if f.abs() < 1e-9 { break; }
    }
    v
}

fn mu_xyy(t: &Renotation, h: f64, v: f64, c: f64) -> [f64; 3] {
    let yy = mu_y(v);
    if c <= 0.0 { return [MU_WX, MU_WY, yy]; }
    let vi0 = max2(0.0, min2(8.0, v.floor() - 1.0));
    let vi1 = min2(8.0, vi0 + 1.0);
    let tv = max2(0.0, min2(1.0, (v - 1.0) - vi0));
    let hf = ((((h - 1e-9) % 100.0) + 100.0) % 100.0) / 2.5 - 1.0;
    let h0 = ((hf.floor() as i32 % 40 + 40) % 40) as usize;
    let h1 = (h0 + 1) % 40;
    let th = hf - hf.floor();
    let ([ax, ay], [bx, by]) = (t.corner(h0, vi0 as usize, c, h1), t.corner(h1, vi0 as usize, c, h0));
    let ([cx, cy], [dx, dy]) = (t.corner(h0, vi1 as usize, c, h1), t.corner(h1, vi1 as usize, c, h0));
    let (x0, y0, x1, y1) = (ax + (bx - ax) * th, ay + (by - ay) * th, cx + (dx - cx) * th, cy + (dy - cy) * th);
    [x0 + (x1 - x0) * tv, y0 + (y1 - y0) * tv, yy]
}

// coarse search over the renotation's hue × chroma nodes at this value, then 2-D Newton on (H, C)
fn xyy_munsell(t: &Renotation, x: f64, y: f64, yy: f64) -> [f64; 3] {
    let v = mu_v(yy);
    if (x - MU_WX).hypot(y - MU_WY) < 1e-4 { return [0.0, v, 0.0]; }
    let (mut h, mut c, mut bd, mut seen) = (0.0, 0.0, 0.0, false);
    for hi in 0..40 {
        for cc in (2..=38).step_by(2) {
            let [fx, fy, _] = mu_xyy(t, 2.5 * (hi + 1) as f64, v, cc as f64);
            let d = (fx - x).powf(2.0) + (fy - y).powf(2.0);
            if !seen || d < bd { h = 2.5 * (hi + 1) as f64; c = cc as f64; bd = d; seen = true; }
        }
    }
    for _ in 0..60 {
        let [fx, fy, _] = mu_xyy(t, h, v, c);
        let (ex, ey) = (fx - x, fy - y);
        if ex.hypot(ey) < 1e-8 { break; }
        let ([hx, hy, _], [kx, ky, _]) = (mu_xyy(t, h + 0.05, v, c), mu_xyy(t, h, v, c + 0.05));
        let (j00, j01) = ((hx - fx) / 0.05, (kx - fx) / 0.05);
        let (j10, j11) = ((hy - fy) / 0.05, (ky - fy) / 0.05);
        let det = j00 * j11 - j01 * j10;
        if det.abs() < 1e-12 { break; }
        let (s_h, s_c) = ((j11 * -ex - j01 * -ey) / det, (-j10 * -ex + j00 * -ey) / det);
        h = ((h + max2(-5.0, min2(5.0, s_h))) % 100.0 + 100.0) % 100.0;
        c = max2(0.0, c + max2(-5.0, min2(5.0, s_c)));
    }
    [h, v, c]
}

// setup, untimed: deterministic sRGB (XorShift32) → linear → XYZ → xyY, the library's own steps
fn sgn(v: f64) -> f64 { if v < 0.0 { -1.0 } else { 1.0 } }
fn srgb_dec(v: f64) -> f64 { let a = v.abs(); sgn(v) * (if a > 0.04045 { ((a + 0.055) / 1.055).powf(2.4) } else { a / 12.92 }) }
// black has no chromaticity: it sits at the D65 white's (x, y)
fn xyz_xyy(x: f64, y: f64, z: f64) -> [f64; 3] {
    let sum = x + y + z;
    if sum == 0.0 { return [0.3127, 0.329, y]; }
    [x / sum, y / sum, y]
}

fn mk_input(n: usize) -> Vec<f64> {
    let mut out = vec![0.0; n * 3];
    let mut s = 0x1234abcdu32;
    for p in out.chunks_exact_mut(3) {
        let mut c = [0.0; 3];
        for ck in c.iter_mut() { s ^= s << 13; s ^= s >> 17; s ^= s << 5; *ck = srgb_dec(s as f64 / 4294967296.0); }
        let x = 100.0 * (0.41239079926595 * c[0] + 0.35758433938387 * c[1] + 0.18048078840183 * c[2]);
        let y = 100.0 * (0.21263900587151 * c[0] + 0.71516867876775 * c[1] + 0.072192315360733 * c[2]);
        let z = 100.0 * (0.019330818715591 * c[0] + 0.11919477979462 * c[1] + 0.95053215224966 * c[2]);
        let [cx, cy, cyy] = xyz_xyy(x, y, z);
        p[0] = cx; p[1] = cy; p[2] = cyy;
    }
    out
}

fn to_munsell(t: &Renotation, src: &[f64], dst: &mut [f64]) {
    for (s, d) in src.chunks_exact(3).zip(dst.chunks_exact_mut(3)) {
        let [h, v, c] = xyy_munsell(t, s[0], s[1], s[2]);
        d[0] = h; d[1] = v; d[2] = c;
    }
}

fn main() {
    let table = Renotation::new();
    let src = mk_input(N_COLORS);
    let mut dst = vec![0.0; N_COLORS * 3];

    for _ in 0..N_WARMUP { to_munsell(&table, &src, &mut dst); }

    let mut samples = [0.0; N_RUNS];
    for sample in samples.iter_mut() {
        let t0 = Instant::now();
        to_munsell(&table, &src, &mut dst);
        *sample = t0.elapsed().as_secs_f64() * 1000.0;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        checksum_f64_near(&dst),
        N_COLORS,
        1,
        N_RUNS
    );
}
