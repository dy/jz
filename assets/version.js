// Single source of truth for the version shown in page headers.
// Reads the deployed package.json and fills every `.ver [data-ver]` slot — plain DOM,
// no framework, so any page includes it with one <script type="module"> tag. import.meta.url
// is always …/assets/version.js, so ../package.json resolves to the site root regardless of
// the including page's depth. The hardcoded slot text stays as a no-flash fallback if fetch fails.
fetch(new URL('../package.json', import.meta.url))
  .then(r => r.json())
  .then(p => { if (p.version) for (const s of document.querySelectorAll('.ver [data-ver]')) s.textContent = 'v' + p.version })
  .catch(() => {})
