#!/bin/sh
# Embeds ui/ as base64 into src/ui-embed.cjs, then bundles everything into dist/grid.bundle.cjs.
# The database drivers (pg + pg-cursor, oracledb in Thin mode) are bundled too, but as two separate pure-JavaScript files (dist/drivers/pg.cjs and
# oracledb.cjs) that the Grid loads on first use: the main bundle stays small and nobody who does not use a database pays for them. Only node-pty
# stays outside everything (a native module, shipped in release/node_modules). `build.sh release` also copies the result to release/ (what the VDI
# runs) and fails when release/ holds a native binary other than node-pty's two ConPTY files.
set -e
cd "$(dirname "$0")"
node -e '
const fs=require("fs"),path=require("path"),m={};
(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);e.isDirectory()?w(p):m["/"+path.relative(process.env.UI_DIR||"../web/dist",p).split(path.sep).join("/")]=fs.readFileSync(p).toString("base64")}})(process.env.UI_DIR||"../web/dist");
fs.writeFileSync("src/ui-embed.cjs","module.exports="+JSON.stringify(m))'
npx esbuild src/grid.cjs --bundle --platform=node --target=node17 --external:node-pty --outfile=dist/grid.bundle.cjs
rm src/ui-embed.cjs
# pg-native and cloudflare:sockets are optional and never used here; oracledb's Thick-mode binary is looked up by a computed path at run time (never reached in Thin mode)
rm -rf dist/drivers
for d in pg oracledb; do
  npx esbuild src/drivers/$d.cjs --bundle --platform=node --target=node17 --external:pg-native --external:cloudflare:sockets --outfile=dist/drivers/$d.cjs --log-level=warning
done
if [ "$1" = "release" ]; then
  cp dist/grid.bundle.cjs release/grid.bundle.cjs
  rm -rf release/drivers && mkdir -p release/drivers && cp dist/drivers/*.cjs release/drivers/
  bad=$(find release -type f \( -name '*.node' -o -name '*.exe' -o -name '*.dll' -o -name '*.dylib' -o -name '*.so' \) ! -name conpty.node ! -name conpty_console_list.node)
  if [ -n "$bad" ]; then echo "release/ must not hold native binaries:"; echo "$bad"; exit 1; fi
  ls -l release/grid.bundle.cjs release/drivers
fi
