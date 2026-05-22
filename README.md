# Pulsar

A physical status light for your GitHub life. Pulsar runs as a small daemon on
your Mac that polls GitHub on a schedule, lights up the appropriate LEDs on an
Arduino sitting on your desk, and pings you with a clickable macOS notification
when something interesting happens.

## What it watches

Default mapping (fully configurable in `mac/config.json` — see
`mac/README.md` for the schema):

| LED    | Event                              |
|--------|------------------------------------|
| Red    | A build is failing on one of your PRs |
| Yellow | Someone requested your review         |
| Blue   | New comments landed on your PRs       |
| Green  | All clear — nothing needs your attention |

Click any notification to open the relevant PR in your browser.

## Repo layout

```
pulsar/
├── mac/        — Node.js + TypeScript daemon (see mac/README.md)
└── arduino/    — Arduino sketch + wiring  (see arduino/README.md)
```

## Quick start

1. **Wire up the Arduino** — see `arduino/README.md` for the circuit.
2. **Flash the sketch** — open `arduino/led_controller/led_controller.ino` in
   the Arduino IDE and upload it to an Uno or MKR Zero.
3. **Run the Mac daemon** — see `mac/README.md` for env vars and `npm` setup.

## Hardware

Tested on an Arduino Uno R3 and an Arduino MKR Zero. Both have plenty of pins
for the 4-LED setup. Any Arduino with USB serial and at least 4 digital outputs
will work.

## Roadmap

Pulsar starts with GitHub but the architecture is source-agnostic. Future
pollers might include:

- CircleCI / GitHub Actions queues
- PagerDuty incidents
- Linear issues assigned to you
- Calendar — "next meeting in 5 minutes"
