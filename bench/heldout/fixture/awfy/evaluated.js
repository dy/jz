// Fixture program that jz refuses on purpose: it builds code at run time (`Function`,
// README "What is not supported").
'use strict';

const { Benchmark } = require('./benchmark');

class Evaluated extends Benchmark {
  benchmark() {
    return new Function('a', 'b', 'return a * b')(6, 7);
  }

  verifyResult(result) {
    return result === 42;
  }
}

exports.newInstance = () => new Evaluated();
