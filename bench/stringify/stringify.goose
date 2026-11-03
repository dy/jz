// stringify.goose: Goose port of stringify.js (same records, passes and
// checksum): JSON serialization of order records, every record on one line
// and every 16th also pretty-printed at an indent of 2. Records are inline
// structs (items and tags limited arrays, the short strings inline, names
// views of the static tables); the writer is the standard library's json
// (format_key, format_string, format_int, format_bool), called member by
// member as the library has its callers do, the numbers laid out as
// Number::toString lays them out (_lib/ecmajson.goose). The lines of a pass
// go into one text buffer, refilled each pass, their ends beside it.

import bench from "../_lib";
import bench.ecmajson;
import json;

let N = 1024;               // records per pass
let DUMP = 16;              // every DUMP-th record is also pretty-printed
let N_RUNS = 21;
let N_WARMUP = 5;

let NAMES = ["Ada Lovelace", "José Martí", "Zoë Kravitz", "Søren Kierkegaard", "李小龙",
             "Ngũgĩ wa Thiong'o", "Björk Guðmundsdóttir", "Chloé \"Coco\" Dupont", "Mikhail Bulgakov",
             "Ἀριστοτέλης", "Grace Hopper", "Alan Turing"];
let CITIES = ["Montréal", "Zürich", "København", "São Paulo", "東京", "Reykjavík", "Kraków", "Toronto"];
let PRODUCTS = ["Desk lamp", "Cable 2m\\5m", "Mug \"Hello\"", "Notebook, A5", "Tea – Darjeeling",
                "Café crème", "Gift card 🎁", "Line1\nLine2", "Tab\tSeparated", "Bell\x07", "Ångström ruler",
                "naïve façade", "Résumé paper", "Pens (12)", "Stand/Arm", "Ruler 30cm"];
let TAGS = ["gift", "express", "fragile", "bulk", "return", "priority"];
let NOTES = ["Leave at door", "Call \"front desk\"", "Ring twice\r\nthen wait", "Back\\slash",
             "form\x0cfeed", "checked ✓", "ctrl\x1fchar", "Merci beaucoup!"];
let DISCOUNTS: f64[8] = [0.0, 0.05, 0.1, 0.125, 0.15, 0.2, 1.0 / 3.0, 0.07];

struct Address { city: const u8[:], zip: u8[..8] }
struct Customer { id: i64, name: const u8[:], email: u8[..24], vip: bool, address: Address }
struct Item { sku: u8[..12], name: const u8[:], qty: i64, price: f64 }
struct Geo { lat: f64, lon: f64 }
struct Record {
    id: i64, created: i64, customer: Customer, items: Item[..5], total: f64, discount: f64,
    tags: (const u8[:])[..3], note: const u8[:], has_note: bool, geo: Geo, rate: f64,
}

var seed: u32 = 0x1234abcd;

fn next() -> u32 {
    seed ^= seed << 13;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    return seed;
}

fn make_record(i: i64) -> Record {
    var items: Item[..5] = [];
    let n_items = 1 + next() % 5;
    var total = 0.0;
    for k in n_items {
        let qty = 1 + next() % 9;
        let price = (99 + next() % 99901) / 100.0;
        total += qty * price;
        var sku: u8[..12] = [];
        format(sku, "SKU-", 10000 + next() % 90000);
        items.push(Item { sku, PRODUCTS[next() % PRODUCTS.len], qty, price });
    }
    var tags: (const u8[:])[..3] = [];
    let n_tags = next() % 4;
    for k in n_tags { tags.push(TAGS[next() % TAGS.len]); }
    let r = next();
    var email: u8[..24] = [];
    format(email, "user", r % 3000, "@example.com");
    var zip: u8[..8] = [];
    format(zip, "H", (r >> 12) % 10, "X ", (r >> 16) % 10, "Y", (r >> 20) % 10);
    let lat = (next() % 180000000) / 1e6 - 90.0;
    let lon = (next() % 360000000) / 1e6 - 180.0;
    let rate = (1 + next() % 999) * 1.5e-7;
    return Record {
        id: 1000000 + i,
        created: 1767225600000 + i * 61003,
        customer: Customer { 5000 + r % 3000, NAMES[r % NAMES.len], email, r & 16 != 0,
                             Address { CITIES[(r >> 8) % CITIES.len], zip } },
        items: items,
        total: total,
        discount: DISCOUNTS[(r >> 4) % DISCOUNTS.len],
        tags: tags,
        note: NOTES[(r >> 6) % NOTES.len],
        has_note: r & 3 == 0,
        geo: Geo { lat, lon },
        rate: rate,
    };
}

// What JSON.stringify(v, null, ind) writes before a member or element at
// depth d: a line break and ind * d spaces when indenting, else nothing.
fn line(out: u8[>..]&, ind: i64, d: i64) {
    if ind == 0 { return; }
    out.push('\n');
    for i in ind * d { out.push(' '); }
}

// A member's key at depth d; the comma before it is the caller's.
fn key(out: u8[>..]&, k: u8[:], ind: i64, d: i64) {
    line(out, ind, d);
    json::format_key(out, k);
    if ind > 0 { out.push(' '); }
}

fn write_address(out: u8[>..]&, a: Address&, ind: i64, d: i64) {
    out.push('{');
    key(out, "city", ind, d + 1);
    json::format_string(out, a.city);
    out.push(',');
    key(out, "zip", ind, d + 1);
    json::format_string(out, a.zip);
    line(out, ind, d);
    out.push('}');
}

fn write_customer(out: u8[>..]&, c: Customer&, ind: i64, d: i64) {
    out.push('{');
    key(out, "id", ind, d + 1);
    json::format_int(out, c.id);
    out.push(',');
    key(out, "name", ind, d + 1);
    json::format_string(out, c.name);
    out.push(',');
    key(out, "email", ind, d + 1);
    json::format_string(out, c.email);
    out.push(',');
    key(out, "vip", ind, d + 1);
    json::format_bool(out, c.vip);
    out.push(',');
    key(out, "address", ind, d + 1);
    write_address(out, c.address, ind, d + 1);
    line(out, ind, d);
    out.push('}');
}

fn write_item(out: u8[>..]&, it: Item&, ind: i64, d: i64) {
    out.push('{');
    key(out, "sku", ind, d + 1);
    json::format_string(out, it.sku);
    out.push(',');
    key(out, "name", ind, d + 1);
    json::format_string(out, it.name);
    out.push(',');
    key(out, "qty", ind, d + 1);
    json::format_int(out, it.qty);
    out.push(',');
    key(out, "price", ind, d + 1);
    format_number_js(out, it.price);
    line(out, ind, d);
    out.push('}');
}

fn write_record(out: u8[>..]&, r: Record&, ind: i64) {
    out.push('{');
    key(out, "id", ind, 1);
    json::format_int(out, r.id);
    out.push(',');
    key(out, "created", ind, 1);
    json::format_int(out, r.created);
    out.push(',');
    key(out, "customer", ind, 1);
    write_customer(out, r.customer, ind, 1);
    out.push(',');
    key(out, "items", ind, 1);
    out.push('[');
    for &it, k in r.items {
        if k > 0 { out.push(','); }
        line(out, ind, 2);
        write_item(out, it, ind, 2);
    }
    line(out, ind, 1);
    out.push(']');
    out.push(',');
    key(out, "total", ind, 1);
    format_number_js(out, r.total);
    out.push(',');
    key(out, "discount", ind, 1);
    format_number_js(out, r.discount);
    out.push(',');
    key(out, "tags", ind, 1);
    out.push('[');
    for t, k in r.tags {
        if k > 0 { out.push(','); }
        line(out, ind, 2);
        json::format_string(out, t);
    }
    if r.tags.len > 0 { line(out, ind, 1); }
    out.push(']');
    out.push(',');
    key(out, "note", ind, 1);
    if r.has_note { json::format_string(out, r.note); } else { out.append("null"); }
    out.push(',');
    key(out, "geo", ind, 1);
    out.push('{');
    key(out, "lat", ind, 2);
    format_number_js(out, r.geo.lat);
    out.push(',');
    key(out, "lon", ind, 2);
    format_number_js(out, r.geo.lon);
    line(out, ind, 1);
    out.push('}');
    out.push(',');
    key(out, "rate", ind, 1);
    format_number_js(out, r.rate);
    line(out, ind, 0);
    out.push('}');
}

fn serialize(records: Record[:], text: u8[>..]&, ends: i64[>..]&) {
    text.clear();
    ends.clear();
    for &r, i in records {
        write_record(text, r, 0);
        ends.push(text.len);
        if i % DUMP == 0 {
            write_record(text, r, 2);
            ends.push(text.len);
        }
    }
}

fn checksum(text: u8[:], ends: i64[:]) -> u32 {
    var h: u32 = 0x811c9dc5;
    var at = 0;
    for e in ends {
        h = mix_utf16(h, text[at..e]);
        at = e;
    }
    return h;
}

fn main() {
    var records: Record[>..] = [];
    for i in N { records.push(make_record(i)); }
    var text: u8[>..] = [];
    var ends: i64[>..] = [];
    for i in N_WARMUP { serialize(records, text, ends); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        serialize(records, text, ends);
        t = now_ms() - t0;
    }
    print_result(median_us(samples), checksum(text, ends), N, 2, N_RUNS);
}
