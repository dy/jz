// Light/dark theme toggle — shared by every page. The no-flash snippet in each <head> already set
// document.documentElement.dataset.theme before first paint (from localStorage, else the OS preference);
// this module just wires the .theme-toggle button(s) and keeps following the OS while no explicit choice
// is stored. Colors switch via the light-dark() tokens in site.css — flipping data-theme is all it takes.
const root = document.documentElement
const stored = () => { try { return localStorage.getItem('theme') } catch { return null } }
const set = (t) => { root.dataset.theme = t }

if (!root.dataset.theme) set(stored() || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'))

for (const btn of document.querySelectorAll('.theme-toggle')) {
  btn.addEventListener('click', () => {
    const next = root.dataset.theme === 'light' ? 'dark' : 'light'
    set(next)
    try { localStorage.setItem('theme', next) } catch {}
  })
}

// follow the OS live, but only while the user hasn't explicitly chosen
matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
  if (!stored()) set(e.matches ? 'light' : 'dark')
})
