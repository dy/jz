// json.goose: Goose port of json.js (same source, passes and checksum): the
// JSON text parsed at run time every pass into the standard library's
// document tree, then walked by key, as JSON.parse and property reads do.

import bench from "../_lib";
import bench.stdjson;     // the standard library's json: see _lib/stdjson.goose

let SRC = "{\"items\":[{\"id\":1,\"kind\":2,\"value\":10},{\"id\":2,\"kind\":3,\"value\":20},{\"id\":3,\"kind\":5,\"value\":30}],\"meta\":{\"scale\":7,\"bias\":11}}";
let N_ITERS = 512;
let N_RUNS = 21;
let N_WARMUP = 5;

fn int(n: json::Node?) -> i64 {
    let v, ok = json::as_i64(n);
    assert(ok);
    return v;
}

fn walk() -> u32 {
    var h: u32 = 0x811c9dc5;
    for i in N_ITERS {
        var doc: json::Node[>..] = [];
        var decoded: u8[>..] = [];
        let o, err = json::parse(SRC, doc, decoded);
        guard o else { abort(err); }
        let items = json::member(o, "items");
        let meta = json::member(o, "meta");
        guard items else { abort("no items"); }
        var s = int(json::member(meta, "bias"));
        json::each(items) { it => s += int(json::member(it, "id")) * int(json::member(meta, "scale"))
                                       + int(json::member(it, "kind")) + int(json::member(it, "value")); };
        h = mix(h, s as! u32);
    }
    return h;
}

fn main() {
    var cs: u32 = 0;
    for i in N_WARMUP { cs = walk(); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        cs = walk();
        t = now_ms() - t0;
    }
    print_result(median_us(samples), cs, N_ITERS, 4, N_RUNS);
}
