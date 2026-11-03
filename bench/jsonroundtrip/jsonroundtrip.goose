// jsonroundtrip.goose: Goose port of jsonroundtrip.js (Perry's
// bench_json_roundtrip.ts, https://github.com/PerryTS/perry, benchmarks/suite,
// MIT; same document, passes and checksum): JSON.parse then JSON.stringify of
// one ~1 MB document of 10,000 records. The text is parsed every pass into the
// standard library's document tree, the generic value JSON.parse builds, and
// written back by walking it, each value through the library's json writer
// (format_key, format_string, format_int, format_bool) as the library has its
// callers do, the numbers laid out as Number::toString lays them out
// (_lib/ecmajson.goose). The tree holds an integer's text as an Int and any
// other number as a Num, so an integer goes out through format_int as
// JSON.stringify writes it. The document is written the same way once,
// outside the timed region. The text is ASCII, so Perry's sum of each run's
// parsed length and text length takes its byte length as its UTF-16 length.

import bench from "../_lib";
import bench.ecmajson;
import json;

let N = 10000;              // records in the document
let N_RUNS = 21;
let N_WARMUP = 5;

// JSON.stringify(items) of the generated records.
fn make_blob(out: u8[>..]&) {
    out.push('[');
    for i in N {
        if i > 0 { out.push(','); }
        out.push('{');
        json::format_key(out, "id");
        json::format_int(out, i);
        out.push(',');
        json::format_key(out, "name");
        json::format_string(out, str("item_", i));
        out.push(',');
        json::format_key(out, "value");
        format_number_js(out, i * 3.14159);
        out.push(',');
        json::format_key(out, "tags");
        out.push('[');
        json::format_string(out, str("tag_", i % 10));
        out.push(',');
        json::format_string(out, str("tag_", i % 5));
        out.append("],");
        json::format_key(out, "nested");
        out.push('{');
        json::format_key(out, "x");
        json::format_int(out, i);
        out.push(',');
        json::format_key(out, "y");
        json::format_int(out, i * 2);
        out.append("}}");
    }
    out.push(']');
}

// format_number_js through a buffer of its own: it rewrites the digits it
// laid out, shrinking its buffer, and the walk may call only what grows `out`
// while it holds a reference into the tree (§5.1).
fn write_number(out: u8[>..]&, v: f64) {
    var t: u8[>..] = [];
    format_number_js(t, v);
    out.append(t);
}

// Any value of the tree, as JSON.stringify walks the parsed value.
recursive fn write(out: u8[>..]&, n: json::Node&) {
    match n.val {
        Null => out.append("null"),
        Bool b => json::format_bool(out, b.v),
        Int i => json::format_int(out, i.v),
        Num x => write_number(out, x.v),
        Str t => json::format_string(out, t.s),
        Arr => write_children(out, n.first, false, '[', ']'),
        Obj => write_children(out, n.first, true, '{', '}'),
    }
}

recursive fn write_children(out: u8[>..]&, first: json::Node?, keyed: bool, open: u8, close: u8) {
    out.push(open);
    var c = first;
    var k = 0;
    while c {
        if k > 0 { out.push(','); }
        if keyed { json::format_key(out, c.key); }
        write(out, c);
        c .= c.next;
        k++;
    }
    out.push(close);
}

// JSON.stringify(JSON.parse(text)) into out, returning the parsed array's length.
fn round_trip(text: u8[:], out: u8[>..]&) -> i64 {
    var doc: json::Node[>..] = [];
    var decoded: u8[>..] = [];
    let root, err = json::parse(text, doc, decoded);
    guard root else { abort(err); }
    out.clear();
    write(out, root);
    return match root.val {
        Arr a => a.count,
        _ => 0,
    };
}

fn main() {
    var blob: u8[>..] = [];
    make_blob(blob);
    var out: u8[>..] = [];
    for i in N_WARMUP { round_trip(blob, out); }

    var count: u32 = 0;
    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        let length = round_trip(blob, out);
        count += length as! u32;
        count += out.len as! u32;
        t = now_ms() - t0;
    }
    print_result(median_us(samples), mix_utf16(mix(0x811c9dc5, count), out), N, 2, N_RUNS);
}
