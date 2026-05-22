import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { ResolvedConfig, Rule, ledNameToId } from './engine';
import { log } from './log';
import { LedId } from './types';

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

function defaultRules(): ResolvedConfig {
  const epoch = new Date(0);
  return {
    rules: [
      { name: '🔴 Build failing',      query: 'is:pr is:open draft:false author:{{username}} status:failure {{repos}}', leds: [LedId.RED],    notify: true, lastChecked: epoch },
      { name: '👀 Review requested',   query: 'is:pr is:open draft:false review-requested:{{username}} {{repos}}',      leds: [LedId.YELLOW], notify: true, lastChecked: epoch },
      { name: '💬 Activity on my PRs', query: 'is:pr is:open draft:false author:{{username}} updated:>{{lastChecked}} {{repos}}', leds: [LedId.BLUE], notify: true, lastChecked: epoch },
    ],
    allClear: { leds: [LedId.GREEN], notify: false },
    repos: [],
  };
}

export function loadRules(filePath: string = config.rulesPath): ResolvedConfig {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    log(`config.json not found at ${resolved}; using built-in defaults`);
    return defaultRules();
  }
  log(`loading rules from ${resolved}`);

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

  const epoch = new Date(0);
  const rules: Rule[] = raw.rules.map((rule, i) => compileRule(rule, i, source, epoch));

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

function compileRule(rule: unknown, index: number, source: string, epoch: Date): Rule {
  const label = `${source}: rules[${index}]`;
  if (!isObject(rule)) throw new Error(`${label} must be an object`);

  const knownKeys = new Set(['name', 'query', 'leds', 'notify']);
  for (const key of Object.keys(rule)) {
    if (!knownKeys.has(key)) console.warn(`${label}: unknown key "${key}" — ignoring`);
  }

  const name = asString(rule.name, `${label}.name`);
  if (name.trim() === '') throw new Error(`${label}.name must be a non-empty string`);
  const query = asString(rule.query, `${label}.query`);
  if (query.trim() === '') throw new Error(`${label}.query must be a non-empty string`);
  const leds = parseLeds(rule.leds, `${label}.leds`);
  const notify = rule.notify === undefined ? true : asBool(rule.notify, `${label}.notify`);

  return { name, query, leds, notify, lastChecked: epoch };
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
