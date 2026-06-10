# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Pulsar is a physical GitHub status light. A macOS **menu bar Electron app**
(`mac/`) polls GitHub on a timer, drives 4 LEDs on an Arduino over USB serial
(`arduino/`), and fires clickable notifications. It exposes a toggleable **MCP
server** and can launch at login. The two halves talk over a tiny plaintext
serial protocol.

The same code also runs as a **headless standalone daemon** (no Electron) for a
fast dev loop — see the two entry points below.

## Commands

All commands run from `mac/`:

```bash
npm install              # postinstall runs scripts/install-icon.js
npm run app              # build + launch the Electron app (menu bar)
npm run dev              # standalone daemon, ts-node-dev auto-reload (no Electron UI)
npm run build            # tsc → dist/  + copy renderer html/css (scripts/copy-renderer.js)
npm run pack             # electron-builder --dir → release/mac-arm64/Pulsar.app (fast, unpacked)
npm run dist             # electron-builder → release/*.dmg + *.zip
npm run icons            # regenerate tray status-dot PNGs (scripts/gen-tray-icons.js)
npm run verify:serial    # headless: serialport loads under Electron's ABI
npm run verify:mcp       # node scripts/verify-mcp.js — exercise the running MCP server
npm run arduino          # open the .ino in Arduino IDE
```

Dev affordance env vars for `npm run app`: `PULSAR_OPEN=1` auto-opens the window,
`PULSAR_MCP=1` starts the MCP server.

There is no test suite, linter, or CI. `engine.ts` (`evaluate`, `expandQuery`)
and `rules.ts` (`resolveRules`) are pure and the natural place to add unit tests.

Flash the firmware by opening `arduino/led_controller/led_controller.ino` in the
Arduino IDE and uploading to an Uno R3 or MKR Zero.

## Two entry points (important)

- **Electron app** — `electron-main.ts` (package.json `main`). Loads settings,
  builds the `Core`, attaches tray + IPC + MCP, then starts polling.
- **Standalone daemon** — `index.ts`'s `startDaemon()` runs only when launched as
  a plain Node process (`require.main === module`), used by `npm run dev`/`start`.
  It reads `.env` + `config.json` directly and has no tray/window/MCP.

`index.ts` exposes `createCore()` / `startCore()` so Electron can attach the tray
and IPC **between** construction and the first connect (the tray must subscribe
before connect to catch the initial status events).

## Configuration & the settings store

There are **two config sources**, by entry point:

- **Standalone** uses `.env` (`GITHUB_USERNAME`, optional `GITHUB_TOKEN`,
  `SERIAL_PORT`, `POLL_INTERVAL_MS`, `GITHUB_POLLER`) + `config.json` (rules),
  loaded by `config.ts`'s `loadRules()`.
- **Electron** uses `settings.ts` — a hand-rolled JSON store at
  `app.getPath('userData')/settings.json` (no `electron-store`, to stay
  CommonJS). On first run it **migrates** from `.env`/`config.json`; the GitHub
  token is encrypted with Electron `safeStorage`. The store overrides the runtime
  `config` via `applyConnectionSettings()` / `setActiveRules()` before `Core` starts.
  Note: macOS's case-insensitive FS means the dev (`pulsar`) and packaged
  (`Pulsar`) userData dirs are the **same** settings file.

`config.ts` holds the runtime `config` object the rest of the app reads
(`github.ts`, `serial.ts`, `core.ts`). `getActiveRules()` returns the store's
rules when set (Electron), else file-loaded rules (standalone).

**Two GitHub backends**, selected by `poller` (default `cli`):
- `cli` (`GithubCLIClient`) shells out to `gh api` using gh keyring auth, and
  deliberately **strips `GITHUB_TOKEN`/`GH_TOKEN` from the child env** so a stale
  token can't override working keyring auth — keep that behavior.
- `api` (`GithubAPIClient`) uses Octokit and **requires** a token.

## Architecture

`Core` (`core.ts`, an `EventEmitter`) is the single source of truth. It owns the
`ArduinoController` + `GithubClient` + rules, runs the poll loop, and emits
`serial-status` | `leds` | `tick` | `error`. The tray, the renderer (via IPC),
and the MCP server all subscribe to it and read one `Snapshot` (serial status,
LED state, last poll, matched rule hits, MCP info). Commands: `start`/`stop`/
`pollNow`/`reloadRules`/`applySettings`/`setLed`/`blink`/`setMcpInfo`.

Each `tick()`:
1. For each rule, `expandQuery()` fills `{{username}}`/`{{repos}}`/
   `{{lastChecked}}`/`{{now}}` into the GitHub Search query; `github.search()`
   runs it. Rules run **sequentially** with 200–500ms jitter to stay under
   GitHub's secondary rate limits.
2. `evaluate(hits, config)` (pure, `engine.ts`) decides which LEDs light and what
   to notify. Any matching rule lights its LEDs; if **none** matched,
   `allClear.leds` light. Notifications dedupe by URL.
3. `ArduinoController.setLed()` writes `SET <id> <0|1>\n`, only when *desired*
   state changed.

### Electron process model

- **Main process**: `electron-main.ts` (lifecycle, single-instance lock,
  `dock.hide()`, quit → LEDs off + MCP stop), `core.ts`, `tray.ts`, `settings.ts`,
  `login.ts`, `ipc.ts`, `window.ts`, `mcp/server.ts`.
- **Renderer**: `renderer/` — a sandboxed browser script (`contextIsolation: true`,
  `nodeIntegration: false`, strict CSP). It talks to main **only** through the
  `preload.ts` `contextBridge` (`window.pulsar`). `renderer.ts` must stay
  import-free so it compiles to a plain `<script>`; `index.html`/`styles.css` are
  copied to `dist/renderer/` by the build.
- **IPC** (`ipc.ts`): `getSnapshot`/`getSettings`/`updateSettings`/
  `listSerialPorts`/`pollNow`, plus live `pulsar:snapshot` pushes on Core events.
  The token is **redacted** before crossing to the renderer.
- **MCP** (`mcp/server.ts`): a toggleable Streamable-HTTP server on
  `127.0.0.1:<mcpPort>` (stateful sessions). Resources `pulsar://status|events|config`
  (token redacted) and tools `poll_now`/`set_led`/`blink`/`reload_config`. The SDK
  is loaded via `require()` (its package "exports" map isn't read by our classic
  TS moduleResolution).

### Layering (keep this separation)

- `engine.ts` / `rules.ts` are **pure** — no I/O, no Electron. Put matcher,
  query-expansion, and rule-validation logic here. `rules.ts` is shared by the
  file loader and the settings store, so it must stay Electron-free.
- `github.ts` hides the backend behind `GithubClient` (`types.ts`). Both clients
  return `SearchItem[]` **or `null`**. `null` means "backed off / rate-limited."
  Callers must treat `null` as a reason to **abandon the rest of the tick**, not
  as empty results, or LEDs falsely go to all-clear. `RateLimitTracker` applies an
  exponential backoff floor (`BACKOFF_FLOOR_SECS`).

### Key cross-file invariants

- **LED identity is the integer enum** `LedId` (`types.ts`): RED=0, YELLOW=1,
  BLUE=2, GREEN=3. These map to Arduino pins 2–5 (`led_controller.ino`) and are
  the wire IDs in `SET <id> <state>`. Changing the enum order silently re-wires
  the physical LEDs and firmware — keep enum, firmware pin array, and
  `ledNameToId` names in sync.
- **Serial is self-healing** (`serial.ts`): connects even if the Arduino appears
  after startup, and reconnects on unplug/replug. macOS does **not** emit
  close/error on unplug, so a `SerialPort.list()` **watchdog** detects removal;
  `portKey()` normalizes the `cu.`/`tty.` device nodes (list reports `tty.`, we
  open `cu.`) so a healthy link isn't falsely dropped. Event handlers are guarded
  by `this.port === port` and the `error` listener stays attached (an unhandled
  `'error'` event would crash the process). `setLed`/`allOff` never reject when
  down — desired state is re-applied on every (re)connect (opening the port resets
  the board to all-off), preceded by a confirmation blink. There's a hardcoded 2s
  post-open wait for the bootloader. Status surfaces as `connecting|connected|
  disconnected` via `onStatus()`.
- `lastChecked` is **mutable per-rule** and advances only on a *successful* poll,
  giving each rule an independent sliding window that catches up after a
  rate-limit skip.

### Packaging notes

`electron-builder.yml`: mac `dmg`+`zip`, `LSUIElement: 1` (menu bar agent, no Dock
icon), output to `release/`. serialport's native `.node` bindings **must be
`asarUnpack`ed** (can't load from inside an asar). serialport ships prebuilds
covering Electron's ABI, so no manual rebuild is needed in dev; electron-builder
rebuilds them for the packaged bundle.

## Dev gotchas

- **Only one Pulsar at a time** — the Electron app and `npm run dev` both grab the
  serial port; running both yields `Cannot lock port`. The Electron app also holds
  a single-instance lock.
- `serial.ts` is heavily `serial:`-logged for diagnosing connect/reconnect.

## Roadmap context

The poller is source-agnostic (rule = name + search query + LEDs). Future
non-GitHub sources (CI, PagerDuty, Linear, calendar) plug in as additional
`GithubClient`-style backends behind the same engine. Original phased build plan:
[`docs/plans/electron-menubar-mcp.md`](docs/plans/electron-menubar-mcp.md).
