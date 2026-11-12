// Builds the Grid: node build.cjs [release | dist <dist repo folder>]   (plain Node, the same on Windows, macOS and Linux)
//
// Embeds the UI (../web/dist, or $UI_DIR) as base64 into src/ui-embed.cjs, then bundles everything into dist/grid.bundle.cjs.
// The database drivers (pg + pg-cursor, oracledb in Thin mode) are bundled too, but as two separate pure-JavaScript files
// (dist/drivers/pg.cjs and oracledb.cjs) that the Grid loads on first use: the main bundle stays small and nobody who does not
// use a database pays for them. Only node-pty stays outside everything (a native module, shipped in release/node_modules).
// The version (node/package.json, the only place it lives) is embedded into the bundle (src/version.cjs).
// `dist <folder>` runs `release`, then copies release/ (without the demo grid.yaml) into a clone of the distribution repo and writes
// manifest.next.json there (see publish()); the installer and `grid update` read that repo.
// `release` also copies the result to release/ (what the VDI runs) and fails when release/ holds a native binary other than
// node-pty's two ConPTY files.
const fs = require('fs'), path = require('path'), crypto = require('crypto')
const esbuild = require('esbuild')

const callerCwd = process.cwd()
process.chdir(__dirname)
const uiDir = process.env.UI_DIR || '../web/dist'
const embed = 'src/ui-embed.cjs'
const version = require('./package.json').version
const mode = process.argv[2], distArg = process.argv[3]
const common = { bundle: true, platform: 'node', target: 'node17' }

function files(dir) { // every file under dir
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)])
}

// the files copied to the dist repo: everything in release/ except the demo grid.yaml, as sorted '/' paths
function releaseFiles() {
  return files('release').map(f => path.relative('release', f).split(path.sep).join('/')).filter(f => f !== 'grid.yaml').sort()
}

// Copies release/ into the dist repo folder (files that are no longer in release/ are deleted; .git, manifest.json,
// the-grid-node-installer.cjs, README*, .gitignore and .gitattributes stay) and writes manifest.next.json. manifest.json is NOT
// touched: it must be committed last (clients read it from master and then fetch the files by tag), so the order is printed.
function publish(dist) {
  const keep = n => n === '.git' || n === 'manifest.json' || n === 'manifest.next.json' || n === 'the-grid-node-installer.cjs' || n === '.gitignore' || n === '.gitattributes' || /^README/i.test(n)
  const list = releaseFiles(), want = new Set(list)
  const removed = []
  const sweep = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!rel && keep(e.name)) continue
      const r = rel ? rel + '/' + e.name : e.name, p = path.join(dir, e.name)
      if (e.isDirectory()) { sweep(p, r); if (!fs.readdirSync(p).length) fs.rmdirSync(p) } else if (!want.has(r)) { fs.rmSync(p); removed.push(r) }
    }
  }
  sweep(dist, '')
  const entries = list.map(f => {
    const to = path.join(dist, ...f.split('/'))
    fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join('release', ...f.split('/')), to)
    const b = fs.readFileSync(to)
    return { path: f, sha256: crypto.createHash('sha256').update(b).digest('hex'), size: b.length }
  })
  // git must not touch line endings (autocrlf would break the sha256 of text files): `* -text`
  const ga = path.join(dist, '.gitattributes'), cur = fs.existsSync(ga) ? fs.readFileSync(ga, 'utf8') : null
  let attr = 'unchanged'
  if (cur === null) { fs.writeFileSync(ga, '* -text\n'); attr = 'created' } else if (!cur.split(/\r?\n/).some(l => l.trim() === '* -text')) { fs.writeFileSync(ga, cur + (cur === '' || cur.endsWith('\n') ? '' : '\n') + '* -text\n'); attr = 'appended' }
  fs.writeFileSync(path.join(dist, 'manifest.next.json'), JSON.stringify({ version, tag: 'v' + version, files: entries }, null, 2) + '\n')
  const total = entries.reduce((n, e) => n + e.size, 0)
  console.log(`\n${entries.length} files (${(total / 1048576).toFixed(1)} MB) copied to ${dist}`)
  if (removed.length) console.log('deleted (no longer in release/): ' + removed.join(', '))
  console.log(`.gitattributes (* -text): ${attr}\nmanifest.next.json written (version ${version}, tag v${version}); manifest.json was not touched.`)
  console.log(`
Publish in exactly this order (files and tag first, the manifest LAST):
  cd ${dist}
  git add -A ":!manifest.next.json"
  git commit -m "v${version}"
  git tag v${version}
  git push origin HEAD
  git push origin v${version}
then, once both pushes are done:
  ${process.platform === 'win32' ? 'Copy-Item -Force manifest.next.json manifest.json   (PowerShell)  |  copy /Y manifest.next.json manifest.json   (cmd)' : 'cp manifest.next.json manifest.json'}
  git add manifest.json
  git commit -m "manifest v${version}"
  git push origin HEAD
(clients read manifest.json from master: it must only point to a tag that is already pushed)`)
}

async function main() {
  const dist = mode === 'dist' ? path.resolve(callerCwd, distArg || '') : null
  if (mode === 'dist') {
    if (!distArg) throw new Error('usage: node build.cjs dist <dist repo folder>')
    if (!fs.existsSync(dist) || !fs.statSync(dist).isDirectory()) throw new Error(`${dist} does not exist`)
    if (!fs.existsSync(path.join(dist, '.git'))) throw new Error(`${dist} is not a git clone (no .git)`)
  }
  if (!fs.existsSync(path.join(uiDir, 'index.html'))) throw new Error(`no UI in ${uiDir}: run "npm run build" in web/ first`)
  const ui = {}
  for (const f of files(uiDir)) ui['/' + path.relative(uiDir, f).split(path.sep).join('/')] = fs.readFileSync(f).toString('base64')
  fs.writeFileSync(embed, 'module.exports=' + JSON.stringify(ui))
  try {
    await esbuild.build({ ...common, entryPoints: ['src/grid.cjs'], external: ['node-pty'], define: { __GRID_VERSION__: JSON.stringify(version) }, outfile: 'dist/grid.bundle.cjs' })
  } finally { fs.rmSync(embed, { force: true }) }

  // pg-native and cloudflare:sockets are optional and never used here; oracledb's Thick-mode binary is looked up by a computed
  // path at run time (never reached in Thin mode)
  fs.rmSync('dist/drivers', { recursive: true, force: true })
  for (const d of ['pg', 'oracledb']) {
    await esbuild.build({ ...common, entryPoints: [`src/drivers/${d}.cjs`], external: ['pg-native', 'cloudflare:sockets'], outfile: `dist/drivers/${d}.cjs`, logLevel: 'warning' })
  }

  const out = ['dist/grid.bundle.cjs', 'dist/drivers/pg.cjs', 'dist/drivers/oracledb.cjs']
  if (mode === 'release' || mode === 'dist') {
    fs.rmSync('release/drivers', { recursive: true, force: true })
    fs.mkdirSync('release/drivers', { recursive: true })
    for (const f of out) fs.copyFileSync(f, f.replace(/^dist/, 'release'))
    const allowed = ['conpty.node', 'conpty_console_list.node']
    const bad = files('release').filter(f => /\.(node|exe|dll|dylib|so)$/i.test(f) && !allowed.includes(path.basename(f)))
    if (bad.length) throw new Error('release/ must not hold native binaries:\n' + bad.join('\n'))
  }
  for (const f of out.map(f => mode === 'release' || mode === 'dist' ? f.replace(/^dist/, 'release') : f)) console.log(String(fs.statSync(f).size).padStart(9), f)
  if (mode === 'dist') publish(dist)
}

main().catch(e => { console.error(e.message); process.exit(1) })
