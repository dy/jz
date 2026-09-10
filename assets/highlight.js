// Highlight ranges leave the copyable code untouched. Plain text is the fallback.
if (globalThis.CSS?.highlights && globalThis.Highlight) {
  try {
    const { highlightAll } = await import('../dist/microlighter/index.js')
    await highlightAll()
  } catch (error) {
    console.warn('Code highlighting unavailable', error)
  }
}
