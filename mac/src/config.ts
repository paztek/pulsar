import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { CompiledRule, Predicate, ResolvedConfig, ledNameToId } from './engine';
import { EventKind, LedId } from './types';

dotenv.config();

export const config = {
  github: {
    token: process.env.GITHUB_TOKEN || '',
    username: process.env.GITHUB_USERNAME || '',
    poller: (process.env.GITHUB_POLLER || 'cli') as 'cli' | 'api',
  },
  serial: {
    port: process.env.SERIAL_PORT || '/dev/cu.usbmodem14101',
    baudRate: 9600,
  },
  poll: {
    intervalMs: parseInt(process.env.POLL_INTERVAL_MS || '60000'),
  },
  rulesPath: process.env.CONFIG_PATH || 'config.json',
};

const VALID_EVENTS: ReadonlySet<EventKind> = new Set(['build_failing', 'needs_review', 'new_comment']);

const DEFAULT_RULES: ResolvedConfig = {
  rules: [
    { name: 'Build failing',    when: { events: new Set(['build_failing']) }, leds: [LedId.RED],    notify: true },
    { name: 'Review requested', when: { events: new Set(['needs_review']) },  leds: [LedId.YELLOW], notify: true },
    { name: 'New comments',     when: { events: new Set(['new_comment']) },   leds: [LedId.BLUE],   notify: true },
  ],
  allClear: { leds: [LedId.GREEN], notify: false },
  repos: [],
};

export function loadRules(filePath: string = config.rulesPath): ResolvedConfig {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    console.log(`config.json not found at ${resolved}; using built-in defaults`);
    return DEFAULT_RULES;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (e) {
    throw new Error(`Invalid JSON in ${resolved}: ${(e as Error).message}`);
  }

  return validate(raw, resolved);
}

function validate(raw: unknown, source: string): ResolvedConfig {
  if (!isObject(raw)) {
    throw new Error(`${source}: top level must be an object`);
  }

  const knownTop = new Set(['rules', 'allClear', 'repos', '$schema']);
  for (const key of Object.keys(raw)) {
    if (!knownTop.has(key)) console.warn(`${source}: unknown top-level key "${key}" — ignoring`);
  }

  if (!Array.isArray(raw.rules)) {
    throw new Error(`${source}: "rules" must be an array`);
  }

  const rules: CompiledRule[] = raw.rules.map((rule, i) => compileRule(rule, i, source));

  let allClear: ResolvedConfig['allClear'] = null;
  if (raw.allClear !== undefined) {
    if (!isObject(raw.allClear)) throw new Error(`${source}: "allClear" must be an object`);
    const leds = parseLeds(raw.allClear.leds, `${source}: allClear.leds`);
    const notify = raw.allClear.notify === undefined ? false : asBool(raw.allClear.notify, `${source}: allClear.notify`);
    allClear = { leds, notify };
  }

  const repos = raw.repos === undefined ? [] : asStringArray(raw.repos, `${source}: repos`);
  for (const r of repos) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(r)) {
      throw new Error(`${source}: repos: "${r}" must be in "owner/repo" form`);
    }
  }

  return { rules, allClear, repos };
}

function compileRule(rule: unknown, index: number, source: string): CompiledRule {
  const label = `${source}: rules[${index}]`;
  if (!isObject(rule)) throw new Error(`${label} must be an object`);

  const name = rule.name === undefined ? `rule ${index}` : asString(rule.name, `${label}.name`);
  const leds = parseLeds(rule.leds, `${label}.leds`);
  const notify = rule.notify === undefined ? true : asBool(rule.notify, `${label}.notify`);
  const when = parseWhen(rule.when, `${label}.when`);

  return { name, when, leds, notify };
}

function parseWhen(raw: unknown, label: string): Predicate {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new Error(`${label} must be an object`);

  const knownWhen = new Set(['event', 'repo', 'repoPattern', 'author', 'titleIncludes', 'titlePattern']);
  for (const key of Object.keys(raw)) {
    if (!knownWhen.has(key)) console.warn(`${label}: unknown predicate "${key}" — ignoring`);
  }

  if (raw.repo !== undefined && raw.repoPattern !== undefined) {
    throw new Error(`${label}: "repo" and "repoPattern" are mutually exclusive`);
  }
  if (raw.titleIncludes !== undefined && raw.titlePattern !== undefined) {
    throw new Error(`${label}: "titleIncludes" and "titlePattern" are mutually exclusive`);
  }

  const p: Predicate = {};

  if (raw.event !== undefined) {
    const events = asStringArray(raw.event, `${label}.event`).map((s) => s.toLowerCase());
    for (const ev of events) {
      if (!VALID_EVENTS.has(ev as EventKind)) {
        throw new Error(`${label}.event: "${ev}" is not a valid event (allowed: ${[...VALID_EVENTS].join(', ')})`);
      }
    }
    p.events = new Set(events as EventKind[]);
  }

  if (raw.repo !== undefined) {
    p.repos = new Set(asStringArray(raw.repo, `${label}.repo`).map((s) => s.toLowerCase()));
  }

  if (raw.repoPattern !== undefined) {
    p.repoPattern = compileRegex(asString(raw.repoPattern, `${label}.repoPattern`), `${label}.repoPattern`);
  }

  if (raw.author !== undefined) {
    p.authors = new Set(asStringArray(raw.author, `${label}.author`).map((s) => s.toLowerCase()));
  }

  if (raw.titleIncludes !== undefined) {
    p.titleIncludes = asStringArray(raw.titleIncludes, `${label}.titleIncludes`).map((s) => s.toLowerCase());
  }

  if (raw.titlePattern !== undefined) {
    p.titlePattern = compileRegex(asString(raw.titlePattern, `${label}.titlePattern`), `${label}.titlePattern`);
  }

  return p;
}

function parseLeds(raw: unknown, label: string): LedId[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return raw.map((entry, i) => {
    const name = asString(entry, `${label}[${i}]`);
    const id = ledNameToId(name);
    if (id === undefined) {
      throw new Error(`${label}[${i}]: "${name}" is not a valid LED (allowed: red, yellow, blue, green)`);
    }
    return id;
  });
}

function compileRegex(pattern: string, label: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (e) {
    throw new Error(`${label}: invalid regex "${pattern}": ${(e as Error).message}`);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown, label: string): string {
  if (typeof v !== 'string') throw new Error(`${label} must be a string`);
  return v;
}

function asBool(v: unknown, label: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`${label} must be a boolean`);
  return v;
}

function asStringArray(v: unknown, label: string): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  throw new Error(`${label} must be a string or string[]`);
}
