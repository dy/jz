;; tokenizer.wat — hand-written WebAssembly baseline for the tokenizer bench.
;;
;; String-heavy scan: charCodeAt-equivalent (i32.load8_u), branch-heavy
;; lexer, integer token accumulator, FNV-1a mix. The hand-WAT version is the
;; floor — each charCodeAt is a single-byte load with no bounds check, no
;; rope concat, no UTF-16 view; just the raw u8 stream V8 sees once
;; everything has been lowered.
;;
;; Memory layout: source bytes at 0; a few wasm pages is plenty for the
;; 40448-byte input the bench builds.
;;
;; Note on sources: tokenizer.js stores characters as u16 (JS String
;; charCodeAt) while we read u8. The input is pure ASCII (the BASE
;; literal) so both produce identical mix() inputs. No checksum drift.

(module
  (memory (export "memory") 4)

  ;; Write `len` bytes from JS into linear memory at offset 0.
  ;; Called once at startup with the precomputed source string.
  (func (export "store") (param $ptr i32) (param $byte i32)
    (i32.store8 (local.get $ptr) (local.get $byte)))

  ;; Hot scan loop. Returns the FNV-1a checksum >>> 0.
  ;; Mirrors tokenizer.js scan(src) exactly.
  (func (export "scan") (param $ptr i32) (param $len i32) (result i32)
    (local $i i32) (local $c i32)
    (local $h i32) (local $tokens i32)
    (local $number i32) (local $inNumber i32) (local $inIdent i32)
    (local.set $h (i32.const 0x811c9dc5))
    (local.set $tokens (i32.const 0))
    (local.set $number (i32.const 0))
    (local.set $inNumber (i32.const 0))
    (local.set $inIdent (i32.const 0))
    (local.set $i (i32.const 0))
    (block $exit
      (loop $top
        (br_if $exit (i32.ge_s (local.get $i) (local.get $len)))
        (local.set $c
          (i32.load8_u (i32.add (local.get $ptr) (local.get $i))))

        ;; if (c >= 48 && c <= 57)  → digit
        (if (i32.and
              (i32.ge_s (local.get $c) (i32.const 48))
              (i32.le_s (local.get $c) (i32.const 57)))
          (then
            ;; number = ((number * 10) + (c - 48)) | 0
            (local.set $number
              (i32.add
                (i32.mul (local.get $number) (i32.const 10))
                (i32.sub (local.get $c) (i32.const 48))))
            (local.set $inNumber (i32.const 1)))
          (else
            ;; if (inNumber) flush
            (if (local.get $inNumber)
              (then
                (local.set $h
                  (i32.mul
                    (i32.xor (local.get $h) (local.get $number))
                    (i32.const 0x01000193)))
                (local.set $tokens (i32.add (local.get $tokens) (i32.const 1)))
                (local.set $number (i32.const 0))
                (local.set $inNumber (i32.const 0))))
            ;; isAlpha(c) = (A..Z) | (a..z) | _
            (if (i32.or
                  (i32.or
                    (i32.and
                      (i32.ge_s (local.get $c) (i32.const 65))
                      (i32.le_s (local.get $c) (i32.const 90)))
                    (i32.and
                      (i32.ge_s (local.get $c) (i32.const 97))
                      (i32.le_s (local.get $c) (i32.const 122))))
                  (i32.eq (local.get $c) (i32.const 95)))
              (then
                (if (i32.eqz (local.get $inIdent))
                  (then
                    (local.set $h
                      (i32.mul
                        (i32.xor (local.get $h) (local.get $c))
                        (i32.const 0x01000193)))
                    (local.set $tokens (i32.add (local.get $tokens) (i32.const 1)))))
                (local.set $inIdent (i32.const 1)))
              (else
                (if (i32.gt_s (local.get $c) (i32.const 32))
                  (then
                    (local.set $h
                      (i32.mul
                        (i32.xor (local.get $h) (local.get $c))
                        (i32.const 0x01000193)))
                    (local.set $tokens (i32.add (local.get $tokens) (i32.const 1)))))
                (local.set $inIdent (i32.const 0))))))

        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $top)))

    ;; trailing flush: if (inNumber) mix(h, number)
    (if (local.get $inNumber)
      (then
        (local.set $h
          (i32.mul
            (i32.xor (local.get $h) (local.get $number))
            (i32.const 0x01000193)))
        (local.set $tokens (i32.add (local.get $tokens) (i32.const 1)))))
    ;; mix(h, tokens)
    (local.set $h
      (i32.mul
        (i32.xor (local.get $h) (local.get $tokens))
        (i32.const 0x01000193)))
    (local.get $h))
)
