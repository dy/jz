import { buildExample, buildKernel } from '../build.mjs'
buildExample('attractors')
buildKernel('attractors', 'attractors.simd')   // the SIMD f64x2 sibling the demo + bench run on jz
