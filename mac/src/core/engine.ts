import { LedId } from './types';

export interface Rule {
  name: string;
  source: string;                    // which event source handles it ('github' default)
  leds: LedId[];
  notify: boolean;
  params: Record<string, unknown>;   // source-specific (github: { query })
  lastChecked: Date;                 // github sliding-window runtime state
}

export interface ResolvedConfig {
  rules: Rule[];
  allClear: { leds: LedId[]; notify: boolean } | null;
  repos: string[];
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
