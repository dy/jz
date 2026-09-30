// Temporary, opt-in title comparison: /?title=current|outline|fill|prism.
const title = document.querySelector('.hero h1.title')
if (title) {
  const css = document.createElement('link')
  css.rel = 'stylesheet'; css.href = new URL('./title-lab.css', import.meta.url)
  document.head.append(css)
  const panel = document.createElement('fieldset')
  panel.className = 'title-lab'
  panel.hidden = true
  panel.innerHTML = `<legend>Title study</legend>
    <div class="title-choices">
      <label><input type="radio" name="title-style" value="current"><span>1 Current</span></label>
      <label><input type="radio" name="title-style" value="outline"><span>2 Outline</span></label>
      <label><input type="radio" name="title-style" value="fill"><span>3 Fill on hover</span></label>
      <label><input type="radio" name="title-style" value="prism"><span>4 Prism</span></label>
    </div>
    <label class="title-preview"><input type="checkbox">Preview light</label>`
  const options = [...panel.querySelectorAll('[name="title-style"]')]
  const choose = value => {
    const mode = options.some(input => input.value === value) ? value : 'current'
    title.dataset.titleStyle = mode
    for (const input of options) input.checked = input.value === mode
    const url = new URL(location.href)
    url.searchParams.set('title', mode)
    history.replaceState(history.state, '', url)
  }
  choose(new URLSearchParams(location.search).get('title'))
  panel.addEventListener('change', ({ target }) => {
    if (target.name === 'title-style') choose(target.value)
    else title.dataset.titlePreview = String(target.checked)
  })
  css.addEventListener('load', () => { panel.hidden = false })
  document.body.append(panel)
}
