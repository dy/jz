// The microsecond clock of bench.bend (now_us): CLOCK_MONOTONIC through the
// Bend runtime's io_tick, as a U32 that wraps. Spliced after the runtime by
// `bend <case>.bend -o <bin>`, which registers it as the def's effect.

Term now_us_run(Env e, Term* f, IoWork* w) {
  return (Term)(u32)(io_tick() / 1000ull);
}

static void __attribute__((constructor)) now_us_use(void) {
  io_eff(CID(now_us), now_us_run);
}
