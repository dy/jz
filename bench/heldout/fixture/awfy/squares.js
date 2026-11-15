// Fixture program whose result verifies in every engine: a vector of squares summed.
'use strict';

const { Benchmark } = require('./benchmark');
const som = require('./som');

class Squares extends Benchmark {
  benchmark() {
    const v = new som.Vector();
    for (let i = 0; i < 100; i += 1) v.append(i * i);
    let sum = 0;
    v.forEach((x) => { sum += x; });
    return sum;
  }

  verifyResult(result) {
    return result === 328350;
  }
}

exports.newInstance = () => new Squares();
