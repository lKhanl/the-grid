> **This branch (`node-poc`) has no Go code.** It holds the Node.js version only: see
> [`node-poc/`](node-poc/). Run it with `cd node-poc/release && node grid.bundle.cjs serve`.
> The text below describes the Go version on `master`; not every feature exists here yet.

<p align="center">
  <img src="docs/logo.svg" alt="The Grid" width="96" height="96">
</p>

<h1 align="center">The Grid</h1>

<p align="center"><em>"The Grid. A digital frontier."</em> Your services are the programs; you run them from here.</p>

Run, watch and restart all the local services of a workspace from one browser tab —
like IntelliJ's **Services** tool window, without the IDE.

Built for the AI-agent era: the code is written by Claude/Codex in a terminal, you just
need 3–4 APIs, UIs and scripts running side by side with their logs one click away.

![The Grid: services grouped on the left, live build and run logs on the right](docs/main.png)

<table>
  <tr>
    <td width="50%"><img src="docs/form.png" alt="New service: the folder is detected as a Spring Boot project"></td>
    <td width="50%"><img src="docs/basic.png" alt="Basic theme"></td>
  </tr>
  <tr>
    <td align="center"><sub>New service — Spring Boot detected from the folder</sub></td>
    <td align="center"><sub>Basic theme (Settings)</sub></td>
  </tr>
</table>

- One self-contained binary (UI embedded), no install, no admin rights
- Groups, start/stop/restart per service, group or all
- Spring Boot (Maven), Node and script services are detected from the folder; each start
  builds when needed, then runs — no command to write
- Add / edit / delete services and runtimes from the UI (writes `grid.yaml`, keeps comments)
- Several JDKs / Node versions side by side (`runtimes`), one per service
- **Changes** view: read-only git diff per service (files as a tree, side-by-side or unified, syntax coloured) to review what an AI agent wrote
- Live colored logs (xterm.js), filter, 1k-10k lines per service (Settings → Logs, default 1k)
- Logs also go to files (`~/.grid/logs`, can be turned off), at most 10 MB per service, so they survive a restart of the Grid
- CPU and memory of each running service (its whole process tree), in the toolbar and over MCP
- **Terminals** in the same window (``Ctrl+` ``): real shells (cmd, PowerShell, Git Bash, bash, zsh…) opened in the
  selected service's folder, several at once (Windows 10 1809+ for the pseudo-console)
- **Database** panel (optional module, `-tags db`): a small Oracle SQL client you can share with your AI agent over MCP (see below)
- `depends_on` + readiness (`port` or log regex) so things start in order
- Restart policies (`on-failure`, `always`)
- Clean process-tree kill: Windows Job Objects / Unix process groups — no orphan
  `java`/`node` keeping your port busy
- Turkish Windows friendly: `encoding: cp1254` / auto-detect
- CLI for scripts and AI agents: `grid logs api -n 100`, `restart api`
- Listens on 127.0.0.1 only, with CSRF and DNS-rebinding protection

## Quick start

```sh
cp grid.example.yaml grid.yaml   # or start empty and add services in the UI
go build -o grid .               # Windows: go build -o grid.exe .
./grid -c grid.yaml              # opens http://localhost:7070
```

The default build has no Database panel. Add it with a build tag:

| tag | drivers | make |
|---|---|---|
| (none) | no Database panel | `make build` |
| `-tags db` | Oracle and PostgreSQL | `make build DB=1` |
| `-tags oracle` | Oracle only | `make build DB=oracle` |
| `-tags postgres` | PostgreSQL only | `make build DB=postgres` |

Leaving a driver out keeps it (and its network and crypto code) out of the binary entirely, which matters on locked-down
machines where endpoint protection flags new executables. `go version -m grid` lists what went in.

Grid remembers the workspaces you open in `~/.grid/state.json` (override with `$GRID_HOME`).
Without `-c` it reopens the last one; switch workspaces from the name next to the logo.

Prebuilt binaries (`grid.exe` for Windows x64, `grid-macos` for Apple silicon, `grid-linux` for Linux x86-64,
`grid-db.exe` / `grid-db-macos` / `grid-db-linux` with the Database panel, and `SHA256SUMS.txt`) are on the
[Releases](../../releases) page. The UI is prebuilt in `web/dist` and Go deps are vendored, so building only needs
Go — no npm or internet access.

Keyboard (Services): `j`/`k` move, `/` filter the log, `s` start or stop, `r` restart, `c` clear, `n` new,
`e` edit, ``Ctrl+` `` terminals.

## Service types: build, then run

Like an IDE run configuration, a service can say *what* it is instead of giving a command.
The commands are derived on every start, so they follow changes in `pom.xml`:

| `type` | build step (every start) | run |
|---|---|---|
| `spring-boot` | `mvn -B -Dmaven.test.skip=true package [-pl <module> -am]` (uses `mvnw` if present), skipped when nothing changed | `java <jvm_args> -jar <module>/target/*.jar --spring.profiles.active=…` |
| `spring-boot` + `mode: run` | — | `mvn spring-boot:run` |
| `node` | `npm/yarn/pnpm install`, only when `package.json` or the lock file changed | `npm run <script>` |
| `script` | — | the `.bat` / `.cmd` / `.ps1` / `.sh` / `.py` file |
| `jar` | — | `java <jvm_args> -jar <file> <args>` (an already built jar; `file` may use `*`, newest match wins) |
| `custom` (default) | — | `command` as written |

A Spring Boot build is **skipped when nothing changed**: Grid remembers when the last build started and
compares it with the newest file under `src/`, the `pom.xml` files and `.mvn` (the jar's own date can't be used).
Tick **Always rebuild** (`always_build: true`) to build on every start. By default tests are neither run nor
compiled (`skip_tests`), which is the biggest saving on a slow machine.

While the build runs the service shows **building**; a failed build stops there (the app is
not started), and Stop/Restart during a build cancel it. Right-click → **Run without build**
starts the last build output. Crash restarts reuse the last build.

In the form, pick the working directory (type it or **Browse…**) and the project is detected:
Spring Boot apps in single- or multi-module Maven builds (by `@SpringBootApplication`), the
main class, `java.version` (matching Java runtime preselected), `server.port` (URL), profile
files (`application-*.yml`), or `package.json` scripts, lock file and `engines.node`.
The generated build and run commands are previewed as you edit.

## For AI agents: `grid mcp`

`grid mcp` is an MCP server (stdio) with these tools, so an agent can run the
edit → restart → read logs loop without you copy-pasting:

| tool | what it does |
|---|---|
| `status` | services and their state (with CPU and memory while running) |
| `logs` | last N log lines of a service (colors removed). Filters save tokens: `level` (error / warn), `grep` (regex), `since_restart`, `context` (lines after each match, for stack traces) |
| `describe` | one service in full: folder, build and run command, URL, readiness, dependencies, runtimes, CPU / memory, log file |
| `restart` | restart / start / stop, waits until it is running or failed, returns the last log lines |
| `wait` | keep waiting for a service that `restart` reported as still building / starting |

Slow machines (a VDI building with Maven) are handled so the agent never mistakes a long build for a
failure: `restart` waits at most 40 s by default (`grid mcp --wait 60` to change it; keep it under the
agent's tool timeout), then answers "STILL BUILDING ... not a failure, call `wait`" and the agent calls
`wait` instead of restarting again. While waiting it also sends MCP progress notifications, so clients
that reset their timeout on progress keep waiting. `status` shows how long a service has been building.

The Grid itself must be running (`grid`). Register it in the agent's MCP config, for example
(OpenCode style; the key names depend on the agent):

```json
{ "mcp": { "grid": { "type": "local", "command": ["C:\\tools\\grid.exe", "mcp"], "enabled": true,
                      "environment": { "GRID_PORT": "7070" } } } }
```

Without MCP the same works through the CLI (`grid status`, `grid logs <svc> -n 100`, `grid restart <svc>`).

## Database panel

Optional module: only in builds with `-tags db`, `-tags oracle` or `-tags postgres` (see Quick start;
`grid-db.exe` on the Releases page has both drivers). Without it the panel and the `db_*` MCP tools are not there;
with one driver the connection form only offers that database.

A small SQL client for **Oracle** and **PostgreSQL** (pure Go drivers, go-ora and pgx: no client to install, one
exe is enough). Oracle targets 19c (tried against 23ai); PostgreSQL 10 or newer (tried against 17). The automated
tests use a fake driver.

Open the **Database** panel (cylinder icon), add a connection (Oracle: host + port + service name, or SID, or a TNS
descriptor / alias from `tnsnames.ora`; PostgreSQL: host + port + database and the SSL mode), test it, then browse schemas, tables and columns on the left and write SQL
on the right:

- **Run:** `Ctrl+Enter` runs the selection, or everything; `Ctrl+Shift+Enter` only the statement under the cursor.
  `Stop` cancels a running statement.
- **Several statements** (separated by `;`) run one after the other, each result in its own tab, stopping at the
  first error. Oracle: a PL/SQL block ends with a line holding only `/`. PostgreSQL: `;` inside `$$ … $$` bodies is
  part of the body.
- **Completion:** tables, views, schemas and columns from the database as you type (`FROM emp…`, `e.` after an alias).
- **Results:** a scrolling grid you can copy or download as CSV, paged with Prev / Next. The row limit
  (10–1000) is next to **Run**.

- **Commit and rollback:** by default changes wait for **Commit** / **Rollback** (a yellow bar reminds you).
  Tick "Commit every statement automatically" on the connection if you prefer that.
- **Where connections live:** `~/.grid/connections.json`, per user, not in `grid.yaml`. Passwords are stored as
  plain text there (the file is readable by your user only).
- **PostgreSQL specifics:** DDL is transactional, so it waits for Commit like DML does. `BEGIN` / `END` typed in
  the editor work too. A failed statement only undoes itself: each one runs behind a savepoint, so the transaction
  is not left aborted. `VACUUM`, `CREATE DATABASE` and the like run outside the transaction.

### Sharing a database with AI (MCP)

Each connection has an **AI access (MCP)** setting: *Read-only* (default), *Read and write*, or *Not shared*.
`grid mcp` then offers these tools for the shared connections:

| tool | what it does |
|---|---|
| `db_list` | the shared connections and whether the AI may change data |
| `db_tables` | find tables and views (name fragment, schema or `*` for all) |
| `db_describe` | columns, primary / unique / foreign keys, indexes, comments of one table |
| `db_query` | one `SELECT` / `WITH`, result as small plain text (row and size limits) |
| `db_execute` | `INSERT` / `UPDATE` / `DELETE` / DDL, committed on success; only on *Read and write* connections |

Read-only is enforced by the Grid, not by trusting the agent: the statement must be a single `SELECT` / `WITH`
without `FOR UPDATE`, it runs inside `SET TRANSACTION READ ONLY` and is always rolled back, and anything else is
refused before it reaches the database. A separate read-only database user is still the strongest protection.
Everything the AI reads goes to your model provider; there is no masking, so share only what you may.

## Log files

Besides the history in memory, every line a service logs is appended (colours removed, with time and stream) to
`~/.grid/logs/<workspace>-<hash>/<service>.log` (`$GRID_HOME/logs` when that is set). It is on by default;
turn it off with **Save logs to files** in Settings → Logs (saved in `~/.grid`). The folder is shown there, and
`describe` over MCP gives the file of a service. Each service takes at most **10 MB**: when
`<service>.log` reaches 5 MB it becomes `<service>.log.1` (replacing the older one) and a new file starts. Clearing
the log in the UI does not touch the files. Idle files are closed after 30 s, so they can be opened or deleted at any time.

## CPU and memory

While a service (or its build) runs, the toolbar shows the CPU (one core = 100%) and resident memory of its
whole process tree, e.g. `mvn` → `java`, sampled every 2 seconds. On Windows the numbers come from the service's
Job Object, on Linux from `/proc`, on macOS from `ps`. `status` and `describe` over MCP show them too.

## Adding and editing services in the UI

**New** (sidebar, or `N`), the **+** on a group header, **✎** on a row, right-click → **Edit**,
or **Edit** in the toolbar (`E`) open the form. Saving writes `grid.yaml` directly:

- the file is edited as a YAML tree, so comments and keys the form doesn't know are kept
- the result is validated before it replaces the file; an invalid change is rejected and
  the file is left untouched; the previous version is kept as `grid.yaml.bak`
- editing a running service applies on its next start (**Save & restart** does both);
  renaming requires the service to be stopped, and `depends_on` references follow the rename
- deleting a running service stops it first; a service others depend on can't be deleted

Deep links: `http://localhost:7070/#new`, `#new=<group>`, `#new-dir=<folder>`, `#edit=<service>`,
`#runtimes`, `#runtime=<name>`.

## CLI

```
grid [serve] [-c file] [-p 7070] [--no-browser]
grid status [--json]
grid start|stop|restart|clear <service|group|all>
grid logs <service> [-n 200] [-f] [--raw]
grid reload
grid runtimes              # check every runtime path and print its real version
grid mcp [-p 7070] [--wait 40]   # MCP server for AI agents (see above)
```

For the fans: `grid programs` = status, `grid rez <x>` = start, `grid derezz <x>` = stop,
`grid eol` ("end of line") stops everything. `GRID_PORT` overrides the port.

## Config

See [`grid.example.yaml`](grid.example.yaml) for every option.

| key | meaning |
|---|---|
| `type` | `spring-boot`, `node`, `script`, `jar` or `custom` (default); see *Service types* |
| `spring` / `node` / `script` / `jar` | options of the typed service (module, profiles, jvm_args, args, mode, skip_tests, always_build, offline / script, args, install, package_manager / file, args / file, jvm_args, args) |
| `command` | command line for `custom` services, run through `shell` |
| `shell` | Windows: `cmd` (default), `powershell`, `pwsh` or a bash path; Unix: `/bin/sh` |
| `cwd` | working directory, relative to the config file |
| `group` | sidebar group |
| `env`, `env_file` | environment; `${VAR}` references are expanded |
| `depends_on` | services that must be ready first |
| `ready` | `{ port: 8080 }` or `{ log: "Started .* in" }`, optional `timeout` |
| `restart`, `max_restarts` | `no` / `on-failure` / `always` |
| `autostart` | start when the runner starts |
| `changes` | `false` keeps this service's project out of the **Changes** view (form: *Show this project in Changes*). Services sharing a working directory are one project, so `false` on any of them hides it |
| `changes_ignore` | paths left out of the **Changes** view without touching git (tracked files too), relative to `cwd`: `*.iml` (any depth), `tmp/` (a folder), `src/app-local.yml`, `**/gen/*.java`. Right-click a file or folder in Changes → *Hide from Changes* adds one; the header shows how many are hidden and can show them dimmed |
| `encoding` | `auto` (default), `utf-8`, `cp1254` |
| `url` | link shown in the UI |
| `stop_timeout` | grace period before kill (Unix), default `10s` |
| `runtime` | one name or a list from `runtimes` (e.g. `[java-11, maven-3.9]`) |
| `color` | force colored output (`FORCE_COLOR`, Spring ANSI), default `true` |

## Runtimes (several JDKs / Node versions side by side)

```yaml
runtimes:
  java-11:   { home: "C:/Program Files/Java/jdk-11.0.24" }
  java-17:   { home: "C:/Program Files/Java/jdk-17.0.21.0.2" }
  maven-3.9: { home: "C:/Program Files/JetBrains/IntelliJ IDEA 2025.3.3/plugins/maven/lib/maven3" }
  node-20:   { home: "C:/tools/node-v20.18.0-win-x64" }

services:
  legacy-api: { command: "java -jar legacy.jar", runtime: java-11 }
  account-api: { command: "mvn spring-boot:run", runtime: [java-17, maven-3.9] }
  web-ui: { command: "npm run dev", runtime: node-20 }
```

Without `runtime:` a service uses whatever is on the system PATH. With it, the runtime's
bin dir is put first on PATH. There are three types:

| type | what it does |
|---|---|
| `java` | sets `JAVA_HOME` and puts `bin` first on PATH, so `java` and `mvn` use this JDK |
| `node` | puts the Node folder first on PATH (`node`, `npm`, `npx`); the plain Windows zip works |
| `script` | any tool folder (Maven, Gradle, Python, own scripts): its `bin` (or the folder itself) goes first on PATH |

The type is inferred from the name (`java-*`, `jdk*`, `jre*` → java, `node*` → node,
anything else → script) or set with `type:`. A service may use at most one java and one node runtime
but any number of script runtimes. A runtime may carry its own `env` (e.g. `MAVEN_OPTS`).
`grid runtimes` checks every path and prints the real version; a missing path
makes the service fail with a clear message.

Runtimes can also be managed in the UI: the **Runtimes** list at the bottom of the
sidebar (or **+ New runtime** in the service form) opens a form that checks the folder
while you type and shows the real `java -version` / `node --version`. A runtime that a
service still uses cannot be deleted; renaming one updates the services that use it.

## Development

```sh
make dev     # Go API on :7070 + Vite with hot reload on :5173
make build   # local binary in bin/ (build web/dist first when the UI changed)
make web     # rebuild web/dist (commit it)
make vendor  # after changing Go deps (commit vendor/)
make windows # cross-compile bin/grid.exe
make linux   # cross-compile bin/grid-linux
make test     # Go tests of both builds (the Database tests use a fake driver, no Oracle needed)
```
