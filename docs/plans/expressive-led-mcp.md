# Plan: Expressive timed LED commands over MCP

Status: **proposed** · Created 2026-06-10 · Target: `mac/`

Let an MCP agent request timed LED actions like *"turn the red LED on for 5
seconds."* The Mac app owns a **schedule** and sends only raw `SET <id> <0|1>`
commands to the board at the right moments. **The firmware stays dumb — zero
board changes.**

## Why this needs a state model

Today the poll loop calls `arduino.setLed(id, ruleResult)` directly every tick,
and the MCP `set_led` tool is documented as transient ("the next poll
re-asserts rule state"). There's no place for a temporary manual state that
survives, and no notion of duration. Timed overrides require splitting two
layers and computing an **effective** state.

## Core design: an override layer

```
effective[led] = override[led]   when an override is active for that LED
               : ruleState[led]   otherwise
```

- **Rule layer** — what `evaluate()` wants, recomputed each poll.
- **Override layer** — timed manual states from MCP, each with an optional expiry.
- A single writer, `applyEffective()`, is the **only** caller of
  `arduino.setLed()`. Both the poll loop and the scheduler invoke it. The
  existing desired-state diff in `ArduinoController` still dedupes writes to the
  bus.

When an override expires, the LED automatically reverts to whatever the rules
currently say — no explicit "turn back off" needed from the agent.

## New component: `LedScheduler`

A small module sitting between `Core` and `ArduinoController`.

State:
- `ruleState: Record<led, boolean>` — set by each poll.
- `overrides: Map<LedId, Override>` where
  `Override = { state: boolean; expiresAt: number | null; sequence?: Step[] }`
  and `Step = { at: number; state: boolean }` (for blink patterns).

Mechanics:
- A **timeline** of pending transitions (sorted by `at`) and a **single master
  timer** that wakes at the next event, applies it, recomputes `effective`,
  writes only changed LEDs, then reschedules. One coalesced timer — not N stray
  `setTimeout`s.
- Pure helper `computeEffective(ruleState, overrides, now): Record<led, boolean>`
  — unit-testable without timers.
- **Wall-clock** based: timers keep running across a serial unplug. On reconnect
  `ArduinoController` re-applies its current desired (= last effective) state, so
  an override survives a blink/reconnect and shows the right state for the
  remaining window.

Example — "red on for 5s":
1. `overrides.set(RED, { state: true, expiresAt: now + 5000 })`
2. schedule a wake at `now + 5000` → on fire, delete the override, recompute
   `effective`, write the change (RED reverts to rule state).

## Integration with the poll loop

- `tick()` computes `ruleState` (4 booleans) but **no longer writes LEDs
  directly**. It calls `scheduler.setRuleState(ruleState)`, which recomputes
  `effective` and writes changed LEDs.
- Override expiry / blink steps call the same recompute+write path.
- Net: `applyEffective()` is the single writer; rules and overrides compose
  through it.

## MCP API (expanded)

Replaces today's transient `set_led` / all-LEDs `blink`.

| Tool | Args | Behavior |
|------|------|----------|
| `set_led` | `led` (enum), `on` (bool), `duration_seconds?` (number) | Override a LED. Auto-reverts after the duration; indefinite if omitted (see decisions). Returns `{ reverts_at }`. |
| `blink_led` | `led`, `count?=3`, `on_ms?=250`, `off_ms?=250` | Timed blink pattern on one LED via a `sequence`, then revert. |
| `clear_led` | `led?` | Drop one or all overrides → back to rule-driven. |
| `poll_now`, `reload_config` | — | Unchanged. |

- Agent-facing durations in **seconds** ("5 seconds" → `duration_seconds: 5`);
  internal ms.
- Tool results state when the override reverts (`reverts_at`) so the agent knows.

Resources:
- Extend `pulsar://status` with `overrides` (per active LED: `state`,
  `expiresAt`) and both `effective` and `rule` LED states.
- Optional dedicated `pulsar://overrides`.

## Snapshot / observability

Add `overrides` and `effectiveLeds` to the `Snapshot`. Then:
- The tray and dashboard can show e.g. "RED overridden (on) · 3s left".
- The MCP `status` resource carries it for free (one source of truth).

## Decisions (recommendations — confirm before Phase B)

1. **`set_led` with no `duration_seconds`** → *indefinite until `clear_led`*
   (predictable), **not** "until next poll." **Rec: indefinite, plus the cap below.**
2. **Max duration cap** so an agent can't mask real status forever.
   **Rec: clamp/῾reject above ~300s, with a clear tool message.**
3. **v1 command scope** — **Rec: ship `set_led(duration)` + `clear_led` and
   `blink_led` together in Phase B (blink reuses the scheduler).**

## Phases

- **A — Override engine + effective-state refactor.** Add `LedScheduler`; route
  all LED writes through `applyEffective()`; keep current MCP behavior wired to
  it. *Verify:* rule polling unchanged; a programmatic timed override applies and
  auto-reverts; survives a reconnect.
- **B — Expressive MCP tools.** `set_led(duration)`, `blink_led`, `clear_led`;
  add `overrides`/`effectiveLeds` to the snapshot and `status` resource. *Verify*
  with the MCP SDK client (set with duration → observe revert).
- **C — Surface overrides** in tray + dashboard (with countdown).
- **D — Polish.** Duration cap; conflict handling (a new override supersedes and
  cancels the prior timer); unit tests for the pure `computeEffective`.

## Non-goals / notes

- **No firmware changes** — host-side scheduling, as specified. Host→serial blink
  jitter is ~ms, fine for human-visible patterns (≥~100ms). Sub-50ms precision
  would need firmware-side patterns, which we are explicitly not doing.
- **Overrides are in-memory** (not persisted across app restart). On restart the
  board reflects rule-driven state.
- On shutdown, the existing `allOff` + clean close still applies; clear overrides
  first so the scheduler timer is cancelled.

## Touch list (anticipated)

- New: `mac/src/led-scheduler.ts` (+ pure `computeEffective`).
- `core.ts`: hold the scheduler; `tick()` sets rule state instead of writing
  LEDs; `setLed`/`blink` delegate to the scheduler; expose `clearOverride`.
- `mcp/server.ts`: new/updated tools; `status` resource gains overrides.
- `core.ts` `Snapshot`: add `overrides` + `effectiveLeds`.
- (Phase C) `tray.ts`, `renderer/` for display.
