// Light/dark theme toggle, shared by every page. jz defaults to DARK (it matches the project's
// identity); the no-flash snippet in each <head> already set document.documentElement.dataset.theme =
// stored-choice || 'dark' before first paint. This module wires the .theme-toggle button(s); a click
// flips and persists the choice. OS preference is intentionally ignored; dark stays the default until
// the user explicitly picks light. Colors switch via the light-dark() tokens in site.css, so flipping
// data-theme is all it takes.
const root = document.documentElement
const set = (t) => { root.dataset.theme = t }

if (!root.dataset.theme) { try { set(localStorage.getItem('theme') || 'dark') } catch { set('dark') } }

for (const btn of document.querySelectorAll('.theme-toggle')) {
  btn.addEventListener('click', () => {
    const next = root.dataset.theme === 'light' ? 'dark' : 'light'
    set(next)
    try { localStorage.setItem('theme', next) } catch {}
  })
}
