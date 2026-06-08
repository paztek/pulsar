# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Pulsar is a physical GitHub status light. A Node.js + TypeScript daemon (`mac/`)
polls GitHub on a timer, drives 4 LEDs on an Arduino over USB serial (`arduino/`),
and fires clickable macOS notifications. The two halves talk over a tiny plaintext
serial protocol.

## Commands

All commands run from `mac/`:

```bash
npm install              # also runs scripts/install-icon.js via postinstall
npm run dev              # ts-node-dev with --respawn auto-reload (primary dev loop)
npm run build            # tsc → dist/
npm start                # node dist/index.js (after build)
npm run arduino          # open the .ino in Arduino IDE
```

There is no test suite, linter, or CI configured. `engine.ts` (`evaluate`,
`expandQuery`) is pure and the natural place to add unit tests first if asked.

Flash the firmware by opening `arduino/led_controller/led_controller.ino` in the
Arduino IDE and uploading to an Uno R3 or MKR Zero.

## Runtime config

- `.env` (copy from `.env.example`) holds `GITHUB_USERNAME`, optional
  `GITHUB_TOKEN`, `SERIAL_PORT`, `POLL_INTERVAL_MS`. Find the port with `ls /dev/cu.*`.
- **Two GitHub backends**, selected by `GITHUB_POLLER` (default `cli`):
  - `cli` (`GithubCLIClient`) shells out to `gh api` and uses the gh keyring auth.
    It deliberately **strips `GITHUB_TOKEN`/`GH_TOKEN` from the child env** so a
    stale `.env` token can't override working keyring auth — keep that behavior.
  - `api` (`GithubAPIClient`) uses Octokit and **requires** `GITHUB_TOKEN`.
- `config.json` (copy from `config.example.json`) holds the rules. If the file is
  missing, `defaultRules()` in `config.ts` supplies built-in defaults that mirror
  the shipped config; if present but invalid, the daemon refuses to start.

## Architecture

The daemon is a loop in `index.ts` calling `tick()` every `POLL_INTERVAL_MS`.
Each tick:

1. For each rule, `expandQuery()` fills `{{username}}`, `{{repos}}`,
   `{{lastChecked}}`, `{{now}}` into the rule's GitHub Search query, then
   `github.search()` runs it. Rules run **sequentially** with 200–500ms jitter
   between them to stay under GitHub's secondary rate limits.
2. `evaluate(hits, config)` (pure, in `engine.ts`) decides which LEDs to light
   and which events to notify on. Any matching rule lights its LEDs; if **no**
   rule matched, `allClear.leds` light instead. Notifications dedupe by URL.
3. `ArduinoController.setLed()` writes `SET <id> <0|1>\n` over serial — but only
   when the *desired* LED state actually changed, to avoid spamming the bus. The
   link is self-healing: it connects even if the Arduino appears after startup
   and reconnects on unplug/replug. `setLed`/`allOff` never reject when the link
   is down — they only update desired state, which is re-applied on every
   (re)connect (opening the port resets the board to all-off).
4. Notification clicks open the captured PR URL.

`SIGINT` turns all LEDs off and closes the port cleanly.

### Layering (keep this separation)

- `engine.ts` is **pure** — no I/O, no Octokit, no serial. `evaluate` and
  `expandQuery` are deterministic given their inputs. Put matcher/query logic here.
- `github.ts` hides the backend behind the `GithubClient` interface (`types.ts`).
  Both clients return `SearchItem[]` **or `null`**. `null` means "backed off /
  rate-limited — no info this tick." Callers must treat `null` as a reason to
  **abandon the rest of the tick** rather than as empty results, otherwise LEDs
  would falsely go to all-clear. The `RateLimitTracker` applies an exponential
  backoff floor (`BACKOFF_FLOOR_SECS`) on repeated hits.
- `serial.ts`, `notifications.ts` are thin I/O wrappers.

### Key cross-file invariants

- **LED identity is the integer enum** `LedId` (`types.ts`): RED=0, YELLOW=1,
  BLUE=2, GREEN=3. These map directly to Arduino pins 2–5 (`led_controller.ino`)
  and are the wire IDs in the `SET <id> <state>` protocol. Changing the enum order
  silently re-wires the physical LEDs and the firmware — keep enum, firmware pin
  array, and `ledNameToId` names in sync.
- `lastChecked` is **mutable per-rule** and advances only on a *successful* poll
  of that rule, giving each rule an independent sliding window that catches up
  after a rate-limit skip. The `Rule` object is intentionally mutated in `tick()`.
- After serial connect there's a hardcoded 2s wait because the Arduino resets on
  connect; the firmware does a startup blink to signal it's alive.

## Roadmap context

The poller is intentionally source-agnostic (rule = name + search query + LEDs).
Future non-GitHub sources (CI queues, PagerDuty, Linear, calendar) would plug in
as additional `GithubClient`-style backends behind the same engine.

**Active plan:** converting `mac/` into an Electron menu bar app (status-reflecting
tray icon), a toggleable MCP server (read + control), and launch-at-login — see
[`docs/plans/electron-menubar-mcp.md`](docs/plans/electron-menubar-mcp.md). The
existing `engine.ts`/`github.ts`/`serial.ts` are reused as the Core in the Electron
main process; `config.ts` is replaced by an `electron-store` settings layer.
