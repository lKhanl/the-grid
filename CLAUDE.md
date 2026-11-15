# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The Grid: a local supervisor (run/watch/restart services of a workspace from one browser tab) with a React UI, a CLI, an MCP server for AI agents and a small Oracle/PostgreSQL SQL client. `master` is the **Node.js** version (`node/` + `web/`); the old Go version only lives on the `golang` branch. `README.md` documents the user-facing features and the `grid.yaml` format; `grid.example.yaml` lists every option.

## Commands

Backend (run in `node/`; plain CommonJS `.cjs`, no TypeScript, no linter):

```sh
npm install
node src/grid.cjs serve --no-browser   # dev: runs straight from src/, UI is read from ../web/dist (no bundling needed)
npm test                                # node --test test/db.test.cjs test/update.test.cjs
node --test test/mcpconfig.test.cjs     # a single test file (this one is NOT in `npm test`)
node --test --test-name-pattern="x" test/db.test.cjs   # a single test by name
npm run build                           # esbuild -> node/dist/ (needs web/dist)
npm run release                         # same + copy to node/release/ (bundle, drivers, node-pty); release/ is gitignored
npm run dist -- <dist repo folder>      # release + copy into the distribution repo + manifest.next.json
```

Frontend (run in `web/`): `npm run dev` (Vite on :5173), `npm run build` (`tsc --noEmit && vite build` → `web/dist`, which is **committed**; the backend embeds it, so rebuild it after any UI change).

Default port is `18900` (`-p` or `$GRID_PORT`). `web/vite.config.ts` still proxies `/api` to `localhost:7070` (left over from the Go version): change it or start the backend with `-p 7070` when using `npm run dev`.

## Architecture

**Backend (`node/src/`)** is one process, `grid.cjs`, which does three things depending on the first argument: `serve` (HTTP server + WebSocket terminals + service supervisor), `mcp` (stdio MCP server that only talks to an already running Grid over its HTTP API, header `X-Grid: mcp`), and the small CLI (`status`, `logs`, `start|stop|restart`, `update`, `version`). `serve` also handles one-shot `/api/do/<svc>/<action>` calls from the CLI.

Key modules:
- `config.cjs` loads/validates `grid.yaml`; `plan.cjs` turns a typed service (`spring-boot`, `node`, `script`, `jar`) into build + run commands on every start; `detect.cjs` inspects a folder (pom.xml, package.json…) to prefill the form and drive `plan.cjs`.
- `service.cjs` is the process lifecycle (build → run, readiness, `depends_on`, restart policy, process-tree kill, log history and log files).
- `edit.cjs` edits `grid.yaml` as a YAML *tree* so comments are kept, validates before replacing, and keeps `grid.yaml.bak`. It backs both the UI forms (`api.cjs`) and the MCP `service_*` / `runtime_*` tools.
- `workspaces.cjs` keeps `~/.grid` (`$GRID_HOME`): recent workspaces, settings, logs. `stats.cjs` samples CPU/memory per process tree; `git.cjs` powers the read-only **Changes** view.
- Database panel: `db.cjs` (facade) → `dbmanager.cjs` (connections, sessions, MCP read-only enforcement) → `dbdrivers.cjs` / `src/drivers/{pg,oracledb}.cjs`; `dbstore.cjs` persists `~/.grid/connections.json`; `sqltext.cjs` / `dbformat.cjs` split statements and format results.
- `mcp.cjs` defines the tools and their (deliberately short, token-frugal) text answers; `restart` waits up to 40 s and then tells the agent to call `wait`, so a slow Maven build is never mistaken for a failure.
- `update.cjs` is the self-updater (`grid update`, check on `serve`): downloads a verified copy into `~/.grid/node/<dir>` and only then switches `install.json`. The distribution repo address is never in this repo (it comes from `install.json` or `$GRID_DIST_URL`).

**Bundling (`node/build.cjs`)**: `web/dist` is embedded as base64 into a temporary `src/ui-embed.cjs`, then esbuild produces `grid.bundle.cjs`. The `pg` and `oracledb` drivers are built as *separate* files in `drivers/` and loaded lazily; `node-pty` (native, terminals) stays external: `release` copies its JS and the two Windows ConPTY binaries from `node_modules` into `release/node_modules` (`copyPty` in `build.cjs`). `release` fails if `release/` contains any native binary other than node-pty's two ConPTY files. The version lives only in `node/package.json` and is injected at build time (`version.cjs`).

**Frontend (`web/src/`)**: React 19 + Vite + xterm.js + CodeMirror. `App.tsx` composes the panels (services, Changes, Terminals, Database via `ActivityBar`); `api.ts` / `dbApi.ts` are the typed clients for the backend API; styling is in `styles.css` / `theme.ts` (Grid Neon theme).

## Gotchas

- The server listens on 127.0.0.1 only and mutating API calls require the `X-Grid` header (CSRF) plus a localhost `Host`/`Origin` (DNS rebinding); keep that when adding endpoints. Unknown `/api/*` paths return 501.
- `node/release/`, `node/dist/` and `src/ui-embed.cjs` are gitignored build output; `web/dist` is the committed one.
- Windows is the main target (Turkish locale: `cp1254` encodings, cmd/PowerShell shells, Job-Object-style tree kill), but the code also runs on macOS/Linux.
- `grid.yaml`, `*.local.yaml` and `*.yaml.bak` are gitignored; `demo/` holds sample projects (Spring Boot, Node) for trying the typed services.
