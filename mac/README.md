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

Each rule is **a name, a GitHub Search query, and the LEDs to light** when
the query returns one or more results. The rule's name is also used as
the notification title (include an emoji to taste). One tick runs each
rule's query in sequence; if any rule matches, its LEDs go on. Multiple
rules can target the same LED — the LED is ON if any matching rule fires.

```jsonc
{
  "repos": ["earnix/monorepo", "earnix/pulsar"],  // optional; injected via {{repos}}
  "rules": [
    {
      "name": "🔴 Build failing",
      "query": "is:pr is:open draft:false author:{{username}} status:failure {{repos}}",
      "leds": ["red"],
      "notify": true                              // optional, default true
    },
    {
      "name": "👀 Review requested",
      "query": "is:pr is:open draft:false review-requested:{{username}} {{repos}}",
      "leds": ["yellow"]
    },
    {
      "name": "💬 Activity on my PRs",
      "query": "is:pr is:open draft:false author:{{username}} updated:>{{lastChecked}} {{repos}}",
      "leds": ["blue"]
    }
  ],
  "allClear": { "leds": ["green"], "notify": false }
}
```

### Placeholders

Expanded at query time, on every tick:

| Placeholder      | Value                                                         |
|------------------|---------------------------------------------------------------|
| `{{username}}`   | `GITHUB_USERNAME` from `.env`                                 |
| `{{lastChecked}}`| ISO timestamp of the **last successful poll of this rule** (epoch on first run) |
| `{{repos}}`      | `repo:a/b repo:c/d` expansion of top-level `repos` (empty if not set) |
| `{{now}}`        | Current time as ISO timestamp                                 |

`{{lastChecked}}` advances per-rule on each successful poll, so a rule's
sliding window is independent — a rule that hit a rate limit catches up
on the next successful poll.

### LEDs

Valid names: `red`, `yellow`, `blue`, `green`. `allClear.leds` lights
when **no** rule matched any results on this tick. If `allClear` is
omitted, nothing lights when everything is quiet.

### Failure behaviour

Missing file: built-in defaults (which replicate the shipped
`config.json`) are used. Invalid file: the daemon fails to start with
an error pointing at the offending rule.

## Serial protocol

Plaintext, line-terminated. Currently one command:

```
SET <ledId:0-3> <state:0|1>\n   →   OK\n
```

The Mac side keeps an in-memory mirror of LED state and skips redundant
writes. There is no resync on reconnect yet — if you unplug the Arduino mid-run,
restart the daemon.
