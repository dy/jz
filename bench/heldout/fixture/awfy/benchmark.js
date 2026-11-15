// A stand-in for Are-we-fast-yet's benchmark.js, written to its documented interface
// (the base class of every benchmark: innerBenchmarkLoop runs benchmark() and checks
// each result with verifyResult), so the held-out harness is tested on code of ours.
'use strict';

class Benchmark {
  innerBenchmarkLoop(innerIterations) {
    for (let i = 0; i < innerIterations; i += 1) {
      if (!this.verifyResult(this.benchmark(), innerIterations)) {
        return false;
      }
    }
    return true;
  }

  benchmark() {
    throw new Error('subclass responsibility');
  }

  verifyResult() {
    throw new Error('subclass responsibility');
  }
}

exports.Benchmark = Benchmark;
