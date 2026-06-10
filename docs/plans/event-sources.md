# Plan: Generic event sources

Status: **implemented** (phases A–E) · Created 2026-06-10 · Target: `mac/`

Treat the GitHub poller and the MCP server as two instances of a generic
**event source**, so future sources (Confluence "page needs your attention",
PagerDuty, Linear, calendar, …) can be added behind one interface without
touching the LED/notification core.

## Core concept: a source produces *signals*

A **Signal** is one "thing that needs attention":

```ts
interface Signal {
  id: string;          // stable per underlying thing (e.g. PR url, or a uuid)
  source: string;      // 'github' | 'mcp' | 'confluence' | ...
  title: string;
  url?: string;
  leds: LedId[];       // which LEDs this signal lights
  notify: boolean;
  expiresAt?: number;  // optional TTL (push sources / timed signals)
}
```

Each source maintains its **current active signal set**. The Core aggregates
across all sources and derives the board state:

```
desiredLeds[led] = some active signal includes led
                 : (no signals at all) → allClear.leds
notifications     = signals newly appeared (by id) with notify = true
```

`desiredLeds` then flows to the single LED writer (`Core.recompute`).

## The interface (pull + push)

Two source kinds, because GitHub *polls* and MCP *pushes*:

```ts
interface EventSource {
  name: string;
  kind: 'pull' | 'push';
}

interface PullSource extends EventSource {
  kind: 'pull';
  // Evaluate this source's rules → its current signals. null = backed off
  // (rate-limited); keep the previous set for this round.
  poll(rules: Rule[], ctx: PollContext): Promise<Signal[] | null>;
}

interface PushSource extends EventSource {
  kind: 'push';
  start(onChange: () => void): void; // source mutates its set, calls onChange
  currentSignals(): Signal[];
  stop(): void;
}
```

- **Pull sources** are polled by the existing timer loop; the Core gathers the
  rules whose `source` matches and calls `poll()`.
- **Push sources** run continuously, own their signal set (with TTL expiry), and
  call `onChange()` whenever it changes → the Core re-aggregates.

The Core holds a **source registry** (`Map<string, EventSource>`) built from
config + runtime (e.g. the MCP push source exists only while MCP is enabled).

## GitHub becomes a `PullSource`

The current GitHub-specific loop moves behind `GithubSource implements
PullSource`:
- `poll(rules, ctx)` runs each rule's query (today's `expandQuery` + jitter +
  `GithubClient`), returns one `Signal` per matched item with the rule's `leds`.
- GitHub-specific bits (`{{username}}`/`{{repos}}`/`{{lastChecked}}` expansion,
  per-rule sliding window, rate-limit backoff) stay **inside** `GithubSource` —
  the generic interface stays clean.
- `engine.ts`'s `evaluate()` is largely replaced by Core-level aggregation;
  `expandQuery` moves into the GitHub source.

## MCP becomes a `PushSource` (new capability)

An agent injects **semantic events** via new MCP tools:

| Tool | Args | Behavior |
|------|------|----------|
| `raise_signal` | `leds`, `title`, `url?`, `notify?`, `ttl_seconds?` | Add a signal (optionally auto-expiring). Returns `{ id }`. |
| `clear_signal` | `id` | Remove a signal. |
| `list_signals` | — | The MCP source's current signals. |

Example: an agent watching Confluence calls
`raise_signal({ leds:['blue'], title:'Page X needs review', url, ttl_seconds: 3600 })`
→ blue lights until cleared or the hour elapses, composing with GitHub signals.

Timed control ("light X for N seconds") is just `raise_signal` with
`ttl_seconds`. The separate raw `set_led` tool remains a force/override that
masks status — use `raise_signal` for semantic status.

## Config / rule generalization + migration

Today a rule is `{ name, query, leds, notify }` (GitHub-implicit). Generalize:

```jsonc
{
  "name": "👀 Review requested",
  "source": "github",            // NEW; defaults to "github" if omitted
  "leds": ["yellow"],
  "notify": true,
  "params": { "query": "is:pr ... review-requested:{{username}} {{repos}}" }
}
```

- **Backward compatible:** a rule with no `source` and a top-level `query` is
  read as `source: "github", params: { query }`. The settings-store migration
  rewrites existing rules into the new shape.
- Each source documents its own `params` schema and validates them
  (`resolveRules` delegates per-source validation).
- Push sources (MCP) generally need no rules — the agent supplies `leds` in
  `raise_signal`. (Optional later: named "channels" that map to LEDs via config.)

## Adding a new source later (the payoff)

To add Confluence-as-poll: implement `ConfluenceSource implements PullSource`,
register it, and let users add rules with `"source": "confluence"` and
Confluence-specific `params`. No changes to the LED writer, aggregation,
notifications, tray, or MCP. That's the whole point of the abstraction.

## Phases

- **A — Single writer + aggregation core.** Introduce the Core-level aggregation
  (`Signal[]` → `desiredLeds`/notifications) and the single LED writer, with
  GitHub still the only source but routed through it. *Verify:* behavior
  identical to today.
- **B — `GithubSource` extraction.** Move the GitHub loop + `expandQuery` +
  per-rule window behind `PullSource`; add the `source`/`params` rule shape and
  migration. *Verify:* same polling/LED/notify behavior; old config migrates.
- **C — Source registry + push model.** Generalize the loop to a registry; add
  the `PushSource` contract and the `onChange` re-aggregation path.
- **D — MCP push source.** `raise_signal`/`clear_signal`/`list_signals`, TTL
  expiry, signals in `pulsar://status`. *Verify* with the MCP client.
- **E — Observability + docs.** Show per-source signals in the tray/dashboard;
  document how to add a source.

## Non-goals / decisions to confirm

- **Severity/priority mapping** (signal → LED via a category table instead of the
  rule carrying `leds`) — richer, but **Rec: keep `leds` on the rule/signal for
  v1**; revisit if multiple sources want shared semantics.
- **Inbound webhooks / network listeners** as sources — out of scope now; the
  `PushSource` contract leaves room.
- Signals are **in-memory** (not persisted across restart).
- Open question: do push signals **notify** on arrival by default? **Rec: yes if
  `notify` set in the call, default false.**
