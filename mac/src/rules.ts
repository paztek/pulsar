import { ResolvedConfig, Rule, ledNameToId } from './engine';
import { LedId } from './types';

// Rule parsing/validation, shared by the standalone file loader (config.ts) and
// the Electron settings store (settings.ts). No Electron imports here.

const EPOCH = new Date(0);

/** The shipped default rules, in raw (config.json) shape — editable/persistable. */
export function defaultRawConfig(): { repos: string[]; rules: unknown[]; allClear: unknown } {
  return {
    repos: [],
    rules: [
      { name: '🔴 Build failing', query: 'is:pr is:open draft:false author:{{username}} status:failure {{repos}}', leds: ['red'] },
      { name: '👀 Review requested', query: 'is:pr is:open draft:false review-requested:{{username}} {{repos}}', leds: ['yellow'] },
      { name: '💬 Activity on my PRs', query: 'is:pr is:open draft:false author:{{username}} updated:>{{lastChecked}} {{repos}}', leds: ['blue'] },
    ],
    allClear: { leds: ['green'], notify: false },
  };
}

export function defaultResolved(): ResolvedConfig {
  return resolveRules(defaultRawConfig(), '(defaults)');
}

export function resolveRules(raw: unknown, source: string): ResolvedConfig {
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

  const rules: Rule[] = raw.rules.map((rule, i) => compileRule(rule, i, source));

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

function compileRule(rule: unknown, index: number, srcLabel: string): Rule {
  const label = `${srcLabel}: rules[${index}]`;
  if (!isObject(rule)) throw new Error(`${label} must be an object`);

  const knownKeys = new Set(['name', 'source', 'query', 'leds', 'notify', 'params']);
  for (const key of Object.keys(rule)) {
    if (!knownKeys.has(key)) console.warn(`${label}: unknown key "${key}" — ignoring`);
  }

  const name = asString(rule.name, `${label}.name`);
  if (name.trim() === '') throw new Error(`${label}.name must be a non-empty string`);
  const source = rule.source === undefined ? 'github' : asString(rule.source, `${label}.source`);
  const leds = parseLeds(rule.leds, `${label}.leds`);
  const notify = rule.notify === undefined ? true : asBool(rule.notify, `${label}.notify`);
  const params = compileParams(source, rule, label);

  return { name, source, leds, notify, params, lastChecked: EPOCH };
}

/** Validate/normalize a rule's source-specific params. */
function compileParams(source: string, rule: Record<string, unknown>, label: string): Record<string, unknown> {
  if (source === 'github') {
    // Back-compat: accept a top-level `query` (old shape) or `params.query` (new).
    const rawParams = isObject(rule.params) ? rule.params : {};
    const raw = rule.query !== undefined ? rule.query : rawParams.query;
    const query = asString(raw, `${label}.query`);
    if (query.trim() === '') throw new Error(`${label}: github query must be a non-empty string`);
    return { query };
  }
  // Unknown/other sources: pass params through; the source validates at use.
  return isObject(rule.params) ? { ...rule.params } : {};
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
