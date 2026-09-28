// Light/dark theme toggle, shared by every page. jz defaults to LIGHT (blueprint paper); the no-flash
// snippet in each <head> already set document.documentElement.dataset.theme = stored-choice || 'light'
// before first paint. This module wires the .theme-toggle button(s); a click flips and persists the
// choice. OS preference is intentionally ignored; light stays the default until the user picks dark. Colors switch via the light-dark() tokens in site.css, so flipping
// data-theme is all it takes.
const root = document.documentElement
const set = (t) => { root.dataset.theme = t }

if (!root.dataset.theme) { try { set(localStorage.getItem('theme') || 'light') } catch { set('light') } }

for (const btn of document.querySelectorAll('.theme-toggle')) {
  btn.addEventListener('click', () => {
    const next = root.dataset.theme === 'light' ? 'dark' : 'light'
    set(next)
    try { localStorage.setItem('theme', next) } catch {}
  })
}
