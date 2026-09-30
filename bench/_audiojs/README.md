# audiojs lab

Real audiojs code, run as JavaScript under V8 and as jz wasm, same source on both sides.
Findings and the numbers read from it: [.work/audiojs.md](../../.work/audiojs.md).

The directory name starts with `_`, so `bench.mjs` does not pick it up as a case and no
gate depends on it. It reads two sibling checkouts and writes only to the system temp
directory.

```sh
node bench/_audiojs/kernels.mjs    # hot kernels of audio's cross-tool bench, from the real packages
node bench/_audiojs/atoms.mjs      # every atom through the entry @audio/compile-vst generates
node bench/_audiojs/shapes.mjs     # each finding as its smallest kernel: wrong, rejected, slow, math
SPEED=0 node bench/_audiojs/ffmpeg.mjs 1 # whole-task WAV decode parity against FFmpeg
```

| Variable | Default | |
|---|---|---|
| `JZ_ROOT` | this repository | compiler checkout to measure |
| `JZ_OPT` | jz's default (level 2) | optimize level of every compile: `speed`, `size`, `0` |
| `AUDIO_ROOT` | `../audio` | audiojs/audio checkout with `node_modules` installed |
| `AUDIO_FAMILY` | `../@audio` | the @audio family checkouts, `compile` among them |
| `CONC`, `OUT` | `3`, a temp file | `atoms.mjs`: parallel atoms, records file (a rerun resumes from it) |
| `SPEED` | `1` | Set to `0` for kernel/atom correctness and retention checks without timing. |

`kernels.mjs` and `atoms.mjs` take names to narrow the run (`kernels.mjs fft mel`,
`atoms.mjs effect dynamics`); `shapes.mjs` takes `wrong`, `reject`, `slow`, `math`.
`kernels.mjs` compiles every kernel at jz's default level and at `speed` and times both
beside V8 in one process, unless `JZ_OPT` names one level.

`repro/` holds the two findings that did not reduce to a few lines: `bool-or-number.js`
(a rejection) and `entry-return.js` (a wrong return kind), each with its origin in a
header comment.

## What is measured

Times are the minimum over interleaved runs of both contenders in one process, after
warm-up. Speed is V8 time over jz time: above 1× jz is faster.

Agreement is checked on every kernel and atom before it is timed: `bit-exact`, or the
error level in dB below the signal peak.

Correctness and retention checks process 256 blocks of 512 frames for streaming atoms,
at their default parameters. This crosses the later buffer expansions that a 48-block
run mistook for steady growth. Whole-render atoms render four blocks of 0.5 s with
every number parameter halfway from its default to its maximum: their defaults are often the identity, which would time a copy.

Timing retains 48 streaming blocks or two whole-render blocks per pass, so its workload
stays comparable with earlier measurements. `heapPerBlock` measures the second half of
the longer correctness run.

Other load on the machine widens the spread between runs, most for kernels above 5 ms.
Compare ranges over several runs, or run on a quiet machine.

Package sources are read unchanged. Each kernel gets an entry that fixes what the host
calls, and that same entry file is the JavaScript baseline. `kernels.mjs` exits with a
failure status if compilation, execution or parity fails. Codec bytes and every decoded
channel require exact agreement; floating DSP kernels allow rounding above 100 dB.
Failed comparisons are never timed. The WAV rows use the original packages too.

Functions that live in `audio/fn/*.js` beside the engine's registration code (`core` in
`stat.js`, `melSpectrum`, `mfcc`, `resample` in `plan.js`) are lifted verbatim between two
markers, since importing those files pulls in the whole engine.

`ffmpeg.mjs [seconds=600] [reps=6]` compares WAV decoding by the original audiojs
package under Node, that package compiled by jz, and FFmpeg. Each target starts a
fresh process, reads the same stereo 16-bit WAV, and writes the complete interleaved
Float32 PCM file. Every output must agree byte for byte. The compiler build is outside
the timer; process startup, reading, decoding and writing are inside it. This covers
WAV decoding only; it does not establish a result for other audio operations.

Use `JZ_OPT=speed` to select the speed profile and `OUT=/path/report.json` to retain
the report at a chosen path. Reports include source/input/binary hashes, all timing
samples and machine state. Timed runs rotate target order and require load ≤ 2 and
swap < 4096 MiB throughout. `SPEED=0` checks correctness without claiming performance.
