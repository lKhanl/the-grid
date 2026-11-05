// Demo worker: does some work, then crashes, to show restart: on-failure.
let n = 0
const id = setInterval(() => {
  n++
  console.log(`[worker] processed batch #${n}`)
  if (n === 4) console.error('[worker] warning: queue lag 12s')
  if (n === 8) {
    console.error('[worker] FATAL: lost connection to queue')
    process.exit(3)
  }
}, 1000)
process.on('SIGTERM', () => { clearInterval(id); console.log('[worker] bye'); process.exit(0) })
