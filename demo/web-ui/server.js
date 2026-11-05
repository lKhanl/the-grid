// Tiny stand-in for a Vite/React dev server.
const http = require('http')
const i = process.argv.indexOf('--port')
const port = Number(i > 0 ? process.argv[i + 1] : process.env.PORT || 3000)
http.createServer((req, res) => res.end('<h1>web-ui</h1>')).listen(port, () => {
  console.log(`  ➜  Local:   http://localhost:${port}/  (node ${process.version})`)
})
