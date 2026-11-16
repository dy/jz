# Phase 10: CONTRIBUTING.md cut to a guide, the ledger

Source: `CONTRIBUTING.md` at 5d3f9d9ae (501,512 bytes, 6,606 lines, 270 blocks split at blank lines outside code fences).
Each block's sentences each have one state; the last column splits the block's bytes by them.
`guide`: in the new CONTRIBUTING.md (the public contract, by the same test of value, among it). `kept`: placed verbatim (comment markers and line breaks aside) in the named file's header. `cut: describes`: says what the code does. `cut: duplicate`: the place named says it already.
`cut: stale`: the tree contradicts it. `cut: history`: what changed or when. No block is `pending`: of the text about the files
branch worktree-agent-a0535e0f76860e45e deletes, block 22 (address and tag caches) is what src/optimize/cse-address.js:104-105 says,
block 188 names reuseLoads in passing, and block 17's load reuse is src/compile/cse-load.js's; none is a warning kept elsewhere.
The check: `python3 /private/tmp/claude-501/-Users-div-projects-jz/36e8fd26-a3d4-48ec-97bb-7106b08fda8d/scratchpad/p10w/check.py`.

| bytes per state | |
|---|---|
| cut: describes | 393,718 |
| cut: duplicate | 52,427 |
| guide | 27,859 |
| kept | 22,496 |
| cut: stale | 3,282 |
| cut: history | 1,730 |
| total | 501,512 |

| block | lines | bytes | state | split, destination or reason | first words |
|---|---|---|---|---|---|
| 1 | 1-2 | 22 | guide | guide 22 B: CONTRIBUTING.md | # Contributing to JZ  |
| 2 | 3-4 | 16 | guide | guide 16 B: CONTRIBUTING.md | ## Quick start  |
| 3 | 5-11 | 145 | guide | guide 145 B: CONTRIBUTING.md | ```sh git clone https://github.com/dy/jz.git && cd jz npm in |
| 4 | 12-13 | 27 | cut: stale | cut: stale 27 B: the heading named 254 KB of unrelated notes; the two paragraphs it fitted are in Quick start | ### Shared watr optimizer  |
| 5 | 14-22 | 541 | guide | guide 541 B: CONTRIBUTING.md | For coordinated changes in sibling `jz`, `watr` and `subscri |
| 6 | 23-32 | 702 | cut: stale | cut: stale 702 B: package.json pins subscript 10.8.4 and watr 5.13.7; the block names subscript 10.8.1 and watr 5.11.5-5.11.8 | `package.json` depends on the published subscript 10.8.1 (li |
| 7 | 33-176 | 10991 | cut: describes | cut: describes 9320 B · cut: duplicate 1671 B: scripts/native/compile.mjs:207; src/optimize/const-bases.js:12; src/optimize/const-bases.js:13 (+3) | The speed tier asks watr for loop strength reduction (`lsr`, |
| 8 | 177-185 | 578 | cut: describes | cut: describes 578 B | Watr 5.11.5 also defers costly pure local initializers to th |
| 9 | 186-192 | 465 | cut: describes | cut: describes 465 B | Failed closed Number guards retain their excluded interval o |
| 10 | 193-199 | 399 | cut: duplicate | cut: duplicate 399 B: src/compile/emit/dispatch.js:1261 | A statement's value, and a `void`'s, is dropped folded, `(dr |
| 11 | 200-673 | 35648 | kept | cut: describes 31697 B · cut: duplicate 1987 B: 42.88 (kept, src/static.js); interop.js:192; layout.js:59 (+9) · kept 1900 B: interop.js; module/object.js; module/symbol.js (+8) · cut: history 64 B: what was removed | Generic local propagation and merging run in watr after link |
| 12 | 674-681 | 525 | cut: describes | cut: describes 525 B | Stencil edge peeling runs before integral loop copies change |
| 13 | 682-685 | 231 | cut: describes | cut: describes 231 B | SIMD conversion peeling and late integer conversion share th |
| 14 | 686-754 | 5166 | cut: describes | cut: describes 4778 B · cut: duplicate 388 B: module/core.js:299; module/core.js:953 | Typed-width loop versions accept stable local receivers as w |
| 15 | 755-759 | 291 | cut: describes | cut: describes 291 B | Native and Wasm-hosted compiler entries share memory-option  |
| 16 | 760-774 | 1088 | kept | cut: describes 703 B · kept 385 B: src/compile/analyze/body-facts.js | A declaration supplies a whole-body integer range only when  |
| 17 | 775-830 | 4032 | kept | cut: describes 3338 B · cut: duplicate 595 B: 17.19 in the same block; block 17.18 (kept); module/regex.js:419 (+3) · kept 99 B: src/evaluation-effects.js | Load reuse visits reads and writes in evaluation order. A sh |
| 18 | 831-851 | 1470 | kept | cut: describes 989 B · kept 258 B: src/compile/emit-assign.js · cut: duplicate 223 B: src/summary/query.js:135; src/summary/query.js:185 | The summary must distinguish a pending factory result from a |
| 19 | 852-861 | 675 | kept | cut: describes 467 B · kept 208 B: module/object.js | Collection enumeration shares the ordered property walk with |
| 20 | 862-892 | 2299 | kept | cut: describes 1871 B · kept 374 B: module/number.js; src/compile/index.js · cut: duplicate 54 B: module/number.js:1306 | Runtime helper templates own their freshly parsed IR. Each d |
| 21 | 893-917 | 1910 | cut: describes | cut: describes 1848 B · cut: duplicate 62 B: src/link/order.js:2 | Shortest decimal, integer and radix formatting release their |
| 22 | 918-921 | 229 | cut: duplicate | cut: duplicate 229 B: src/optimize/cse-address.js:104-105, a file branch worktree-agent-a0535e0f76860e45e deletes | Address and tag caches require a dominating initializer. A b |
| 23 | 922-951 | 2176 | cut: describes | cut: describes 1766 B · cut: duplicate 410 B: scripts/self.js:271; scripts/self.js:274 | Compiler checkpoints check each complete write before touchi |
| 24 | 952-1023 | 5377 | kept | cut: describes 3363 B · cut: duplicate 1689 B: scripts/self.js:123; scripts/self.js:304; scripts/self.js:308 (+2) · kept 325 B: scripts/self.js | A phase checkpoint (`scripts/self.js` checkpointPhase, throu |
| 25 | 1024-1052 | 2082 | cut: describes | cut: describes 1759 B · cut: duplicate 323 B: src/compile/in-place.js:5; src/compile/in-place.js:7; src/compile/in-place.js:8 | Captured locals receive their cells independently, before a  |
| 26 | 1053-1056 | 212 | cut: describes | cut: describes 212 B | Static aggregate probes retain their emitted field/element I |
| 27 | 1057-1081 | 1799 | cut: describes | cut: describes 1799 B | Nonempty array literals reserve their stated length. Empty b |
| 28 | 1082-1209 | 9499 | cut: describes | cut: describes 8640 B · cut: duplicate 859 B: module/collection/ordered.js:27; module/collection/ordered.js:32; src/compile/numeric-arrays.js:35 | Numeric arrays (src/compile/numeric-arrays.js, `numericArray |
| 29 | 1210-1214 | 329 | cut: describes | cut: describes 329 B | Typed-array constructor copies capture the source and its fi |
| 30 | 1215-1222 | 526 | kept | kept 291 B: module/array.js · cut: describes 235 B | Array joining captures length before separator conversion an |
| 31 | 1223-1231 | 615 | cut: describes | cut: describes 615 B | String operands share interpolation's identity-preserving co |
| 32 | 1232-1243 | 859 | cut: describes | cut: describes 611 B · cut: duplicate 248 B: src/compile/emit/arithmetic.js:420; src/compile/emit/arithmetic.js:619 | Implicit ToNumber rejects BigInt. Explicit `Number()` accept |
| 33 | 1244-1291 | 3473 | cut: describes | cut: describes 2991 B · cut: duplicate 482 B: src/ir/coerce.js:166; src/ir/coerce.js:187 | A kind names what a read finds, and a read that finds nothin |
| 34 | 1292-1425 | 9832 | kept | cut: describes 8264 B · kept 796 B: module/array.js; module/core.js; module/typedarray.js · cut: duplicate 772 B: module/array.js:1955; module/typedarray.js:799; src/compile/array-view.js:19 | Computed typed-element reads delegate their bounds check to  |
| 35 | 1426-1456 | 2369 | kept | cut: describes 2137 B · kept 232 B: src/summary/index.js | The summary's declaration tables own numeric binding IDs, lo |
| 36 | 1457-1536 | 6002 | cut: describes | cut: describes 5035 B · cut: duplicate 967 B: src/summary/index.js:5273; src/summary/index.js:5300; test/split-bindings.js test titles | The straight-line facts follow a function's statements in or |
| 37 | 1537-1556 | 1427 | kept | cut: describes 1236 B · cut: duplicate 106 B: src/ast.js:63 · kept 85 B: src/ast.js | Object fields follow construction sites, independently of th |
| 38 | 1557-1597 | 3115 | kept | cut: describes 2421 B · cut: duplicate 429 B: src/compile/emit-assign.js:1028; src/compile/emit-assign.js:1033; src/summary/index.js:2445 · kept 265 B: src/compile/program-facts/slot-int-census.js | A closure's own properties are facts of its site (`closurePr |
| 39 | 1598-1615 | 1315 | kept | cut: describes 989 B · kept 326 B: src/compile/emit/dispatch.js | A condition is a boolean question, not a value: `toBool` ask |
| 40 | 1616-1658 | 3122 | cut: describes | cut: describes 3122 B | Numeric output-buffer contracts reuse the summary's stored-v |
| 41 | 1659-1668 | 737 | cut: describes | cut: describes 737 B | A direct factory can transfer a fresh typed array's element  |
| 42 | 1669-1887 | 16479 | kept | cut: describes 14921 B · kept 873 B: src/static.js; src/type/canonical-bounds.js; src/type/interval-proof.js (+1) · cut: duplicate 685 B: src/compile/emit/dispatch.js:132; src/compile/emit/dispatch.js:160; src/compile/loop-model.js:103 (+2) | Runtime-sized index buffers have a separate relational proof |
| 43 | 1888-1894 | 418 | cut: describes | cut: describes 418 B | Typed bounds versioning rejects a numeric hull when no recei |
| 44 | 1895-1913 | 1357 | kept | cut: describes 949 B · cut: duplicate 250 B: src/compile/plan/guard-views.js:20; src/compile/plan/guard-views.js:24 · kept 158 B: src/compile/plan/guard-views.js | A typed array a guard proves is read as that typed array (`p |
| 45 | 1914-1918 | 318 | kept | kept 194 B: src/ir/tag.js · cut: describes 124 B | Native kind predicates on unknown carriers use the full posi |
| 46 | 1919-1936 | 1216 | cut: describes | cut: describes 1216 B | A typed array's default sort uses direct-width insertion for |
| 47 | 1937-1974 | 2713 | cut: describes | cut: describes 2713 B | Typed constructor provenance describes storage, not presence |
| 48 | 1975-2027 | 3839 | cut: describes | cut: describes 3322 B · cut: duplicate 517 B: src/compile/param-numeric.js:532; src/compile/param-numeric.js:57; src/compile/param-numeric.js:9 | Typed element facts require a numeric key; named properties  |
| 49 | 2028-2037 | 700 | cut: describes | cut: describes 700 B | Size mode keeps one shared dynamic property lookup instead o |
| 50 | 2038-2056 | 1337 | cut: describes | cut: describes 1337 B | Expression-property reads share one receiver-dispatch genera |
| 51 | 2057-2061 | 325 | cut: describes | cut: describes 325 B | Named functions stored in internal objects or bindings retai |
| 52 | 2062-2099 | 2726 | kept | cut: describes 2406 B · cut: duplicate 219 B: src/optimize/licm.js:793; src/optimize/licm.js:805 · kept 101 B: src/optimize/licm.js | LICM extraction is shared through watr's `hoistInvariants`:  |
| 53 | 2100-2117 | 1341 | cut: describes | cut: describes 1341 B | Value numbering and statement scheduling are watr's (`valueN |
| 54 | 2118-2122 | 305 | cut: describes | cut: describes 305 B | Argument lowering and result packing are independent: ordina |
| 55 | 2123-2127 | 308 | cut: describes | cut: describes 308 B | The summary still visits arguments passed to escaped callees |
| 56 | 2128-2134 | 439 | cut: describes | cut: describes 439 B | Jzify's lexical census distinguishes parameter, body and nam |
| 57 | 2135-2148 | 954 | kept | cut: describes 754 B · cut: duplicate 110 B: err-codes.js:114 · kept 90 B: err-codes.js, the comment at "Internal exception transport" | Internal exceptions carry a private tagged code until a sour |
| 58 | 2149-2215 | 4904 | cut: describes | cut: describes 4904 B | Source handlers also catch synchronous host imports. Modules |
| 59 | 2216-2221 | 301 | cut: describes | cut: describes 301 B | An export of a value binding is a function returning the bin |
| 60 | 2222-2243 | 1558 | cut: describes | cut: describes 1021 B · cut: duplicate 537 B: interop.js:643; interop.js:664 | A class the entry exports reaches the host as a class (class |
| 61 | 2244-2251 | 568 | cut: describes | cut: describes 568 B | Coercion distinguishes absence from an own non-callable valu |
| 62 | 2252-2291 | 2878 | kept | cut: describes 2635 B · cut: duplicate 139 B: src/compile/emit/bigint.js:247 · kept 104 B: src/compile/emit/to-primitive.js | ToPrimitive has one method-resolution chain, generated for t |
| 63 | 2292-2298 | 421 | cut: describes | cut: describes 421 B | Relational operators share the boxed coercion/string-compari |
| 64 | 2299-2326 | 1933 | cut: describes | cut: describes 1556 B · cut: duplicate 377 B: src/optimize/watr-tail.js:462 | Member updates retain the receiver and converted key through |
| 65 | 2327-2434 | 7859 | cut: describes | cut: describes 6645 B · cut: duplicate 1214 B: module/object.js:1933; src/compile/analyze/func-namespaces.js:16; src/compile/emit/control-flow.js:385 (+2) | Property enumeration uses one traversal builder for Object.k |
| 66 | 2435-2448 | 994 | cut: describes | cut: describes 994 B | Prepare uses one shape census for literals, declarations and |
| 67 | 2449-2484 | 2566 | cut: describes | cut: describes 2566 B | A store of a name outside a shape's slots is tracked beside  |
| 68 | 2485-2542 | 4204 | kept | cut: describes 3627 B · kept 456 B: module/collection/upsert.js · cut: duplicate 121 B: module/collection.js:515 | Prepared functions, synthesized dispatchers, imports and var |
| 69 | 2543-2612 | 5149 | kept | cut: describes 4529 B · kept 464 B: src/compile/plan/inline.js · cut: duplicate 156 B: src/compile/plan/inline.js:258 | Source inlining builds the exported expression subset once p |
| 70 | 2613-2621 | 600 | cut: describes | cut: describes 600 B | Concatenation results carry the lazy hash cell; the Map hash |
| 71 | 2622-2642 | 1446 | cut: describes | cut: describes 1229 B · cut: duplicate 217 B: src/compile/plan/index-array-patterns.js:19 | A destructuring reads through its source: an object pattern' |
| 72 | 2643-2661 | 1273 | cut: describes | cut: describes 971 B · cut: duplicate 302 B: module/collection.js:943 | The generated bounded loop over a Map snapshot proves each e |
| 73 | 2662-2675 | 956 | cut: describes | cut: describes 684 B · cut: duplicate 272 B: src/compile/emit/fuse-probes.js:10 | A statement, or two adjacent ones, that ask a Set or a Map a |
| 74 | 2676-2696 | 1451 | cut: describes | cut: describes 1451 B | The frame census (compile/analyze/frame-effects.js) reads th |
| 75 | 2697-2736 | 2904 | kept | cut: describes 2518 B · kept 225 B: src/optimize/arena-rewind.js · cut: duplicate 161 B: src/optimize/arena-rewind.js:459 | Whether a value a call allocated outlives a frame is a quest |
| 76 | 2737-2762 | 1772 | cut: describes | cut: describes 1772 B | Four refinements keep a site from lowering the flag for noth |
| 77 | 2763-2773 | 681 | cut: describes | cut: describes 681 B | A call the census cannot name is no escape: it runs code of  |
| 78 | 2774-2826 | 3712 | cut: describes | cut: describes 2933 B · cut: duplicate 779 B: src/optimize/arena-rewind.js:56; src/optimize/arena-rewind.js:62; src/optimize/arena-rewind.js:951 | What is known before the call spares it the protocol. An esc |
| 79 | 2827-2861 | 2539 | cut: describes | cut: describes 2191 B · cut: duplicate 348 B: module/core/reach.js:18 | A frame that ran an escape keeps what the escape reaches, no |
| 80 | 2862-2877 | 1128 | guide | guide 877 B: CONTRIBUTING.md · cut: describes 251 B | `JZ_DEBUG_POISON=1` makes every restore, a frame's, an itera |
| 81 | 2878-2932 | 4109 | kept | cut: describes 3154 B · cut: duplicate 625 B: module/core/compact.js:1057; module/core/compact.js:24 · kept 330 B: module/core/compact.js | **Compaction of kept memory** (module/core/compact.js). What |
| 82 | 2933-2986 | 3768 | kept | cut: describes 2402 B · kept 824 B: src/optimize/loop-compact.js · cut: duplicate 542 B: src/optimize/loop-compact.js:101; src/optimize/loop-compact.js:198 | **Compaction within a call** (optimize/loop-compact.js). A l |
| 83 | 2987-3007 | 1443 | cut: describes | cut: describes 1201 B · cut: duplicate 242 B: src/optimize/quiet-loops.js:25 | The census reads the source, and what a loop's body is emitt |
| 84 | 3008-3060 | 3796 | kept | cut: describes 2564 B · kept 1062 B: module/core/compact.js · cut: duplicate 170 B: module/core/compact.js:174 | A suspended frame's local names memory below the floor (allo |
| 85 | 3061-3093 | 2434 | kept | cut: describes 2225 B · kept 209 B: module/core/compact.js | A walk reaches the memory below the floor as well: an old co |
| 86 | 3094-3130 | 2662 | cut: describes | cut: describes 1426 B · cut: duplicate 1236 B: interop.js:110; interop.js:1129; interop.js:403 (+2) | An exported parameter used as a numeric array (paramNumericA |
| 87 | 3131-3149 | 1273 | cut: describes | cut: describes 1273 B | `E[Symbol.iterator]()` is `__it_from(E)` for every receiver  |
| 88 | 3150-3156 | 448 | cut: describes | cut: describes 448 B | A Map's keys and a Set's members are handed out only by enum |
| 89 | 3157-3172 | 1099 | cut: describes | cut: describes 1099 B | A wrapper hands back what its closure argument returns: a re |
| 90 | 3173-3198 | 1853 | cut: describes | cut: describes 1692 B · cut: duplicate 161 B: src/summary/index.js:3576 | Unknown-receiver stores affect schemas whose identity escape |
| 91 | 3199-3205 | 428 | cut: describes | cut: describes 428 B | Default ABI carriers are immutable and shared between compil |
| 92 | 3206-3212 | 450 | cut: describes | cut: describes 450 B | Schema-read devirtualization runs from level 1. Its budget c |
| 93 | 3213-3226 | 920 | cut: describes | cut: describes 831 B · cut: duplicate 89 B: README contract 255.8 | The host boundary carries plain `jz:fields` data alongside s |
| 94 | 3227-3241 | 1032 | kept | cut: describes 738 B · cut: duplicate 159 B: module/json.js:158; module/json.js:1733 · kept 135 B: module/json.js | JSON.parse shares decimal accumulation and rounding with Num |
| 95 | 3242-3246 | 289 | cut: describes | cut: describes 289 B | URLSearchParams uses ordinary class lowering with shared met |
| 96 | 3247-3251 | 322 | cut: describes | cut: describes 322 B | Dynamic object reads, writes, presence and deletion share on |
| 97 | 3252-3271 | 1453 | cut: describes | cut: describes 1453 B | Array read-only/current-pointer policies and multi-site push |
| 98 | 3272-3275 | 237 | cut: describes | cut: describes 237 B | The source loop transforms share one closure-write census pe |
| 99 | 3276-3464 | 14211 | kept | cut: describes 13093 B · cut: duplicate 731 B: src/compile/analyze/body-facts.js:814; src/compile/carry-elements.js:274; src/compile/twin-locals.js:32 (+1) · kept 232 B: src/type/interval-proof.js · guide 155 B: CONTRIBUTING.md | The interval interpreter (`src/type/interval-proof.js`) is t |
| 100 | 3465-3486 | 1612 | kept | cut: describes 908 B · kept 399 B: interop.js; module/collection.js · cut: stale 305 B: `dynSetValueI64` no longer exists in src/ or module/ | Ephemeral dictionaries use the same zeroed header allocator  |
| 101 | 3487-3496 | 670 | cut: describes | cut: describes 670 B | The size preset keeps indirect function-table calls instead  |
| 102 | 3497-3509 | 923 | cut: describes | cut: describes 923 B | Number canonicalization applies to f64 carriers only: an i32 |
| 103 | 3510-3511 | 25 | cut: describes | cut: describes 25 B | ### Body-fact freshness  |
| 104 | 3512-3520 | 593 | cut: describes | cut: describes 593 B | `analyzeValueFacts` requests kinds, shapes and allocation id |
| 105 | 3521-3524 | 201 | kept | kept 201 B: src/compile/analyze/body-facts.js | `analyzeBody` caches observations, not an immutable semantic |
| 106 | 3525-3532 | 741 | kept | kept 741 B: src/compile/analyze/body-facts.js | \| Dependency changed \| Invalidation before the next dependen |
| 107 | 3533-3553 | 1440 | kept | kept 631 B: src/compile/analyze/body-facts.js · cut: describes 559 B · cut: duplicate 250 B: src/compile/analyze/body-facts.js:843; src/compile/analyze/body-facts.js:844 | Global eviction clears the complete body cache, including an |
| 108 | 3554-3558 | 370 | guide | guide 370 B: CONTRIBUTING.md | A comment citing a `.work/` path or `PLAN.md` that the tree  |
| 109 | 3559-3565 | 469 | guide | guide 469 B: CONTRIBUTING.md | Compiler lifecycle diagnostics live in `src/debug.js`. `JZ_D |
| 110 | 3566-3567 | 16 | guide | guide 16 B: CONTRIBUTING.md | ## Code layout  |
| 111 | 3568-3649 | 18748 | guide | cut: describes 17314 B: the per-file pass descriptions; each file's header holds its own · guide 1434 B: CONTRIBUTING.md (the tree lines kept verbatim) | ``` jzify/          pre-compile desugar (index.js orchestrat |
| 112 | 3650-3651 | 241 | guide | guide 241 B: CONTRIBUTING.md | **Folder policy:** one folder per pipeline *stage*, not per  |
| 113 | 3652-3655 | 1373 | guide | guide 1373 B: CONTRIBUTING.md | **Stdlib registration — two dialects, by design:** raw `ctx. |
| 114 | 3656-3657 | 1827 | guide | cut: duplicate 826 B: describes registerName; src/ctx.js:195-274 comments state it; describes verifyEmitIntegrity (src/ctx.js, src/autoload.js) · guide 641 B: CONTRIBUTING.md · cut: history 360 B: a past collision and a retired .work/archive note |   The one hard, mechanical rule for either dialect: **never  |
| 115 | 3658-3659 | 320 | guide | guide 320 B: CONTRIBUTING.md | **kind vs type:** `kind.js` = value family (STRING, ARRAY, … |
| 116 | 3660-3661 | 3126 | cut: duplicate | cut: duplicate 3126 B: src/compile/program-index.js:721-725, 990 | **ProgramIndex:** `src/compile/program-index.js` owns four d |
| 117 | 3662-3663 | 17 | guide | guide 17 B: CONTRIBUTING.md | ## Architecture  |
| 118 | 3664-3665 | 189 | guide | guide 189 B: CONTRIBUTING.md | Current pipeline: `source → parse (subscript/jessie) → jzify |
| 119 | 3666-3680 | 1030 | cut: duplicate | cut: duplicate 618 B: src/parse.js:253; src/parse.js:256; src/parse.js:258 (+1) · cut: stale 412 B: src/parse.js no longer orders operators: 5d3f9d9ae moved that into subscript 10.8.4 and deleted it here | The parser entry (`src/parse.js`) orders the operators of ev |
| 120 | 3681-3696 | 1134 | cut: describes | cut: describes 1134 B | It also reads source text the way ECMAScript does where subs |
| 121 | 3697-3710 | 939 | cut: describes | cut: describes 939 B | A parsed node's `loc` indexes the compile's sources laid end |
| 122 | 3711-3712 | 404 | guide | guide 404 B: CONTRIBUTING.md | **One shared optimizer, owned by watr (`~/projects/watr`).** |
| 123 | 3713-3714 | 326 | guide | guide 326 B: CONTRIBUTING.md | The tape (`src/ir/tape.js`) transports WAT through link. Set |
| 124 | 3715-3741 | 2020 | cut: describes | cut: describes 2020 B | Float32Array storage does not lower JavaScript arithmetic pr |
| 125 | 3742-3839 | 7231 | cut: describes | cut: describes 6722 B · cut: duplicate 509 B: src/optimize/int-narrow.js:624; src/optimize/int-range.js:438; src/optimize/int-range.js:922 | An integer a number holds computes in an integer register wh |
| 126 | 3840-3850 | 814 | cut: describes | cut: describes 814 B | Narrowings of the function's text sit around watr's optimize |
| 127 | 3851-3871 | 1757 | cut: describes | cut: describes 1757 B | Then an element load in a guarded arm takes the word a store |
| 128 | 3872-3895 | 2061 | kept | cut: describes 1561 B · kept 500 B: src/optimize/pure-funcs.js | Before the literals are pooled, a function of at most 16 ins |
| 129 | 3896-3923 | 2400 | cut: describes | cut: describes 2275 B · cut: duplicate 125 B: src/optimize/split-funcs.js:65 | Last of all at the speed tier, a large function's conditiona |
| 130 | 3924-3944 | 1758 | cut: describes | cut: describes 1758 B | Just before it, each pass of a loop that runs a loop becomes |
| 131 | 3945-3984 | 2880 | kept | cut: describes 2445 B · cut: duplicate 332 B: src/optimize/specialize.js:121; src/optimize/specialize.js:645 · kept 103 B: src/optimize/specialize.js | A loop is compiled twice where its values decide its types ( |
| 132 | 3985-4009 | 1781 | cut: describes | cut: describes 1180 B · cut: duplicate 601 B: src/optimize/guards.js:216; src/optimize/guards.js:230 | The guards of a copy are combined once the integers are in p |
| 133 | 4010-4020 | 816 | cut: describes | cut: describes 498 B · cut: duplicate 318 B: src/optimize/settled-tests.js:7 | A test that failed stays failed while its locals hold (`opti |
| 134 | 4021-4043 | 1664 | cut: describes | cut: describes 1514 B · cut: duplicate 150 B: src/optimize/licm.js:303 | LICM reads a view's descriptor words as it reads a header's: |
| 135 | 4044-4050 | 468 | kept | cut: describes 313 B · kept 155 B: src/summary/index.js | Numeric syntax has one evaluator in `static.js`. Module plan |
| 136 | 4051-4054 | 242 | cut: describes | cut: describes 242 B | Closure calls capture the callee before argument effects and |
| 137 | 4055-4169 | 8735 | kept | cut: describes 7642 B · kept 706 B: src/summary/definite.js; src/summary/query.js · cut: duplicate 387 B: src/compile/function-plan.js:45; src/compile/plan/scope.js:267 | Fixed plain-array lengths flow from the existing builder ana |
| 138 | 4170-4177 | 526 | cut: describes | cut: describes 526 B | Strings store UTF-16LE code units; lengths and positions cou |
| 139 | 4178-4186 | 683 | kept | cut: describes 398 B · kept 285 B: src/static-data.js | Static data uses owned `Uint8Array` chunks (`src/static-data |
| 140 | 4187-4198 | 856 | cut: describes | cut: describes 856 B | Decimal parsing and shortest float formatting share the powe |
| 141 | 4199-4202 | 233 | kept | kept 233 B: src/compile/function-plan.js | Function-local layouts belong in `localReps`, carried by the |
| 142 | 4203-4279 | 5661 | kept | cut: describes 4613 B · kept 551 B: jzify/arguments.js; src/iterator-pattern.js · cut: duplicate 497 B: jzify/generators.js:1635; jzify/generators.js:780 | Parameter initialization is owned by `jzify/arguments.js`. O |
| 143 | 4280-4290 | 806 | cut: describes | cut: describes 806 B | An object rest `{a, ...r} = o` is the spread of `o` without  |
| 144 | 4291-4498 | 15182 | cut: describes | cut: describes 14561 B · cut: duplicate 621 B: interop.js:1022; jzify/async.js:5; jzify/async.js:69 | A generator or async body suspends only at statements (`jzif |
| 145 | 4499-4512 | 938 | cut: describes | cut: describes 810 B · cut: duplicate 128 B: src/prepare/module-eval.js:28 | A bundled module's statements run at start-up, before its im |
| 146 | 4513-4545 | 2350 | cut: describes | cut: describes 2350 B | A member is a function of its own: `arguments` in a method,  |
| 147 | 4546-4554 | 602 | kept | cut: describes 430 B · kept 172 B: src/summary/index.js | The summary walks what the program reaches: a function or cl |
| 148 | 4555-4663 | 7994 | guide | cut: describes 7820 B · guide 174 B: CONTRIBUTING.md | The summary (`src/summary`) models, beyond the forms the tes |
| 149 | 4664-4682 | 1308 | kept | cut: describes 735 B · kept 288 B: jzify/classes.js · cut: duplicate 285 B: jzify/classes.js:1142 | A method shorthand parses as a function: `m(p) { body }` is  |
| 150 | 4683-4687 | 310 | cut: describes | cut: describes 310 B | Well-known symbol keys use a shared name lookup in the entry |
| 151 | 4688-4698 | 682 | cut: duplicate | cut: duplicate 682 B: src/compile/emit/class-dispatch.js:166; src/prepare/handlers.js:3243 | Strict mode's spelling rules (`==`, `!=`, `void` are prohibi |
| 152 | 4699-4729 | 2188 | cut: describes | cut: describes 2188 B | A binding that holds a Boolean beside another kind (`let v;  |
| 153 | 4730-4745 | 1138 | cut: describes | cut: describes 1138 B | A typed array's `fill` captures all arguments, then converts |
| 154 | 4746-4778 | 2363 | cut: describes | cut: describes 2363 B | Every array position argument (fill, copyWithin, slice, spli |
| 155 | 4779-4965 | 14129 | kept | cut: describes 11744 B · cut: duplicate 1787 B: module/core/durable-log.js:107; src/compile/analyze/frame-effects.js:1292; src/compile/analyze/frame-effects.js:195 (+6) · kept 598 B: module/core/durable-log.js; src/optimize/arena-rewind.js | Frame effects (`src/compile/analyze/frame-effects.js`) are t |
| 156 | 4966-4984 | 1335 | cut: describes | cut: describes 1092 B · cut: duplicate 243 B: src/compile/plan/lanes.js:19 | Record parameters become lanes (`src/compile/plan/lanes.js`, |
| 157 | 4985-5041 | 4137 | cut: describes | cut: describes 3269 B · cut: duplicate 868 B: src/optimize/vectorize/addr-model.js:138; src/optimize/vectorize/map.js:16 | Generic reads in the self-compiled kernel cost helper entrie |
| 158 | 5042-5049 | 493 | cut: describes | cut: describes 493 B | A remainder rebuilt from its shifted quotient is a mask (`sr |
| 159 | 5050-5058 | 638 | cut: describes | cut: describes 331 B · cut: history 307 B: what the idiom cost before the pass | A module binding made by a factory run once (`export const r |
| 160 | 5059-5066 | 490 | cut: describes | cut: describes 490 B | A loop's advance budget (`src/type/canonical-bounds.js`, `ma |
| 161 | 5067-5087 | 1461 | cut: describes | cut: describes 956 B · cut: duplicate 505 B: src/optimize/nan-canon.js:9 | A Number's canonical-NaN step only arithmetic reads is its v |
| 162 | 5088-5094 | 463 | cut: describes | cut: describes 463 B | Before emission, whether an operator over a value of unknown |
| 163 | 5095-5106 | 765 | cut: describes | cut: describes 765 B | The export boundary is numeric for a parameter used only as  |
| 164 | 5107-5120 | 961 | cut: describes | cut: describes 961 B | The dynamic property reader checks a primitive STRING receiv |
| 165 | 5121-5124 | 191 | cut: history | cut: history 191 B: names the regression a fix closed | `charCodeAt` on a concatenation dissolved into raw (buf, len |
| 166 | 5125-5252 | 9554 | kept | cut: describes 7571 B · cut: duplicate 1612 B: src/optimize/flow-range.js:9; src/optimize/to-int32.js:21; src/optimize/to-int32.js:24 (+2) · kept 371 B: src/optimize/to-int32.js | ToInt32 of a value whose range is proven finite and below 2^ |
| 167 | 5253-5310 | 4422 | kept | cut: describes 3641 B · cut: duplicate 556 B: module/math.js:306; module/math.js:372 · kept 225 B: module/math.js | `x ** c` with a constant non-integer exponent is the `$math. |
| 168 | 5311-5402 | 7179 | kept | cut: describes 5824 B · cut: duplicate 796 B: module/math.js:565; module/math.js:569; module/math.js:599 (+1) · kept 559 B: module/math.js | jz's Math is not V8's bit for bit: it keeps within 50 ulp of |
| 169 | 5403-5418 | 1286 | kept | kept 644 B: module/core.js · cut: describes 642 B | A hot runtime helper answers its common case in a head small |
| 170 | 5419-5420 | 330 | guide | guide 330 B: CONTRIBUTING.md | Values use proven raw lanes or tagged carriers; heap values  |
| 171 | 5421-5422 | 27 | guide | guide 27 B: CONTRIBUTING.md | ## Adding a stdlib method  |
| 172 | 5423-5428 | 1041 | guide | guide 1041 B: CONTRIBUTING.md | 1. Find or create the module file in `module/` (e.g. `module |
| 173 | 5429-5430 | 41 | guide | guide 41 B: CONTRIBUTING.md | ## Adding an auto-vectorizer recognizer  |
| 174 | 5431-5433 | 129 | guide | guide 129 B: CONTRIBUTING.md | Generic recognizer work belongs in watr. The discipline belo |
| 175 | 5434-5438 | 396 | cut: stale | cut: stale 396 B: its first clause: since phase 6c every lowering is asked and the cheapest legal lift emitted (src/optimize/vectorize/index.js:284-294); its last clause, a null is fail-safe, stays in the guide verbatim; names src/optimize/vectorize.js, now the directory src/optimize/vectorize/ (sentence rewritten with the path vectorize/index.js) | The lane vectorizer (`vectorizeLaneLocal` in [`src/optimize/ |
| 176 | 5439-5454 | 1346 | cut: describes | cut: describes 1346 B | Every scaffold a recognizer reads is a view of one descripti |
| 177 | 5455-5480 | 2204 | kept | cut: describes 1347 B · kept 857 B: src/optimize/vectorize/legality.js | No wrapper reaches the output but past one legality, the sam |
| 178 | 5481-5503 | 1546 | cut: describes | cut: describes 1410 B · cut: duplicate 136 B: src/type/loop-versioning.js:160 | Typed extent guards may give their fast arm fresh signed-wor |
| 179 | 5504-5511 | 530 | kept | cut: describes 346 B · kept 184 B: src/optimize/vectorize/divergent-escape.js | Escape-loop vectorization preserves the iterator's scalar Nu |
| 180 | 5512-5533 | 1779 | cut: describes | cut: describes 1779 B | A pixel loop no lane lift takes, whose body holds one inner  |
| 181 | 5534-5544 | 823 | cut: describes | cut: describes 428 B · cut: duplicate 395 B: src/optimize/vectorize/tone-map.js:411; src/optimize/vectorize/tone-map.js:412 | A statement's truncations in the tone-map lift test their la |
| 182 | 5545-5548 | 276 | cut: duplicate | cut: duplicate 276 B: src/optimize/vectorize/tone-map.js:501 | The tone-map lift's conditional update (`if (c) { g = …; h = |
| 183 | 5549-5553 | 361 | cut: describes | cut: describes 361 B | The escape-time lift (`optimize/vectorize/divergent-escape.j |
| 184 | 5554-5555 | 96 | guide | guide 96 B: CONTRIBUTING.md | Discipline (non-negotiable — these run in the default `speed |
| 185 | 5556-5580 | 2164 | guide | guide 1810 B: CONTRIBUTING.md · cut: duplicate 354 B: AGENTS.md "test:self" and .github/workflows/self-compile.yml; test/bench.js:150-160 (the watr and jessie pins) | - **Bit-exact.** Compile `{optimize:3}` vs `{optimize:3, noS |
| 186 | 5581-5586 | 497 | cut: stale | cut: stale 497 B: a coverage status note citing .work/audit.md §9, which the tree does not hold | Coverage is not exhausted but is diminishing-returns vs reac |
| 187 | 5587-5599 | 1113 | cut: describes | cut: describes 888 B · cut: duplicate 225 B: src/optimize/vectorize/dot-slp.js:259 | Straight-line code has its own packer, SLP (`src/optimize/ve |
| 188 | 5600-5623 | 2012 | cut: describes | cut: describes 1359 B · cut: duplicate 653 B: src/ir/mem-alias.js:13; src/ir/mem-alias.js:16; src/optimize/licm.js:745 | What an access may overwrite is the emitter's to say (`src/i |
| 189 | 5624-5647 | 1982 | cut: describes | cut: describes 1054 B · cut: duplicate 928 B: src/optimize/static-scratch.js:100; src/optimize/static-scratch.js:12; src/optimize/static-scratch.js:5 | A static typed array the program only indexes by constants i |
| 190 | 5648-5674 | 2442 | kept | cut: describes 1802 B · kept 266 B: src/prepare/split-bindings.js · guide 228 B: CONTRIBUTING.md · cut: duplicate 146 B: src/prepare/split-bindings.js:297 | An assignment that is a statement of a function's own list d |
| 191 | 5675-5681 | 462 | cut: describes | cut: describes 462 B | A split binding of the type of the one it continues takes it |
| 192 | 5682-5699 | 1473 | cut: describes | cut: describes 1258 B · cut: duplicate 215 B: src/compile/plan/scratch.js:19 | A module array of numbers the program only uses as scratch i |
| 193 | 5700-5723 | 2019 | kept | cut: describes 1781 B · kept 141 B: src/compile/plan/alias.js · cut: duplicate 97 B: src/compile/plan/alias.js:47 | A spliced call leaves names for one value and statements in  |
| 194 | 5724-5763 | 3267 | kept | cut: describes 2287 B · cut: duplicate 855 B: src/compile/plan/inline.js:1104; src/compile/plan/inline.js:527; src/compile/plan/inline.js:684 · kept 125 B: src/compile/plan/inline.js | The inliner (`plan/inline.js`) splices with these in view. A |
| 195 | 5764-5792 | 2595 | kept | cut: describes 2428 B · kept 167 B: src/compile/plan/inline.js | At the speed tier a loop's time is the loop's and its callee |
| 196 | 5793-5810 | 1465 | cut: describes | cut: describes 1465 B | A binding of a spliced call read where it holds a literal is |
| 197 | 5811-5821 | 782 | kept | kept 501 B: src/compile/narrow/int-params.js · cut: describes 281 B | A mutable parameter uses an i32 carrier only when the shared |
| 198 | 5822-5835 | 1005 | cut: describes | cut: describes 793 B · cut: duplicate 212 B: src/compile/numeric-mix.js:8 | A parameter every call fixes to one integer reads as that in |
| 199 | 5836-5840 | 327 | cut: describes | cut: describes 327 B | A literal of no members declares nothing, so it scalarizes t |
| 200 | 5841-5848 | 641 | cut: describes | cut: describes 510 B · cut: duplicate 131 B: src/summary/definite.js:11 | A binding assigned on every path to each of its reads holds  |
| 201 | 5849-5854 | 403 | cut: describes | cut: describes 403 B | Single precision is the `narrowFloat32` pass described with  |
| 202 | 5855-5858 | 254 | cut: describes | cut: describes 254 B | The tape's fold (`src/optimize/fold.js`) answers a compariso |
| 203 | 5859-5862 | 240 | cut: describes | cut: describes 240 B | A typed store reads its key before its value, as PutValue do |
| 204 | 5863-5899 | 3237 | cut: describes | cut: describes 3237 B | A module name that holds a builtin for good is that builtin  |
| 205 | 5900-5921 | 1938 | cut: describes | cut: describes 1580 B · cut: duplicate 358 B: src/optimize/watr-tail.js:374 | A module whose initializer reaches into the host (a host glo |
| 206 | 5922-5934 | 945 | cut: describes | cut: describes 718 B · cut: history 227 B: what the compile used to do | A module name that holds one regular expression for good is  |
| 207 | 5935-5946 | 941 | cut: describes | cut: describes 896 B · cut: duplicate 45 B: module/regex.js:1097 | The shared matcher is not the RegExp value. Every evaluated  |
| 208 | 5947-5955 | 707 | cut: describes | cut: describes 707 B | A module binding nothing that runs reads is not declared, wh |
| 209 | 5956-5963 | 567 | cut: duplicate | cut: duplicate 395 B: test/objects.js titles · cut: describes 172 B | A function's properties are a record reached through its nam |
| 210 | 5964-5965 | 15 | guide | guide 15 B: CONTRIBUTING.md | ## Principles  |
| 211 | 5966-5971 | 1335 | guide | guide 1335 B: CONTRIBUTING.md | - **Don't contort compiler source for microbenchmarks.** Rea |
| 212 | 5972-5973 | 14 | cut: describes | cut: describes 14 B | ## Decisions  |
| 213 | 5974-5976 | 110 | cut: history | cut: history 110 B: provenance of the list (the v1 plan) | The decisions that shaped the tree, kept from the v1 plan. A |
| 214 | 5977-5978 | 18 | cut: describes | cut: describes 18 B | ### Architecture  |
| 215 | 5979-6158 | 12510 | kept | cut: describes 10158 B · cut: duplicate 1674 B: README "What differs from JS?"; README contract 255.5; README contract 255.5-255.6 (+4) · kept 332 B: src/optimize/split-funcs.js · cut: history 143 B: what the census did before · guide 125 B: CONTRIBUTING.md · cut: stale 78 B: module/core/compact.js now frees what a call replaced in older storage (block 81) | - One lowering pipeline: parse → jzify → prepare → normalize |
| 216 | 6159-6160 | 27 | cut: describes | cut: describes 27 B | ### BigInt representation  |
| 217 | 6161-6165 | 311 | kept | kept 311 B: src/compile/representation-plan.js | Mixed dynamic BigInt is a core feature, not compat sugar: th |
| 218 | 6166-6183 | 1249 | kept | kept 1249 B: src/compile/representation-plan.js | - The tagged carrier is the universal correct crossing for a |
| 219 | 6184-6185 | 18 | cut: describes | cut: describes 18 B | ### Dependencies  |
| 220 | 6186-6193 | 518 | cut: history | cut: history 328 B: the dependency pin story · cut: duplicate 190 B: block 185 (guide) | - subscript and watr come from npm at the versions package.j |
| 221 | 6194-6195 | 12 | guide | guide 12 B: CONTRIBUTING.md | ## Testing  |
| 222 | 6196-6197 | 20 | guide | guide 20 B: CONTRIBUTING.md | ### Source cleanup  |
| 223 | 6198-6203 | 366 | guide | guide 366 B: CONTRIBUTING.md | `npm run lint:imports` checks unused imports in the root Jav |
| 224 | 6204-6210 | 440 | guide | guide 440 B: CONTRIBUTING.md | `npm run audit:files` uses Knip to find unreachable source m |
| 225 | 6211-6215 | 311 | guide | guide 311 B: CONTRIBUTING.md | Review reported files for string-based loading and documente |
| 226 | 6216-6217 | 17 | guide | guide 17 B: CONTRIBUTING.md | ### Test suites  |
| 227 | 6218-6219 | 84 | guide | guide 84 B: CONTRIBUTING.md | Tests use [tst](https://github.com/dy/tst). Choose the owner |
| 228 | 6220-6234 | 1334 | guide | guide 1334 B: CONTRIBUTING.md | \| Command \| Work \| \| --- \| --- \| \| `npm test` \| Core semanti |
| 229 | 6235-6242 | 552 | guide | guide 484 B: CONTRIBUTING.md · cut: duplicate 68 B: history of the suite split | `node test/index.js --suite=all --list` lists every register |
| 230 | 6243-6257 | 1073 | guide | cut: describes 537 B · cut: duplicate 382 B: AGENTS.md "Verify before claiming done"; AGENTS.md "Verify before claiming done" (npm test) · guide 154 B: CONTRIBUTING.md | A whole core or generated run splits its files over processe |
| 231 | 6258-6266 | 569 | guide | cut: describes 296 B · guide 273 B: CONTRIBUTING.md | A test that must hold at several optimize levels writes `for |
| 232 | 6267-6275 | 630 | cut: duplicate | cut: duplicate 630 B: AGENTS.md "Verify before claiming done" (bootstrap) and "Build artifacts & deploy" | Bootstrap sharing is invocation-local: a private fresh build |
| 233 | 6276-6285 | 695 | guide | guide 695 B: CONTRIBUTING.md | Shared helpers live in `test/util.js`: `run` (exports), `wat |
| 234 | 6286-6287 | 56 | guide | guide 56 B: CONTRIBUTING.md | To count and time real compiles, including duplicates:  |
| 235 | 6288-6291 | 94 | guide | guide 94 B: CONTRIBUTING.md | ```sh JZ_HASHES=/tmp/strings.json node --import ./test/_hash |
| 236 | 6292-6295 | 206 | guide | guide 206 B: CONTRIBUTING.md | The recorder's `meta.calls` and per-key `measurements` compl |
| 237 | 6296-6304 | 475 | guide | guide 203 B: CONTRIBUTING.md · cut: describes 192 B · cut: duplicate 80 B: AGENTS.md lists test:262 and test:262:builtins | Release semantics also run `npm run test:262` and `npm run t |
| 238 | 6305-6306 | 33 | guide | guide 33 B: CONTRIBUTING.md | ## Performance & size invariant  |
| 239 | 6307-6310 | 234 | cut: stale | cut: stale 234 B: names test/bench.js as the whole enforcement; the claims are AGENTS.md "Performance claims" over bench/claims.mjs and test/bench-claims.js | JZ makes a load-bearing promise: **on the bench corpus, JZ w |
| 240 | 6311-6345 | 2548 | guide | cut: duplicate 1810 B: test/bench.js:1-15 (its header states the invariant it pins); AGENTS.md "Performance claims" · cut: stale 440 B: .work/audit.md and .work/evidence.md are absent; test/bench.js has no WASMOPT_SLACK_MIN gate any more; test/bench.js has no WASMOPT_SLACK_MIN gate; .work/wasm-opt-slack.md is absent · guide 298 B: CONTRIBUTING.md | - **Speed** (`-O` speed-tuned build): JZ median ≤ V8 and Ass |
| 241 | 6346-6348 | 143 | guide | guide 143 B: CONTRIBUTING.md | Run locally (needs `asc` and `wasm-opt` on PATH for the full |
| 242 | 6349-6354 | 178 | guide | guide 178 B: CONTRIBUTING.md | ```sh npm run test:bench   # the gate npm run bench:size     |
| 243 | 6355-6362 | 572 | guide | guide 381 B: CONTRIBUTING.md · cut: stale 191 B: the `wasm-opt` slack budget it names is gone (replaced by new text naming SIZE_BUDGET) | **Ratchet, don't backslide.** `bench.js` carries per-case `w |
| 244 | 6363-6364 | 25 | guide | guide 25 B: CONTRIBUTING.md | ### Adding a bench case  |
| 245 | 6365-6374 | 772 | guide | guide 772 B: CONTRIBUTING.md | 1. `mkdir bench/<name>/` and add `bench/<name>/<name>.js` —  |
| 246 | 6375-6377 | 166 | guide | guide 166 B: CONTRIBUTING.md | Prefer cases that mirror real JZ target workloads (numeric/D |
| 247 | 6378-6379 | 28 | guide | guide 28 B: CONTRIBUTING.md | ## Public contract and ABI  |
| 248 | 6380-6388 | 613 | guide | guide 613 B: CONTRIBUTING.md | The public surface is deliberately small (README owns it): t |
| 249 | 6389-6400 | 826 | guide | cut: duplicate 505 B: src/options.js:1-9 (the CLI, the tests, the bench and the tools pass the internal flags); src/options.js:1-9 and src/compiler.js compileInternal state the internal entry and its folding · guide 321 B: CONTRIBUTING.md | The public options are a closed set: `normalizeOptions` (src |
| 250 | 6401-6414 | 1581 | cut: duplicate | cut: duplicate 1581 B: index.d.ts CompileOptions (its docs at L47-63) spells the public options; src/options.js foldOptions holds the map | \| Internal option \| Public spelling \| Notes \| \|---\|---\|---\|  |
| 251 | 6415-6439 | 1758 | guide | cut: duplicate 1072 B: index.d.ts Warning (L14-); scripts/why-census.mjs prints it; src/ctx.js warn() is the rendering it describes · guide 686 B: CONTRIBUTING.md | Advisories reach the `warnings` callback, one per site (the  |
| 252 | 6440-6441 | 24 | guide | guide 24 B: CONTRIBUTING.md | ### Semantics contract  |
| 253 | 6442-6457 | 1120 | guide | guide 857 B: CONTRIBUTING.md · cut: duplicate 263 B: README.md:187 (Numeric export parameters) | Outside the dialect differences the README lists, accepted p |
| 254 | 6458-6459 | 26 | guide | guide 26 B: CONTRIBUTING.md | ### Host memory contract  |
| 255 | 6460-6478 | 1355 | guide | guide 1355 B: CONTRIBUTING.md | Strings use UTF-16 code units; UTF-8 belongs at encoding and |
| 256 | 6479-6489 | 731 | guide | guide 731 B: CONTRIBUTING.md | Plain arrays retained by the host have open element types. T |
| 257 | 6490-6497 | 491 | guide | guide 491 B: CONTRIBUTING.md | Array/object writes stage replacement values before committi |
| 258 | 6498-6499 | 22 | guide | guide 22 B: CONTRIBUTING.md | ### Experimental ABI  |
| 259 | 6500-6508 | 626 | guide | guide 626 B: CONTRIBUTING.md | Every export the program does not declare is the module's AB |
| 260 | 6509-6512 | 194 | guide | guide 194 B: CONTRIBUTING.md | A prebuilt module loads with the interop of the jz that buil |
| 261 | 6513-6535 | 1555 | guide | guide 878 B: CONTRIBUTING.md · cut: duplicate 677 B: index.d.ts JzMemory, which test/mem.js holds equal to the memory; interop.js applies jz:hostabi.skip; interop.js applies jz:hostabi.skip; test/interop.js pins it (+1) | The raw ABI is not frozen across versions: NaN-box layouts,  |
| 262 | 6536-6537 | 23 | guide | guide 23 B: CONTRIBUTING.md | ### Known limitations  |
| 263 | 6538-6551 | 878 | guide | guide 878 B: CONTRIBUTING.md | - DataView indexed own properties are unsupported; indexed w |
| 264 | 6552-6553 | 12 | guide | guide 12 B: CONTRIBUTING.md | ## Commits  |
| 265 | 6554-6555 | 57 | guide | guide 57 B: CONTRIBUTING.md | Small, focused commits. Describe what and why, not how.  |
| 266 | 6556-6557 | 24 | cut: describes | cut: describes 24 B | ### Runtime inspection  |
| 267 | 6558-6570 | 1037 | guide | cut: describes 652 B · guide 385 B: CONTRIBUTING.md | The internal `inspect` flag (`compile(source, { inspect: tru |
| 268 | 6571-6587 | 1207 | cut: describes | cut: describes 1207 B | `memory.fixed` selects exports for a final-code memory proof |
| 269 | 6588-6601 | 983 | cut: describes | cut: describes 983 B | Levels 2 and above carry integer accumulators in guarded i64 |
| 270 | 6602-6606 | 408 | cut: describes | cut: describes 408 B | Returned closures decoded by `interop.mem.read` hold their e |
