// Demo API: slow start, then serves HTTP and logs like a Spring app.
const http = require('http')
const port = Number(process.env.PORT || 8081)
const name = process.env.SERVICE_NAME || 'api'
const c = (n, s) => `\x1b[${n}m${s}\x1b[0m`
const log = (lvl, msg) => {
  const color = { INFO: 32, WARN: 33, ERROR: 31, DEBUG: 36 }[lvl]
  console.log(`${new Date().toISOString()} ${c(color, lvl.padEnd(5))} ${c(35, process.pid)} --- [${name}] ${msg}`)
}
log('INFO', `Starting ${name} on Node ${process.version} (profile=${process.env.PROFILE || 'default'})`)
log('INFO', 'Türkçe karakter testi: ğüşıöç ĞÜŞİÖÇ')
setTimeout(() => {
  http.createServer((req, res) => {
    log('INFO', `${req.method} ${req.url}`)
    res.end(JSON.stringify({ service: name, ok: true }))
  }).listen(port, () => log('INFO', `Started ${name} in 2.1 seconds, listening on port ${port}`))
}, 2000)
setInterval(() => {
  const r = Math.random()
  if (r < 0.1) log('ERROR', 'java.sql.SQLTransientConnectionException: pool timeout (demo)')
  else if (r < 0.3) log('WARN', 'slow query took 1200ms (demo)')
  else log('DEBUG', `heartbeat ok, heap ${(Math.random() * 400 + 100) | 0}MB`)
}, 3000)
process.on('SIGTERM', () => { log('INFO', 'Graceful shutdown'); process.exit(0) })
