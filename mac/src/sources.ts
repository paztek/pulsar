import { LedId } from './types';

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

export interface Aggregated {
  ledsOn: Set<LedId>;
  notifications: Notification[];
}

/**
 * Fold active signals into board state: a LED is on if any signal lights it; if
 * there are no signals at all, `allClear` lights instead. Notify-signals produce
 * notifications, deduped by id (mirrors the previous evaluate() behavior).
 */
export function aggregate(signals: Signal[], allClear: { leds: LedId[] } | null): Aggregated {
  const ledsOn = new Set<LedId>();
  const notifications: Notification[] = [];
  const seen = new Set<string>();

  for (const s of signals) {
    for (const led of s.leds) ledsOn.add(led);
    if (!s.notify || seen.has(s.id)) continue;
    seen.add(s.id);
    notifications.push({
      title: s.group,
      message: s.context ? `${s.context}: ${s.title}` : s.title,
      url: s.url,
    });
  }

  if (signals.length === 0 && allClear) {
    for (const led of allClear.leds) ledsOn.add(led);
  }

  return { ledsOn, notifications };
}
