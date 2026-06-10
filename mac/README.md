# Pulsar — macOS app

A macOS **menu bar app** (Electron) that watches GitHub (and other sources),
reflects status on an Arduino's LEDs over USB serial, fires native
notifications, and exposes a toggleable **MCP server** so agents can read status
and raise their own signals.

The same code also runs as a **headless standalone daemon** (no Electron) for a
fast dev loop.

## Install & run

### As an app

```bash
npm install
npm run dist        # builds release/Pulsar-<ver>-arm64.dmg (+ .zip)
```

Open the dmg, drag **Pulsar** to Applications, and launch it. It lives in the
menu bar (no Dock icon): the dot is green when all-clear, amber while connecting,
red when the Arduino isn't found. Click it for the menu — **Open Pulsar…** opens
the settings/status window.

> The build is unsigned. On first launch right-click → Open, or run
> `xattr -dr com.apple.quarantine /Applications/Pulsar.app`.

### From source (dev)

```bash
npm install
npm run app         # build + launch the Electron app
npm run dev         # or the headless daemon (no UI), ts-node-dev auto-reload
```

Dev env flags for `npm run app`: `PULSAR_OPEN=1` (auto-open the window),
`PULSAR_MCP=1` (start the MCP server), `PULSAR_TEST_PUSH=1` (demo push source).
Other scripts: `npm run build`, `npm run pack` (unpacked `.app`, faster than
`dist`), `npm run icons`, `npm run verify:serial`, `npm run verify:mcp`.

> Only one instance can hold the serial port — don't run `npm run dev` and the
> app at the same time.

## Configuration

**In the app:** tray → **Open Pulsar…**. Set GitHub username, optional token,
poller (`cli`/`api`), serial port (dropdown), poll interval, and the rules
(JSON). Changes apply live. Settings persist in
`~/Library/Application Support/Pulsar/settings.json` (token encrypted via the
macOS Keychain); on first run they migrate from any existing `.env`/`config.json`.

**Standalone (`npm run dev`):** uses `.env` (copy `.env.example`) + `config.json`
(copy `config.example.json`).

| Setting | Notes |
|---------|-------|
| GitHub username | required |
| GitHub token | only for the `api` poller; `cli` uses your `gh` login |
| Poller | `cli` (shells out to `gh`) or `api` (Octokit + token) |
| Serial port | find it with `ls /dev/cu.*` |
| Poll interval | default 60s (GitHub Search is rate-limited) |

## Rules

A rule is **a name, a source, the LEDs to light, and source-specific params**.
For the GitHub source the param is a Search query; the rule fires (its LEDs
light) when the query returns ≥1 result. The rule name is the notification title.

```jsonc
{
  "repos": ["your-org/your-repo"],            // optional; injected via {{repos}}
  "rules": [
    {
      "name": "🔴 Build failing",
      "source": "github",                      // optional, defaults to "github"
      "leds": ["red"],
      "notify": true,                          // optional, default true
      "params": { "query": "is:pr is:open author:{{username}} status:failure {{repos}}" }
    },
    {
      "name": "👀 Review requested",
      "leds": ["yellow"],
      "params": { "query": "is:pr is:open review-requested:{{username}} {{repos}}" }
    }
  ],
  "allClear": { "leds": ["green"], "notify": false }
}
```

The older flat shape — `{ "name", "query", "leds" }` with `query` at the top
level — is still accepted.

### Query placeholders (GitHub source)

| Placeholder | Value |
|-------------|-------|
| `{{username}}` | your GitHub login |
| `{{repos}}` | `repo:a/b repo:c/d` from top-level `repos` (empty if unset) |
| `{{lastChecked}}` | ISO time of this rule's last successful poll (epoch on first run) |
| `{{now}}` | current time |

`{{lastChecked}}` advances per-rule on each successful poll (independent sliding
windows). LED names: `red`, `yellow`, `blue`, `green`. `allClear.leds` light when
nothing is active; omit it to leave everything off when quiet.

## MCP server

Toggle it from the tray (**MCP server: off → on**). It serves Streamable HTTP on
`http://127.0.0.1:7332/mcp` (localhost only, no auth).

- **Tools** — `raise_signal` / `clear_signal` / `list_signals` (semantic signals
  that light LEDs and compose with GitHub; optional `ttl_seconds` auto-reverts),
  plus `poll_now` / `set_led` / `blink` / `reload_config`.
- **Resources** — `pulsar://status`, `pulsar://events`, `pulsar://config` (token
  redacted).

Claude Desktop only supports stdio servers in its config, so bridge to the
HTTP endpoint with `mcp-remote`:

```json
{
  "mcpServers": {
    "pulsar": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:7332/mcp", "--allow-http"]
    }
  }
}
```

(`--allow-http` is required for the plain-HTTP localhost endpoint. Restart Claude
Desktop after editing, and make sure the MCP server is toggled on.)

## Launch at login

Toggle **Launch at login** in the tray (uses a macOS login item; meaningful from
the installed `.app`).

## Serial protocol

Plaintext, line-terminated — one command:

```
SET <ledId:0-3> <state:0|1>\n   →   OK\n
```

The board stays dumb; the Mac app does all the logic and scheduling. The link is
self-healing: it connects even if the Arduino appears after startup, and
reconnects on unplug/replug (a `SerialPort.list()` watchdog covers macOS not
emitting a close event on unplug). On each (re)connect it plays a confirmation
blink, then re-applies the desired LED state.

## Architecture

`Core` aggregates **signals** from a registry of **event sources** (GitHub as a
pull source, MCP as a push source) into effective LED state, and is the single
source of truth for the tray, the window, and MCP. For the source layout, the
signal model, and internals see [`../CLAUDE.md`](../CLAUDE.md); design docs are in
[`../docs/plans/`](../docs/plans/).
