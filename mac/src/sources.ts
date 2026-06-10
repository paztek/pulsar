import { LedId } from './types';
import { Rule } from './engine';

/** Context a pull source needs to expand its rules (currently GitHub-shaped). */
export interface PollContext {
  username: string;
  repos: string[];
}

/**
 * A pull source is evaluated on the poll timer: given the rules that target it,
 * it returns the currently-active signals (or null if it backed off, e.g. a rate
 * limit — the caller then keeps the previous state for this round).
 */
export interface PullSource {
  readonly name: string;
  readonly kind: 'pull';
  poll(rules: Rule[], ctx: PollContext): Promise<Signal[] | null>;
}

/**
 * A push source runs continuously and owns its current signal set (with its own
 * TTL/expiry). It calls onChange() whenever that set changes, prompting the Core
 * to re-aggregate.
 */
export interface PushSource {
  readonly name: string;
  readonly kind: 'push';
  start(onChange: () => void): void;
  currentSignals(): Signal[];
  stop(): void;
}

export type EventSource = PullSource | PushSource;

/**
 * A single "thing that needs attention," produced by an event source. The Core
 * aggregates active signals across sources into board state + notifications.
 */
export interface Signal {
  id: string; // dedup key (e.g. a PR url, or a uuid for push sources)
  source: string; // 'github' | 'mcp' | ...
  group: string; // grouping / notification title (e.g. the rule name)
  title: string;
  url?: string;
  context?: string; // e.g. "owner/repo"
  author?: string;
  leds: LedId[];
  notify: boolean;
  expiresAt?: number; // optional TTL (push sources / timed signals)
}

export interface Notification {
  title: string;
  message: string;
  url?: string;
}

/**
 * Fold active signals into LED state: a LED is on if any signal lights it; if
 * there are no signals at all, `allClear` lights instead. Idempotent — safe to
 * call on every recompute (notifications are handled separately, by the Core,
 * for newly-appeared signals only).
 */
export function aggregateLeds(signals: Signal[], allClear: { leds: LedId[] } | null): Set<LedId> {
  const ledsOn = new Set<LedId>();
  for (const s of signals) {
    for (const led of s.leds) ledsOn.add(led);
  }
  if (signals.length === 0 && allClear) {
    for (const led of allClear.leds) ledsOn.add(led);
  }
  return ledsOn;
}

export function notificationFor(s: Signal): Notification {
  return {
    title: s.group,
    message: s.context ? `${s.context}: ${s.title}` : s.title,
    url: s.url,
  };
}

/** A signal is active now if it has no TTL or the TTL is in the future. */
export function isActive(s: Signal, now: number): boolean {
  return s.expiresAt === undefined || s.expiresAt > now;
}
