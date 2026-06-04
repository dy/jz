import { buildExample, buildKernel } from '../build.mjs'
buildExample('mandelbrot')
buildKernel('mandelbrot', 'mandelbrot.simd')   // the SIMD sibling the demo + bench run on jz
