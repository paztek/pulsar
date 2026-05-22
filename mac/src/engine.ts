import { EventKind, LedId, PrEntry } from './types';

export interface Predicate {
  events?: Set<EventKind>;
  repos?: Set<string>;
  repoPattern?: RegExp;
  authors?: Set<string>;
  titleIncludes?: string[];
  titlePattern?: RegExp;
}

export interface CompiledRule {
  name: string;
  when: Predicate;
  leds: LedId[];
  notify: boolean;
}

export interface ResolvedConfig {
  rules: CompiledRule[];
  allClear: { leds: LedId[]; notify: boolean } | null;
  repos: string[];
}

export interface EngineDecision {
  ledsOn: Set<LedId>;
  notifications: PrEntry[];
}

export function evaluate(events: PrEntry[], config: ResolvedConfig): EngineDecision {
  const ledsOn = new Set<LedId>();
  const notifications: PrEntry[] = [];
  const notifiedUrls = new Set<string>();
  let anyMatched = false;

  for (const event of events) {
    let shouldNotify = false;
    for (const rule of config.rules) {
      if (!matches(event, rule.when)) continue;
      anyMatched = true;
      for (const led of rule.leds) ledsOn.add(led);
      if (rule.notify) shouldNotify = true;
    }
    if (shouldNotify && !notifiedUrls.has(event.url)) {
      notifiedUrls.add(event.url);
      notifications.push(event);
    }
  }

  if (!anyMatched && config.allClear) {
    for (const led of config.allClear.leds) ledsOn.add(led);
  }

  return { ledsOn, notifications };
}

function matches(event: PrEntry, p: Predicate): boolean {
  if (p.events && !p.events.has(event.kind)) return false;
  if (p.repos && !p.repos.has(event.repo.toLowerCase())) return false;
  if (p.repoPattern && !p.repoPattern.test(event.repo)) return false;
  if (p.authors && !p.authors.has(event.author.toLowerCase())) return false;
  if (p.titleIncludes) {
    const t = event.title.toLowerCase();
    if (!p.titleIncludes.some((s) => t.includes(s))) return false;
  }
  if (p.titlePattern && !p.titlePattern.test(event.title)) return false;
  return true;
}

const LED_NAMES: Record<string, LedId> = {
  red: LedId.RED,
  yellow: LedId.YELLOW,
  blue: LedId.BLUE,
  green: LedId.GREEN,
};

export function ledNameToId(name: string): LedId | undefined {
  return LED_NAMES[name.toLowerCase()];
}

export function titleFor(kind: EventKind): string {
  switch (kind) {
    case 'needs_review':  return '👀 Review requested';
    case 'new_comment':   return '💬 New comment';
    case 'build_failing': return '🔴 Build failing';
  }
}
