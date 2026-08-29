/**
 * Result-type tagging for emitted IR nodes — the single foundational primitive
 * every other src/ir/* module builds on. No dependencies, by design: everything
 * downstream (numeric coercions, pointer construction, sentinels, ...) needs this,
 * so it must not need any of them back (see .work/archive/ir-split.md's dependency-order note).
 *
 * @module ir/tag
 */

/** Tag a WASM node with its result type. */
export const typed = (node, type) => (node.type = type, node)
