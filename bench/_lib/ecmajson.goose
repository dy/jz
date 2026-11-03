// ECMAScript's JSON text over the standard library's json writer, for the
// stringify and jsontransform ports (`import bench.ecmajson;`), and the
// checksum the JS cases take over that text's UTF-16 code units.
//
// json::format_number writes the shortest digits that read back as the
// value, as Number::toString chooses them, in serde_json's layout: `1.0` for
// an integer, an exponent from 1e16 up and below 1e-5, unsigned when positive
// (`1e21`). JSON.stringify writes Number::toString's layout: `1`, fixed
// notation from 1e-6 below 1e21, and `1e+21`. format_number_js keeps the
// digits and lays them out the ECMAScript way.

import json;

fn format_number_js(out: u8[>..]&, v: f64) {
    if v == 0.0 { out.push('0'); return; }          // JSON.stringify(-0) is "0"
    let at = out.len;
    json::format_number(out, v);
    let n = out.len;
    if out[n - 2] == '.' && out[n - 1] == '0' { out.pop_n(2); return; }
    var e = at;
    while e < n && out[e] != 'e' { e++; }
    if e == n { return; }                           // fixed, as ECMAScript writes it
    // d.ddd e x: the digits and x + 1, the power of ten they are a fraction of
    let neg = out[at] == '-';
    var digits: u8[..20] = [];
    for c in out[(if neg { at + 1 } else { at })..e] { if c != '.' { digits.push(c); } }
    let x, ok = parse_int(out[e + 1..n]);
    assert(ok);
    let point = x + 1;
    out.pop_n(n - at);
    if neg { out.push('-'); }
    let k = digits.len;
    if point >= k && point <= 21 {
        out.append(digits);
        for i in point - k { out.push('0'); }
    } else if point > 0 && point <= 21 {
        out.append(digits[..point]);
        out.push('.');
        out.append(digits[point..]);
    } else if point > -6 && point <= 0 {
        out.append("0.");
        for i in -point { out.push('0'); }
        out.append(digits);
    } else {
        out.push(digits[0]);
        if k > 1 {
            out.push('.');
            out.append(digits[1..]);
        }
        out.push('e');
        out.push(if x < 0 { '-' } else { '+' });
        format(out, abs(x));
    }
}

// mix over s as the JS cases fold a string: its length in UTF-16 code units,
// then each unit (s.length, then every s.charCodeAt(j)).
fn mix_utf16(h: u32, s: u8[:]) -> u32 {
    var units: u32 = 0;
    each_utf8(s) { cp => units += if cp >= 0x10000 { 2 } else { 1 }; };
    var x = mix(h, units);
    each_utf8(s) { cp =>
        if cp >= 0x10000 {
            x = mix(x, (0xD800 + ((cp - 0x10000) >> 10)) as! u32);
            x = mix(x, (0xDC00 + ((cp - 0x10000) & 0x3FF)) as! u32);
        } else {
            x = mix(x, cp as! u32);
        }
    };
    return x;
}
