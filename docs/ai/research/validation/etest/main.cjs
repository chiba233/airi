const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const page = `<script>
  window.s = { interval: 0, chained: 0 }
  setInterval(() => { window.s.interval++ }, 100)
  function tick() { window.s.chained++; setTimeout(tick, 2000) }
  setTimeout(tick, 2000)
</script>`
app.whenReady().then(async () => {
  const mk = bt => {
    const w = new BrowserWindow({ width: 300, height: 200, show: true, webPreferences: { backgroundThrottling: bt } })
    w.loadURL('data:text/html,' + encodeURIComponent(page))
    return w
  }
  const A = mk(true), B = mk(false)
  const samples = []
  const read = async (label) => {
    const [a, b] = await Promise.all([A.webContents.executeJavaScript('({...window.s, vis: document.visibilityState})'), B.webContents.executeJavaScript('({...window.s, vis: document.visibilityState})')])
    samples.push({ label, t: Math.round(process.uptime()), A: a, B: b })
    fs.writeFileSync(process.env.OUT, JSON.stringify(samples, null, 1))
  }
  await new Promise(r => setTimeout(r, 5000))
  await read('visible-5s')
  A.hide(); B.hide()
  for (let i = 1; i <= 13; i++) {
    await new Promise(r => setTimeout(r, 30000))
    await read(`hidden-${i * 30}s`)
  }
  app.quit()
})
