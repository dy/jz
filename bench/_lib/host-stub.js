// A host adapter a library case declares but a bench render never calls (a
// device or codec package): its default export and the named exports the
// engine reads are null, so the bundle instantiates; a call would fail loudly.
export default null
export const from = null
