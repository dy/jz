// A stand-in for the suite's shared collections (a growable vector), ours.
'use strict';

class Vector {
  constructor(size) {
    this.storage = new Array(size === undefined ? 4 : size);
    this.firstIdx = 0;
    this.lastIdx = 0;
  }

  append(elem) {
    if (this.lastIdx >= this.storage.length) {
      const bigger = new Array(this.storage.length * 2);
      for (let i = 0; i < this.storage.length; i += 1) bigger[i] = this.storage[i];
      this.storage = bigger;
    }
    this.storage[this.lastIdx] = elem;
    this.lastIdx += 1;
  }

  forEach(fn) {
    for (let i = this.firstIdx; i < this.lastIdx; i += 1) fn(this.storage[i]);
  }

  size() {
    return this.lastIdx - this.firstIdx;
  }
}

exports.Vector = Vector;
