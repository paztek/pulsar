import { LedId, SearchItem } from './types';

export interface Rule {
  name: string;
  query: string;
  leds: LedId[];
  notify: boolean;
  lastChecked: Date;  // mutable: advances each time this rule's query succeeds
}

export interface ResolvedConfig {
  rules: Rule[];
  allClear: { leds: LedId[]; notify: boolean } | null;
  repos: string[];
}

export interface RuleHit {
  rule: Rule;
  items: SearchItem[];
}

export interface PreparedNotification {
  title: string;
  message: string;
  url: string;
}

export interface EngineDecision {
  ledsOn: Set<LedId>;
  notifications: PreparedNotification[];
}

export function evaluate(hits: RuleHit[], config: ResolvedConfig): EngineDecision {
  const ledsOn = new Set<LedId>();
  const notifications: PreparedNotification[] = [];
  const seenUrls = new Set<string>();
  let anyMatched = false;

  for (const { rule, items } of hits) {
    if (items.length === 0) continue;
    anyMatched = true;
    for (const led of rule.leds) ledsOn.add(led);
    if (!rule.notify) continue;
    for (const item of items) {
      if (seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);
      notifications.push({
        title: rule.name,
        message: `${item.repo}: ${item.title}`,
        url: item.url,
      });
    }
  }

  if (!anyMatched && config.allClear) {
    for (const led of config.allClear.leds) ledsOn.add(led);
  }

  return { ledsOn, notifications };
}

export interface ExpandContext {
  username: string;
  lastChecked: Date;
  repos: string[];
  now: Date;
}

export function expandQuery(template: string, ctx: ExpandContext): string {
  const reposExpansion = ctx.repos.map((r) => `repo:${r}`).join(' ');
  return template
    .replace(/\{\{username\}\}/g, ctx.username)
    .replace(/\{\{lastChecked\}\}/g, ctx.lastChecked.toISOString())
    .replace(/\{\{repos\}\}/g, reposExpansion)
    .replace(/\{\{now\}\}/g, ctx.now.toISOString())
    .replace(/\s+/g, ' ')
    .trim();
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
