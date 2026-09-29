// Dark by default; the head snippet restores an explicit saved choice before paint.
// Only the toggle persists a preference. Colors use the shared light-dark() tokens.
const root = document.documentElement
const set = (t) => { root.dataset.theme = t }

if (!root.dataset.theme) { try { set(localStorage.getItem('theme') === 'light' ? 'light' : 'dark') } catch { set('dark') } }

for (const btn of document.querySelectorAll('.theme-toggle')) {
  btn.addEventListener('click', () => {
    const next = root.dataset.theme === 'light' ? 'dark' : 'light'
    set(next)
    try { localStorage.setItem('theme', next) } catch {}
  })
}
