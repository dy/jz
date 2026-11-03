// setops.goose: Goose port of setops.js (same corpus, comparisons and
// checksum): near-duplicate detection with string sets, the standard
// library's dictionary as a set (`dictionary<K, bool>`) keyed by views of
// inline u8[..16] words. A Goose array cannot hold a resizable value, so the
// 256 document sets are one dictionary keyed by (document, word), each
// document's members listed beside it in insertion order, which gives a set's
// size and its iteration; the stop words, the vocabulary and the two
// differences of a duplicate pair (a copy of one set, the other's words
// removed) are dictionaries of their own.

import bench from "../_lib";
import dictionary;

let NWORDS = 1024;
let NSTOP = 32;             // the most common words are stop words
let NDOCS = 256;
let WINDOW = 8;             // documents compared after each one
let N_RUNS = 21;
let N_WARMUP = 5;

struct Member { doc: i64, word: const u8[:] }

fn hash(k: Member) -> u64 { hash_combine(hash(k.doc), hash(k.word)) }

var seed: u32 = 0x6d2b79f5;

fn next() -> u32 {
    seed ^= seed << 13;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    return seed;
}

fn build_words() -> u8[..16][>..] {
    var words: u8[..16][>..] = [];
    for i in NWORDS {
        let len = 3 + next() % 7;
        var w: u8[..16] = [];
        for j in len { w.push((97 + next() % 26) as! u8); }
        format(w, i);
        words.push(w);
    }
    return words;
}

// a word index skewed toward common words: the minimum of two uniform draws
fn pick() -> u32 {
    let a = next() % NWORDS;
    let b = next() % NWORDS;
    return if a < b { a } else { b };
}

// The documents as one token list, document d at toks[start[d]..start[d + 1]].
fn build_docs(words: u8[..16][:], toks: (const u8[:])[>..]&, start: i64[>..]&) {
    start.push(0);
    for d in NDOCS {
        if d % 8 == 7 {
            let p0 = start[d - 1];
            for k in p0..start[d] {
                if next() % 10 == 0 { toks.push(words[pick()]); } else { toks.push(toks[k]); }
            }
        } else {
            let len = 24 + next() % 73;
            for k in len { toks.push(words[pick()]); }
        }
        start.push(toks.len);
    }
}

struct Result { vocab: i64, score: i64, dupes: i64, diff: i64 }

fn compare(toks: (const u8[:])[:], start: i64[:], stop_words: u8[..16][:]) -> Result {
    var stop = dictionary<const u8[:], bool> {};
    for &w in stop_words { stop.insert(w, true); }
    var vocab = dictionary<const u8[:], bool> {};
    var sets = dictionary<Member, bool> {};
    var members: (const u8[:])[>..] = [];
    var first: i64[>..] = [];
    for d in NDOCS {
        first.push(members.len);
        for w in toks[start[d]..start[d + 1]] {
            if !stop.contains(w) && sets.insert(Member { d, w }, true) { members.push(w); }
        }
        for w in members[first[d]..] { vocab.insert(w, true); }
    }
    first.push(members.len);
    var r = Result { vocab.count, 0, 0, 0 };
    for i in NDOCS {
        let a = members[first[i]..first[i + 1]];
        var j = i + 1;
        while j <= i + WINDOW && j < NDOCS {
            let b = members[first[j]..first[j + 1]];
            let small = if a.len < b.len { i } else { j };
            let large = if small == i { j } else { i };
            var inter = 0;
            for w in members[first[small]..first[small + 1]] {
                if sets.contains(Member { large, w }) { inter += 1; }
            }
            let union = a.len + b.len - inter;
            let jac = if union == 0 { 0 } else { inter * 1000 / union };
            r.score += jac;
            if jac >= 600 {
                r.dupes += 1;
                var only_a = dictionary<const u8[:], bool> {};
                for w in a { only_a.insert(w, true); }
                for w in b { only_a.remove(w); }
                var only_b = dictionary<const u8[:], bool> {};
                for w in b { only_b.insert(w, true); }
                for w in a { only_b.remove(w); }
                r.diff += only_a.count + only_b.count;
            }
            j += 1;
        }
    }
    return r;
}

fn main() {
    let words = build_words();
    var toks: (const u8[:])[>..] = [];
    var start: i64[>..] = [];
    build_docs(words, toks, start);
    let stop_words = words[..NSTOP];
    var r = Result { 0, 0, 0, 0 };
    for i in N_WARMUP { r = compare(toks, start, stop_words); }

    var samples = [0.0; N_RUNS];
    for &t in samples {
        let t0 = now_ms();
        r = compare(toks, start, stop_words);
        t = now_ms() - t0;
    }
    let cs = mix(mix(mix(mix(0x811c9dc5, r.vocab as! u32), r.score as! u32), r.dupes as! u32),
                 r.diff as! u32);
    print_result(median_us(samples), cs, NDOCS, 3, N_RUNS);
}
