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

There is no test suite, linter, or CI. The pure modules — `sources.ts`
(`aggregateLeds`), `rules.ts` (`resolveRules`), `engine.ts` (`expandQuery`) — are
the natural place to add unit tests.

Flash the firmware by opening `arduino/led_controller/led_controller.ino` in the
Arduino IDE and uploading to an Uno R3 or MKR Zero.

## Source layout (`src/`)

Grouped by concern; `dist/` mirrors this tree.

```
electron-main.ts          # Electron entry (package.json "main")
core/      core.ts launcher.ts config.ts settings.ts rules.ts engine.ts types.ts log.ts
ui/        login.ts  tray/tray.ts  window/{window,preload,ipc}.ts  window/renderer/*
sources/   sources.ts test-push.ts  github/{github-source,client}.ts  mcp/{server,push-source}.ts
serial/    serial.ts notifications.ts
```

Path notes: `ui/tray/tray.ts` loads icons from `../../../assets/tray`;
`ui/window/window.ts` loads the renderer/preload from its own dir; the build
copies `renderer/*.{html,css}` to `dist/ui/window/renderer/` (`copy-renderer.js`).

## Two entry points (important)

- **Electron app** — `electron-main.ts` (package.json `main`). Loads settings,
  builds the `Core`, attaches tray + IPC + MCP, then starts polling.
- **Standalone daemon** — `core/launcher.ts`'s `startDaemon()` runs only when
  launched as a plain Node process (`require.main === module`), used by
  `npm run dev`/`start`. Reads `.env` + `config.json`; no tray/window/MCP.

`core/launcher.ts` exposes `createCore()` / `startCore()` so Electron can attach
the tray and IPC **between** construction and the first connect (the tray must
subscribe before connect to catch the initial status events).

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

`config.ts` holds the runtime `config` object the rest of the app reads (the
GitHub client, `serial.ts`, `core.ts`). `getActiveRules()` returns the store's
rules when set (Electron), else file-loaded rules (standalone).

**Two GitHub backends**, selected by `poller` (default `cli`):
- `cli` (`GithubCLIClient`) shells out to `gh api` using gh keyring auth, and
  deliberately **strips `GITHUB_TOKEN`/`GH_TOKEN` from the child env** so a stale
  token can't override working keyring auth — keep that behavior.
- `api` (`GithubAPIClient`) uses Octokit and **requires** a token.

## Architecture

`Core` (`core.ts`, an `EventEmitter`) is the single source of truth. It owns the
`ArduinoController`, a registry of **event sources**, and the rules; runs the
poll loop; and emits `serial-status` | `leds` | `tick` | `error`. The tray, the
renderer (via IPC), and the MCP server subscribe to it and read one `Snapshot`
(serial status, LED state, last poll, rule hits, **active signals**, MCP info).
Commands: `start`/`stop`/`pollNow`/`reloadRules`/`applySettings`/`setLed`/
`blink`/`setMcpInfo`/`addPushSource`/`removePushSource`.

### Event sources → signals → effective LEDs

Everything that can light a LED is an **event source** producing **`Signal`s**
("something needs attention"; carries `leds`, `notify`, optional `expiresAt`).
See `sources.ts`. Two kinds:

- **`PullSource`** — polled on the timer. `GithubSource` (`sources/github/github-source.ts`) is
  the only one today: it owns query expansion (`expandQuery`), the per-rule
  sliding window (`lastChecked`), inter-rule jitter, and rate-limit backoff,
  returning `Signal[]` or `null` (backed off).
- **`PushSource`** — runs continuously and owns its signal set with TTL expiry;
  calls `onChange()` to trigger re-aggregation. `McpPushSource`
  (`sources/mcp/push-source.ts`) lets an agent `raise`/`clear` semantic signals.

`Core.recompute()` is the **single writer**: it unions every source's active
signals (`collectSignals`), folds them to effective LED state
(`aggregateLeds`: a LED is on if any signal lights it; `allClear` when none),
writes only changed LEDs via `ArduinoController.setLed()` (`SET <id> <0|1>\n`),
updates the snapshot, emits, and fires notifications **only for newly-appeared
signal ids** (`fireFreshNotifications` — not every tick). It's **coalesced** so a
poll tick and a push `onChange` can't interleave.

`tick()` polls the pull sources into a per-source cache (`lastSignals`; a
backed-off source keeps its last set) then calls `recompute()`. Push sources call
`recompute()` directly via `onChange`.

### Electron process model

- **Main process**: the entry plus everything under `core/`, `sources/`,
  `serial/`, and `ui/` (tray, window, ipc, login) — see Source layout above.
- **Renderer**: `ui/window/renderer/` — a sandboxed browser script (`contextIsolation: true`,
  `nodeIntegration: false`, strict CSP). It talks to main **only** through the
  `preload.ts` `contextBridge` (`window.pulsar`). `renderer.ts` must stay
  import-free so it compiles to a plain `<script>`; `index.html`/`styles.css` are
  copied to `dist/ui/window/renderer/` by the build.
- **IPC** (`ipc.ts`): `getSnapshot`/`getSettings`/`updateSettings`/
  `listSerialPorts`/`pollNow`, plus live `pulsar:snapshot` pushes on Core events.
  The token is **redacted** before crossing to the renderer.
- **MCP** (`sources/mcp/server.ts`): a toggleable Streamable-HTTP server on
  `127.0.0.1:<mcpPort>` (stateful sessions). Resources `pulsar://status|events|config`
  (token redacted). Tools: **semantic** `raise_signal`/`clear_signal`/`list_signals`
  (drive the push source — compose with other sources, optional TTL) and **control**
  `poll_now`/`set_led`/`blink`/`reload_config` (`set_led` is a raw, transient
  force). The SDK is loaded via `require()` (its "exports" map isn't read by our
  classic TS moduleResolution). On start the manager registers an `McpPushSource`
  with the Core; on stop it removes it.

### Layering (keep this separation)

- `engine.ts` / `rules.ts` / `sources.ts` are **pure** — no I/O, no Electron.
  `engine.ts` holds the `Rule` type, `expandQuery`, `ledNameToId`. `rules.ts`
  validates/parses rule config (shared by the file loader and the settings store,
  so it must stay Electron-free). `sources.ts` holds the `Signal`/source
  interfaces and `aggregateLeds`. There is no longer an `evaluate()` — folding
  signals to LEDs lives in `Core.recompute()` + `aggregateLeds`.
- A **rule** is `{ name, source, leds, notify, params }` (`source` defaults to
  `github`, whose `params.query` is the search). `rules.ts` is back-compatible
  with the old top-level `query`. Unknown `source` values parse fine and are
  simply ignored until a matching source is registered — the extensibility seam.
- `github.ts` hides the backend behind `GithubClient` (`types.ts`); `GithubSource`
  wraps it. A client returns `SearchItem[]` **or `null`** — `null` means "backed
  off / rate-limited," which makes the source return `null` and the Core **keep
  that source's last signals** for the round (never falsely all-clear).
  `RateLimitTracker` applies an exponential backoff floor (`BACKOFF_FLOOR_SECS`).

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
- Dev flags for `npm run app`: `PULSAR_OPEN=1` (auto-open window), `PULSAR_MCP=1`
  (start MCP), `PULSAR_TEST_PUSH=1` (register `test-push.ts`, a demo push source).

## Adding a new event source

To add, say, Confluence-as-poll: implement `PullSource` in a new
`*-source.ts` (its `poll(rules, ctx)` returns `Signal[]`), register it in
`Core.pullSources()`, and let users add rules with `"source": "confluence"` and
source-specific `params`. Nothing in the LED writer, aggregation, notifications,
tray, or MCP changes. Push-style sources implement `PushSource` and are added via
`Core.addPushSource()`.

## Roadmap context

The event-source abstraction (plan: [`docs/plans/event-sources.md`](docs/plans/event-sources.md))
is implemented — GitHub is a `PullSource`, MCP is a `PushSource`. The original
Electron/MCP build is [`docs/plans/electron-menubar-mcp.md`](docs/plans/electron-menubar-mcp.md).
Timed LED control is covered by `raise_signal(ttl_seconds)`.
