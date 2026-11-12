// Builds the Grid: node build.cjs [release]   (plain Node, the same on Windows, macOS and Linux)
//
// Embeds the UI (../web/dist, or $UI_DIR) as base64 into src/ui-embed.cjs, then bundles everything into dist/grid.bundle.cjs.
// The database drivers (pg + pg-cursor, oracledb in Thin mode) are bundled too, but as two separate pure-JavaScript files
// (dist/drivers/pg.cjs and oracledb.cjs) that the Grid loads on first use: the main bundle stays small and nobody who does not
// use a database pays for them. Only node-pty stays outside everything (a native module, shipped in release/node_modules).
// `release` also copies the result to release/ (what the VDI runs) and fails when release/ holds a native binary other than
// node-pty's two ConPTY files.
const fs = require('fs'), path = require('path')
const esbuild = require('esbuild')

process.chdir(__dirname)
const uiDir = process.env.UI_DIR || '../web/dist'
const embed = 'src/ui-embed.cjs'
const common = { bundle: true, platform: 'node', target: 'node17' }

function files(dir) { // every file under dir
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)])
}

async function main() {
  if (!fs.existsSync(path.join(uiDir, 'index.html'))) throw new Error(`no UI in ${uiDir}: run "npm run build" in web/ first`)
  const ui = {}
  for (const f of files(uiDir)) ui['/' + path.relative(uiDir, f).split(path.sep).join('/')] = fs.readFileSync(f).toString('base64')
  fs.writeFileSync(embed, 'module.exports=' + JSON.stringify(ui))
  try {
    await esbuild.build({ ...common, entryPoints: ['src/grid.cjs'], external: ['node-pty'], outfile: 'dist/grid.bundle.cjs' })
  } finally { fs.rmSync(embed, { force: true }) }

  // pg-native and cloudflare:sockets are optional and never used here; oracledb's Thick-mode binary is looked up by a computed
  // path at run time (never reached in Thin mode)
  fs.rmSync('dist/drivers', { recursive: true, force: true })
  for (const d of ['pg', 'oracledb']) {
    await esbuild.build({ ...common, entryPoints: [`src/drivers/${d}.cjs`], external: ['pg-native', 'cloudflare:sockets'], outfile: `dist/drivers/${d}.cjs`, logLevel: 'warning' })
  }

  const out = ['dist/grid.bundle.cjs', 'dist/drivers/pg.cjs', 'dist/drivers/oracledb.cjs']
  if (process.argv[2] === 'release') {
    fs.rmSync('release/drivers', { recursive: true, force: true })
    fs.mkdirSync('release/drivers', { recursive: true })
    for (const f of out) fs.copyFileSync(f, f.replace(/^dist/, 'release'))
    const allowed = ['conpty.node', 'conpty_console_list.node']
    const bad = files('release').filter(f => /\.(node|exe|dll|dylib|so)$/i.test(f) && !allowed.includes(path.basename(f)))
    if (bad.length) throw new Error('release/ must not hold native binaries:\n' + bad.join('\n'))
  }
  for (const f of out.map(f => process.argv[2] === 'release' ? f.replace(/^dist/, 'release') : f)) console.log(String(fs.statSync(f).size).padStart(9), f)
}

main().catch(e => { console.error(e.message); process.exit(1) })
