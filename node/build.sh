#!/bin/sh
# Embeds ui/ as base64 into src/ui-embed.cjs, then bundles everything into dist/grid.bundle.cjs
set -e
cd "$(dirname "$0")"
node -e '
const fs=require("fs"),path=require("path"),m={};
(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);e.isDirectory()?w(p):m["/"+path.relative(process.env.UI_DIR||"../web/dist",p).split(path.sep).join("/")]=fs.readFileSync(p).toString("base64")}})(process.env.UI_DIR||"../web/dist");
fs.writeFileSync("src/ui-embed.cjs","module.exports="+JSON.stringify(m))'
npx esbuild src/grid.cjs --bundle --platform=node --target=node17 --external:node-pty --outfile=dist/grid.bundle.cjs
rm src/ui-embed.cjs
