import type { TransformOptions } from './index.js'
export type { TransformOptions }

/** Lower full JavaScript forms to canonical jz source. */
export default function transform(code: string, opts?: TransformOptions): string | null
