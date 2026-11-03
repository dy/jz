// jsontransform.goose: Goose port of jsontransform.js (same document,
// transform, passes and checksum): an API gateway's JSON round trip. The text
// is parsed every pass into the standard library's document tree, the generic
// value JSON.parse builds (strings with escapes decoded onto a buffer beside
// it), and walked by key; the kept orders are records pointing into the tree,
// and the response goes out through the library's json writer, the numbers
// laid out as Number::toString lays them out (_lib/ecmajson.goose). The
// document is written the same way once, outside the timed region.

import bench from "../_lib";
import bench.ecmajson;
import json;
import math;

let N = 1024;               // orders in the document
let N_RUNS = 21;
let N_WARMUP = 5;

let NAMES = ["Ada Lovelace", "José Martí", "Zoë Kravitz", "Søren Kierkegaard", "李小龙",
             "Björk Guðmundsdóttir", "Chloé \"Coco\" Dupont", "Mikhail Bulgakov", "Grace Hopper", "Alan Turing"];
let PRODUCTS = ["Desk lamp", "Cable 2m\\5m", "Mug \"Hello\"", "Notebook, A5", "Tea – Darjeeling",
                "Café crème", "Gift card 🎁", "Line1\nLine2", "Tab\tSeparated", "Ångström ruler", "Pens (12)",
                "Ruler 30cm"];
let TAGS = ["bulk", "express", "fragile", "gift", "priority", "return"];
let DISCOUNTS: f64[8] = [0.0, 0.05, 0.1, 0.125, 0.15, 0.2, 0.25, 0.3];

var seed: u32 = 0x2545f491;

fn next() -> u32 {
    seed ^= seed << 13;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    return seed;
}

// JSON.stringify({ page: 1, per: N, orders }) of the generated orders.
fn make_document(out: u8[>..]&) {
    out.append("{\"page\":1,\"per\":");
    json::format_int(out, N);
    out.append(",\"orders\":[");
    for i in N {
        if i > 0 { out.push(','); }
        out.append("{\"id\":");
        json::format_int(out, 1000000 + i);
        var items: u8[>..] = [];
        let n_items = 1 + next() % 6;
        for k in n_items {
            if k > 0 { items.push(','); }
            items.append("{\"sku\":\"SKU-");
            format(items, 10000 + next() % 90000);
            items.append("\",\"name\":");
            json::format_string(items, PRODUCTS[next() % PRODUCTS.len]);
            items.append(",\"qty\":");
            json::format_int(items, 1 + next() % 9);
            items.append(",\"price\":");
            format_number_js(items, (99 + next() % 19901) / 100.0);
            items.push('}');
        }
        var tags: u8[>..] = [];
        let n_tags = next() % 4;
        for k in n_tags {
            if k > 0 { tags.push(','); }
            json::format_string(tags, TAGS[next() % TAGS.len]);
        }
        let r = next();
        out.append(",\"status\":");
        json::format_string(out, if r & 7 == 0 { "cancelled" } else { "paid" });
        out.append(",\"customer\":{\"id\":");
        json::format_int(out, 5000 + r % 3000);
        out.append(",\"name\":");
        json::format_string(out, NAMES[(r >> 4) % NAMES.len]);
        out.append(",\"vip\":");
        json::format_bool(out, r & 64 != 0);
        out.append("},\"items\":[");
        out.append(items);
        out.append("],\"discount\":");
        format_number_js(out, DISCOUNTS[(r >> 8) % DISCOUNTS.len]);
        out.append(",\"tags\":[");
        out.append(tags);
        out.append("]}");
    }
    out.append("]}");
}

fn num(n: json::Node?) -> f64 {
    let v, ok = json::as_f64(n);
    assert(ok);
    return v;
}

fn string(n: json::Node?) -> const u8[:] {
    let s, ok = json::as_string(n);
    assert(ok);
    return s;
}

struct Kept { id: i64, customer: const u8[:], vip: bool, lines: i64, first: const u8[:], total: f64,
              tags: json::Node& }

fn transform(text: u8[:], out: u8[>..]&) {
    var doc: json::Node[>..] = [];
    var decoded: u8[>..] = [];
    let root, err = json::parse(text, doc, decoded);
    guard root else { abort(err); }
    let orders = json::member(root, "orders");
    guard orders else { abort("no orders"); }
    var kept: Kept[>..] = [];
    var tag_counts: i64[6] = [0; 6];
    var revenue = 0.0;
    json::each(orders) { o =>
        guard string(json::member(o, "status")) == "paid";
        let items = json::member(o, "items");
        guard items else { abort("no items"); }
        var sub = 0.0;
        var lines = 0;
        json::each(items) { it =>
            sub += num(json::member(it, "qty")) * num(json::member(it, "price"));
            lines += 1;
        };
        // C's round, half away from zero, is Math.round on a positive total
        let total = round(sub * (1.0 - num(json::member(o, "discount"))) * 100.0) / 100.0;
        guard total >= 20.0;
        revenue += total;
        let tags = json::member(o, "tags");
        guard tags else { abort("no tags"); }
        json::each(tags) { t =>
            let name = string(t);
            for tag, j in TAGS { if name == tag { tag_counts[j] += 1; break; } }
        };
        let customer = json::member(o, "customer");
        let id, ok = json::as_i64(json::member(o, "id"));
        let vip, okv = json::as_bool(json::member(customer, "vip"));
        assert(ok && okv);
        kept.push(Kept { id, string(json::member(customer, "name")), vip, lines,
                         string(json::member(items.first, "name")), total, tags });
    };
    let page, okp = json::as_i64(json::member(root, "page"));
    assert(okp);

    out.clear();
    out.push('{');
    json::format_key(out, "page");
    json::format_int(out, page);
    out.push(',');
    json::format_key(out, "count");
    json::format_int(out, kept.len);
    out.push(',');
    json::format_key(out, "revenue");
    format_number_js(out, round(revenue * 100.0) / 100.0);
    out.push(',');
    json::format_key(out, "tagCounts");
    out.push('{');
    for tag, j in TAGS {
        if j > 0 { out.push(','); }
        json::format_key(out, tag);
        json::format_int(out, tag_counts[j]);
    }
    out.append("},");
    json::format_key(out, "orders");
    out.push('[');
    for &k, i in kept {
        if i > 0 { out.push(','); }
        out.push('{');
        json::format_key(out, "id");
        json::format_int(out, k.id);
        out.push(',');
        json::format_key(out, "customer");
        json::format_string(out, k.customer);
        out.push(',');
        json::format_key(out, "vip");
        json::format_bool(out, k.vip);
        out.push(',');
        json::format_key(out, "lines");
        json::format_int(out, k.lines);
        out.push(',');
        json::format_key(out, "first");
        json::format_string(out, k.first);
        out.push(',');
        json::format_key(out, "total");
        format_number_js(out, k.total);
        out.push(',');
        json::format_key(out, "tags");
        out.push('[');
        var n = 0;
        json::each(k.tags) { t =>
            if n > 0 { out.push(','); }
            json::format_string(out, string(t));
            n += 1;
        };
        out.append("]}");
    }
    out.append("]}");
}

fn main() {
    var text: u8[>..] = [];
    make_document(text);
    var out: u8[>..] = [];
    for i in N_WARMUP { transform(text, out); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        transform(text, out);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), mix_utf16(0x811c9dc5, out), N, 3, N_RUNS);
}
