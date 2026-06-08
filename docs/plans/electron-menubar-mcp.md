# Plan: Electron menu bar app + MCP server + launch-at-login

Status: **proposed** · Created 2026-06-08 · Target: `mac/`

Turn the current Node/TypeScript daemon into a macOS **menu bar (tray) Electron
app** with a tiny GUI, a status-reflecting tray icon, a **toggleable MCP server
(read + control)**, and an optional **launch-at-login** toggle.

## Locked decisions

| Area | Decision |
|------|----------|
| MCP scope | **Read + control** — expose status/events/matched GitHub items as resources, plus tools to trigger a poll, override/blink LEDs, and reload config. |
| Configuration | **In-app GUI settings** via `electron-store`; one-time migration from existing `.env` + `config.json`. |
| Packaging | **Packaged `.app`/`.dmg`** via `electron-builder`; menu bar agent (`LSUIElement`). Code signing/notarization deferred. |
| MCP transport | **Streamable HTTP on `127.0.0.1:<port>`** (app is long-running and toggled at runtime; clients connect to a URL). |
| GUI | Minimal vanilla TS + HTML/CSS, no UI framework. |
| Notifications | Replace `node-notifier` with Electron's native `Notification` + `shell.openExternal`. |

## Current code we reuse (mostly unchanged)

- `engine.ts` — pure `evaluate()` / `expandQuery()`. **Keep as-is.**
- `github.ts` — `GithubAPIClient` / `GithubCLIClient` + rate limiting. **Keep.**
- `serial.ts` — resilient `ArduinoController` (reconnect, watchdog, blink). **Add a status EventEmitter** (below).
- `types.ts`, `log.ts` — keep; `log.ts` should also forward lines to the renderer/log buffer.
- `config.ts` → **replaced** by `settings.ts` (electron-store) + a migration shim.
- `notifications.ts` → **rewritten** on Electron `Notification`.
- `index.ts` → **split** into `main/index.ts` (app lifecycle) + `core.ts` (poll loop).

## Target architecture

```
┌──────────────────────────── Electron MAIN process ────────────────────────────┐
│                                                                                │
│  app lifecycle (main/index.ts)                                                 │
│    • single-instance lock, app.dock.hide(), wiring, quit handling              │
│                                                                                │
│  Core (core.ts)  ──EventEmitter──▶ 'serial-status' | 'tick' | 'leds' | 'error' │
│    • owns ArduinoController + GithubClient + rules                             │
│    • runs the poll loop (was index.ts tick())                                   │
│    • exposes commands: pollNow(), setLed(), reloadConfig(), getSnapshot()       │
│        │                  │                    │                                │
│        ▼                  ▼                    ▼                                │
│   serial.ts          github.ts            engine.ts                            │
│   (status events)    (search)             (pure)                               │
│                                                                                │
│  Subscribers to Core:                                                          │
│    • Tray (tray.ts) ........ icon + menu reflect 'serial-status'                │
│    • Window/IPC (ipc.ts) ... push status/events to renderer                    │
│    • MCP server (mcp/) ..... resources read snapshot; tools call commands       │
│                                                                                │
│  Settings (settings.ts) .... electron-store; safeStorage for token             │
│  Login (login.ts) .......... app.setLoginItemSettings                          │
└───────────────┬───────────────────────────────────────────────┬────────────────┘
                │ contextBridge (preload)                        │ Streamable HTTP
                ▼                                                ▼ 127.0.0.1:<port>
        Renderer (BrowserWindow)                          MCP clients
        status + settings panel                           (Claude Desktop, etc.)
```

### Core as the single source of truth

Everything (tray, GUI, MCP) reads/acts through **one `Core` instance**. Core is
an `EventEmitter` so subscribers stay decoupled. It holds the latest snapshot:

```ts
interface Snapshot {
  serial: 'connecting' | 'connected' | 'disconnected';
  serialPort: string;
  leds: Record<'red'|'yellow'|'blue'|'green', boolean>;
  lastTickAt: string | null;
  ruleHits: Array<{ rule: string; items: SearchItem[] }>;  // latest matched GitHub items
  mcp: { enabled: boolean; url: string | null };
}
```

`ArduinoController` gains a status callback/emitter (`connecting`→`connected`→
`disconnected`) sourced from the existing connect/onDrop/watchdog transitions —
no new detection logic, just surface what we already log.

## Repo restructure (`mac/`)

```
mac/
  package.json            electron app + electron-builder
  electron-builder.yml
  tsconfig.json           (main/preload — commonjs)  + tsconfig.renderer.json
  assets/
    pulsar.icns
    trayTemplate.png …    tray icons per status (see Tray section)
  src/
    main/
      index.ts            app lifecycle + wiring
      core.ts             poll loop + EventEmitter (extracted from old index.ts)
      tray.ts             Tray, menu, icon state machine
      window.ts           BrowserWindow (popover-style) management
      settings.ts         electron-store schema + migration (replaces config.ts)
      login.ts            launch-at-login
      ipc.ts              typed IPC handlers
      mcp/
        server.ts         start/stop + Streamable HTTP transport
        tools.ts          poll_now, set_led, blink, reload_config
        resources.ts      pulsar://status | events | config
      github.ts serial.ts engine.ts notifications.ts types.ts log.ts  (moved)
    preload/
      index.ts            contextBridge: window.pulsar = { getSnapshot, on, ... }
    renderer/
      index.html  main.ts  styles.css
```

## Component designs

### 1. Tray icon ↔ connectivity

Tray reflects **serial connectivity** (the requirement). Icon states:

| State | Icon | Tooltip |
|-------|------|---------|
| `connected` | solid/“on” glyph (green accent) | `Pulsar — connected on /dev/cu.usbmodemXXXX` |
| `connecting` / reconnecting | amber/“pulsing” glyph | `Pulsar — connecting…` |
| `disconnected` | dimmed/outline glyph (or red) | `Pulsar — Arduino not found` |

- macOS menu bar wants **Template images** (monochrome, auto-tinted). For colored
  status we use **non-template status icons** (one PNG per state, `@1x`+`@2x`).
  Generate from `pulsar.icns` or a simple dot glyph.
- Optional later: small overlay badge when a red/build-failure LED is active.

Tray menu:
- Status line (disabled item): connectivity + port.
- **Open Pulsar** → toggles the settings/status window.
- **MCP server** → checkbox toggle; sub-label shows `http://127.0.0.1:<port>/mcp` when on.
- **Launch at login** → checkbox.
- **Poll now**.
- **Quit**.

### 2. Settings (`electron-store`) + migration

> **Implemented (Phase 3) as a hand-rolled JSON store** (`settings.ts`: a
> `settings.json` in `app.getPath('userData')`) rather than `electron-store`,
> to stay CommonJS and dependency-free (electron-store v9+ is ESM-only and
> caused interop friction). Same behavior — schema, migration, `safeStorage`
> token. Swap to `electron-store` later if richer features are wanted.

Schema (persisted): `githubUsername`, `githubToken` (encrypted via Electron
`safeStorage`), `poller` (`cli`|`api`), `serialPort`, `pollIntervalMs`, `rules`
(the existing rule array), `allClear`, `repos`, `mcpEnabled`, `mcpPort`,
`launchAtLogin`.

Migration (first run only): if `mac/.env` and/or `mac/config.json` exist, import
their values into the store, then leave the files in place (don’t delete). The
old `loadRules()`/`validate()` logic moves into `settings.ts` and validates the
rules array coming from either source.

Token security: store the GitHub token with `safeStorage.encryptString` (Keychain-
backed) rather than plaintext JSON. The `cli` poller needs no token, so it stays
the recommended default.

### 3. Renderer GUI (minimal)

One small window, two sections:
- **Status**: connectivity, last poll time, lit LEDs (colored dots), latest
  matched items per rule, a tail of recent log lines.
- **Settings form**: username, token (password field), poller select, serial
  port **dropdown populated from `SerialPort.list()`**, poll interval, MCP
  on/off + port, launch-at-login. Rules editor = raw JSON textarea with validate-
  on-save for v1 (structured editor later).

Preload exposes a typed, minimal API over IPC (`getSnapshot`, `updateSettings`,
`pollNow`, `setMcpEnabled`, `setLaunchAtLogin`, `onSnapshot(cb)`); no `nodeIntegration`,
`contextIsolation: true`.

### 4. MCP server (read + control, toggleable)

Built on `@modelcontextprotocol/sdk` with the **Streamable HTTP** transport bound
to `127.0.0.1:<mcpPort>`. Started/stopped by the toggle; state persisted.

Resources (read):
- `pulsar://status` — the `Snapshot` (connectivity, LEDs, last tick, MCP info).
- `pulsar://events` — latest matched GitHub items grouped by rule.
- `pulsar://config` — current rules/settings **with the token redacted**.

Tools (control → call `Core`):
- `poll_now` — force an immediate tick.
- `set_led` — set/override one LED (`name`, `on`, optional `ms` auto-revert);
  transient — the next tick re-asserts engine state.
- `blink` — run the confirmation pattern (or a custom one).
- `reload_config` — re-read settings/rules.

Security: localhost bind only; optional shared-secret header (`mcpToken`) the user
can copy from settings; never expose the GitHub token via resources. Document that
clients which only support **stdio** MCP servers need a thin stdio→HTTP bridge
(out of scope for v1; HTTP works with remote/custom connectors).

### 5. Launch at login

`app.setLoginItemSettings({ openAtLogin, openAsHidden: true })`, toggled from tray
and settings, persisted, and reconciled with the OS state on boot. Works cleanly
once the app is signed; unsigned builds may prompt — note in README.

### 6. Packaging (electron-builder)

- Add `electron`, `electron-builder`, `@electron/rebuild`.
- `electron-builder.yml`: `appId`, mac targets `dmg` + `zip`, `category`
  `public.app-category.developer-tools`, icon `assets/pulsar.icns`,
  `mac.extendInfo.LSUIElement: 1` (menu bar agent, no Dock icon).
- Scripts: `build` (tsc, main+preload+renderer), `start` (`electron .`),
  `dist` (`electron-builder`), keep `dev` for fast iteration.
- Entry `main` → compiled `dist/main/index.js`.

## Native-module gotcha (call out early)

`serialport` is a **native module** and must be rebuilt against Electron’s Node
ABI, or `require('serialport')` throws `NODE_MODULE_VERSION` mismatch at runtime.
- Use `@electron/rebuild` (electron-builder runs it via `npmRebuild`), and pin
  Electron + serialport to versions with available prebuilds.
- Verify in **Phase 0** before building anything else on top.

## Phased implementation

Each phase is independently runnable/verifiable.

- **Phase 0 — Scaffold + native check.** Add Electron + electron-builder + rebuild;
  multi-target tsc; a bare `main/index.ts` that boots the existing loop under
  Electron main, `app.dock.hide()`, single-instance lock. **Verify:** app runs,
  `serialport` loads under Electron, LEDs still drive, unplug/replug still
  reconnects (regression check of current behavior).
- **Phase 1 — Core extraction + status events.** Move `tick()` into `Core`
  (EventEmitter); `ArduinoController` emits `connecting|connected|disconnected`.
  **Verify:** logs show status transitions; behavior unchanged.
- **Phase 2 — Tray.** Tray icon state machine + menu (status, Poll now, Quit)
  subscribed to Core. **Verify:** icon flips on unplug/replug; Poll now works.
- **Phase 3 — Settings store + migration.** `electron-store` schema, `.env`/
  `config.json` import, `safeStorage` token. Core reads from store. **Verify:**
  fresh run migrates existing config; editing store changes behavior.
- **Phase 4 — Renderer GUI.** Window + preload + IPC; status view + settings form
  with serial-port dropdown and rules JSON editor. **Verify:** edit settings in UI
  → persists → Core picks up; status updates live.
- **Phase 5 — MCP server.** SDK + Streamable HTTP, resources + tools, tray/settings
  toggle, persisted. **Verify:** MCP Inspector connects; `poll_now`/`set_led` act;
  resources reflect live snapshot; token redacted.
- **Phase 6 — Launch at login.** Toggle + reconcile. **Verify:** enable → app
  starts hidden on reboot/login.
- **Phase 7 — Packaging.** electron-builder config, LSUIElement, tray icons, dmg.
  **Verify:** built `.app` runs as a menu bar agent (no Dock icon); all phases work
  from the packaged build.

## Security checklist

- [ ] GitHub token encrypted at rest (`safeStorage`); redacted in MCP `config` resource.
- [ ] MCP bound to `127.0.0.1` only; optional shared-secret header.
- [ ] Renderer: `contextIsolation: true`, `nodeIntegration: false`, preload-only API.
- [ ] `shell.openExternal` only on validated `https://github.com/...` URLs from notifications.
- [ ] Single-instance lock to avoid two daemons fighting over the serial port.

## Open questions / future

- MCP auth: is a shared-secret header wanted for v1, or is localhost-only enough?
- Tray “alert” overlay when build-failure LED is active — include or skip?
- Distribute signed/notarized builds (needs Apple Developer ID) — later milestone.
- Structured rules editor in the GUI (vs raw JSON) — later.
- Optional stdio→HTTP MCP bridge for clients without HTTP connector support.
```
