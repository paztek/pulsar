# Pulsar — macOS daemon

Node.js + TypeScript app that polls GitHub on a timer, drives the Arduino's
LEDs over USB serial, and fires native macOS notifications.

## Software architecture

```
                           ┌─────────────────────────┐
                           │       index.ts          │
                           │   (main polling loop)   │
                           └────────────┬────────────┘
                                        │ tick() every N seconds
                       ┌────────────────┼────────────────┐
                       ▼                ▼                ▼
              ┌────────────────┐ ┌─────────────┐ ┌────────────────┐
              │  github.ts     │ │  serial.ts  │ │ notifications  │
              │ GithubPoller   │ │  Arduino    │ │     .ts        │
              │                │ │ Controller  │ │                │
              └────────┬───────┘ └──────┬──────┘ └────────┬───────┘
                       │                │                 │
                       ▼                ▼                 ▼
              ┌────────────────┐ ┌─────────────┐ ┌────────────────┐
              │ @octokit/rest  │ │ serialport  │ │ node-notifier  │
              │  (GitHub API)  │ │ (USB ⇄ MCU) │ │  (NSUserNotif) │
              └────────────────┘ └──────┬──────┘ └────────┬───────┘
                                        │                 │
                                        ▼                 ▼
                                 ┌─────────────┐   ┌─────────────┐
                                 │  Arduino    │   │  Click →    │
                                 │  (LEDs)     │   │  open URL   │
                                 └─────────────┘   └─────────────┘
```

Each `tick()`:

1. `GithubPoller.poll()` fans out three concurrent GitHub Search API calls
   (review requests, recent comments, failing builds) and returns a flat
   list of events, each tagged with its kind, repo, author, title and URL.
2. `evaluate(events, rules)` runs the user's `config.json` rules against
   the events and decides which LEDs to light and which events to notify on.
3. `ArduinoController.setLed()` writes `SET <id> <0|1>\n` over serial, but
   only if the in-memory state for that LED actually changed (avoids
   spamming the serial bus).
4. For each notification-worthy event, `notify()` posts a macOS
   notification with the PR URL captured in the click callback.

On `SIGINT` the daemon turns all LEDs off and closes the serial port cleanly.

## File map

| File                  | Responsibility                                          |
|-----------------------|---------------------------------------------------------|
| `src/index.ts`        | Boot, polling loop, signal handling                     |
| `src/config.ts`       | Reads `.env` and validates `config.json` rules          |
| `src/engine.ts`       | Pure `evaluate(events, rules)` matcher                  |
| `src/types.ts`        | `LedId` enum and shared interfaces                      |
| `src/github.ts`       | `GithubPoller` — wraps the Octokit search API           |
| `src/serial.ts`       | `ArduinoController` — `serialport` wrapper, state diff  |
| `src/notifications.ts`| Thin wrapper around `node-notifier` with URL callback   |
| `config.json`         | User-editable event → LED mapping rules                 |

## Setup

```bash
cp .env.example .env
# Fill in:
#   GITHUB_TOKEN     — a classic PAT with `repo` scope (only needed for GITHUB_POLLER=api)
#   GITHUB_USERNAME  — your GitHub login
#   SERIAL_PORT      — find it with: ls /dev/cu.*

cp config.example.json config.json
# Edit `repos` and `rules` to taste — see "Mapping rules" below.

npm install
npm run dev     # ts-node-dev with auto-reload
# or:
npm run build && npm start
```

## Configuration

| Env var             | Default                  | Notes                              |
|---------------------|--------------------------|------------------------------------|
| `GITHUB_TOKEN`      | —                        | Required                           |
| `GITHUB_USERNAME`   | —                        | Required                           |
| `SERIAL_PORT`       | `/dev/cu.usbmodem14101`  | Match what `ls /dev/cu.*` shows   |
| `POLL_INTERVAL_MS`  | `60000`                  | GitHub Search API is rate-limited |
| `CONFIG_PATH`       | `config.json`            | Path to the rules file            |

## Mapping rules — `config.json`

Which events light which LEDs is controlled by `config.json` (next to
`package.json`). Each rule has an optional predicate (`when`) and a
required list of `leds` to light when an event matches. Multiple rules
can target the same LED — the LED is ON if any matching rule fires.

```jsonc
{
  "repos": ["earnix/monorepo", "earnix/pulsar"],  // optional; if non-empty, only events on these repos are fetched
  "rules": [
    {
      "name": "Hotfix titles flash red + yellow",
      "when": {
        "event": "build_failing",       // string | string[]; optional
        "repo":  "earnix/monorepo",     // string | string[]; optional
        // "repoPattern":   "^earnix/", // alternative to repo
        "author": ["alice", "bob"],     // string | string[]; optional
        "titleIncludes": ["hotfix"]     // string | string[]; optional
        // "titlePattern":  "^\\[P0\\]" // alternative to titleIncludes
      },
      "leds":   ["red", "yellow"],      // required, non-empty
      "notify": true                    // optional, default true
    }
  ],
  "allClear": { "leds": ["green"], "notify": false }
}
```

Within a rule, all present predicates must match (AND). Across rules,
results OR on the LED side. `allClear` lights when no rule matched any
event. Valid `event` values: `build_failing`, `needs_review`,
`new_comment`. Valid LED names: `red`, `yellow`, `blue`, `green`.

Behaviour on a missing file: built-in defaults (which replicate the
shipped `config.json`) are used. Invalid file: the daemon fails to start
and prints the offending rule.

## Serial protocol

Plaintext, line-terminated. Currently one command:

```
SET <ledId:0-3> <state:0|1>\n   →   OK\n
```

The Mac side keeps an in-memory mirror of LED state and skips redundant
writes. There is no resync on reconnect yet — if you unplug the Arduino mid-run,
restart the daemon.
