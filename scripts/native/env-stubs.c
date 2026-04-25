#include "watr.h"
#include <stdio.h>
#include <stdlib.h>
f64 w2c_env_0x5F_ext_prop(struct w2c_env* e, f64 a, f64 b) { (void)e; (void)a; (void)b; fprintf(stderr, "__ext_prop unexpected\n"); abort(); }
u32 w2c_env_0x5F_ext_has(struct w2c_env* e, f64 a, f64 b)  { (void)e; (void)a; (void)b; return 0; }
u32 w2c_env_0x5F_ext_set(struct w2c_env* e, f64 a, f64 b, f64 c) { (void)e; (void)a; (void)b; (void)c; return 1; }
f64 w2c_env_0x5F_ext_call(struct w2c_env* e, f64 a, f64 b, f64 c){ (void)e; (void)a; (void)b; (void)c; fprintf(stderr, "__ext_call unexpected\n"); abort(); }
