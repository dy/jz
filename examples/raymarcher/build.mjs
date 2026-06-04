import { buildExample, buildKernel } from '../build.mjs'
buildExample('raymarcher')
buildKernel('raymarcher', 'raymarcher.simd')   // the SIMD sibling the demo + bench run on jz
