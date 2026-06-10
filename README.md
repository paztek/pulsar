# Pulsar

A physical status light for your GitHub life. Pulsar is a **macOS menu bar app**
that watches GitHub (and other sources), lights the matching LEDs on an Arduino
on your desk, and pings you with a clickable notification. It also exposes an
**MCP server**, so agents can read your status and raise their own signals.

## What it watches

Default mapping (fully configurable in the settings window — see `mac/README.md`):

| LED    | Event                                    |
|--------|------------------------------------------|
| Red    | A build is failing on one of your PRs    |
| Yellow | Someone requested your review            |
| Blue   | New activity on your PRs                  |
| Green  | All clear — nothing needs your attention |

Click any notification to open the relevant PR.

## Features

- Menu bar icon reflecting Arduino connectivity; the LEDs reflect GitHub status
- Clickable macOS notifications
- Settings/status window (GitHub, serial port, poll interval, rules)
- Toggleable MCP server — agents read status and `raise_signal` their own LEDs
- Launch at login

## Repo layout

```
pulsar/
├── mac/      — macOS menu bar app (Electron) + standalone daemon  (see mac/README.md)
└── arduino/  — Arduino sketch + wiring                            (see arduino/README.md)
```

## Quick start

1. **Wire up the Arduino** — see `arduino/README.md` for the circuit.
2. **Flash the sketch** — open `arduino/led_controller/led_controller.ino` in the
   Arduino IDE and upload it to an Uno or MKR Zero.
3. **Install the Mac app** — see `mac/README.md` (build the `.dmg`, or run from
   source). Then set your GitHub login and serial port in the settings window.

## Hardware

Tested on an Arduino Uno R3 and an Arduino MKR Zero. Any Arduino with USB serial
and at least 4 digital outputs works. The board is dumb — it just receives
`SET <led> <0|1>` commands; all logic and scheduling live in the Mac app.

## Extending — event sources

Pulsar is **source-agnostic**: GitHub is a *pull* source and the MCP server is a
*push* source, both behind one interface. New sources — CI/Actions queues,
PagerDuty incidents, Linear issues, calendar, a Confluence "page needs your
attention" — plug in as additional source implementations without touching the
LED/notification core. See [`CLAUDE.md`](CLAUDE.md) and
[`docs/plans/event-sources.md`](docs/plans/event-sources.md).
