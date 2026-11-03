// The microsecond clock of bench.bend (now_us) on Bend's JavaScript lane,
// so `bend <case>.bend` runs a port without a native build.

function now_us() {
  return Math.floor(performance.now() * 1000) >>> 0;
}

io_eff(CID(now_us), now_us);
