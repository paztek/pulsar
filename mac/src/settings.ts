import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './log';
import { applyConnectionSettings, setActiveRules } from './config';
import { defaultRawConfig, resolveRules } from './rules';

// Electron-only settings store: a JSON file in userData, with the GitHub token
// encrypted via safeStorage (Keychain). On first run it migrates from the
// existing .env / config.json. Hand-rolled (no electron-store) to stay CommonJS
// and dependency-free; the needs here are small.

const VERSION = 1;
const DEFAULT_MCP_PORT = 7332;
const DEFAULT_SERIAL_PORT = '/dev/cu.usbmodem14101';

/** Raw rules in config.json shape; validated on load via resolveRules(). */
export interface RuleConfig {
  repos?: string[];
  rules: unknown[];
  allClear?: unknown;
}

export interface PulsarSettings {
  version: number;
  githubUsername: string;
  githubTokenEnc: string | null; // base64 of safeStorage-encrypted token
  poller: 'cli' | 'api';
  serialPort: string;
  pollIntervalMs: number;
  ruleConfig: RuleConfig;
  mcpEnabled: boolean;
  mcpPort: number;
  launchAtLogin: boolean;
}

/** Fields updatable from the GUI; githubToken is plaintext in, encrypted at rest. */
export type SettingsPatch = Partial<
  Omit<PulsarSettings, 'version' | 'githubTokenEnc'> & { githubToken: string }
>;

let current: PulsarSettings | null = null;

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function getSettings(): PulsarSettings {
  if (!current) throw new Error('settings not loaded — call loadAndApplySettings() first');
  return current;
}

export function getGithubToken(): string {
  const enc = current?.githubTokenEnc;
  if (!enc) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    }
    log('settings: safeStorage unavailable — cannot decrypt token');
  } catch (e) {
    log(`settings: token decrypt failed — ${(e as Error).message}`);
  }
  return '';
}

function encryptToken(token: string): string | null {
  if (!token) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    log('settings: safeStorage unavailable — token will not be persisted');
    return null;
  }
  return safeStorage.encryptString(token).toString('base64');
}

function readStore(): PulsarSettings | null {
  const p = settingsPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as PulsarSettings;
  } catch (e) {
    log(`settings: failed to read ${p} — ${(e as Error).message}; ignoring`);
    return null;
  }
}

function writeStore(s: PulsarSettings): void {
  const p = settingsPath();
  fs.writeFileSync(p, JSON.stringify(s, null, 2));
  log(`settings: wrote ${p}`);
}

function migrateFromFiles(): PulsarSettings {
  log('settings: no store found — migrating from .env / config.json');
  // dotenv was already loaded when config.ts was imported.
  let ruleConfig: RuleConfig;
  const cfgPath = path.resolve(process.cwd(), process.env.CONFIG_PATH || 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      ruleConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      log(`settings: migrated rules from ${cfgPath}`);
    } catch (e) {
      log(`settings: ${cfgPath} unreadable (${(e as Error).message}) — using defaults`);
      ruleConfig = defaultRawConfig();
    }
  } else {
    ruleConfig = defaultRawConfig();
  }

  return {
    version: VERSION,
    githubUsername: process.env.GITHUB_USERNAME || '',
    githubTokenEnc: encryptToken(process.env.GITHUB_TOKEN || ''),
    poller: (process.env.GITHUB_POLLER || 'cli') as 'cli' | 'api',
    serialPort: process.env.SERIAL_PORT || DEFAULT_SERIAL_PORT,
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '60000'),
    ruleConfig,
    mcpEnabled: false,
    mcpPort: DEFAULT_MCP_PORT,
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
  };
}

/** Push the current settings into the runtime config the rest of the app reads. */
function applyToConfig(s: PulsarSettings): void {
  applyConnectionSettings({
    githubToken: getGithubToken(),
    githubUsername: s.githubUsername,
    poller: s.poller,
    serialPort: s.serialPort,
    pollIntervalMs: s.pollIntervalMs,
  });
  setActiveRules(resolveRules(s.ruleConfig, settingsPath()));
}

/** Load the store (migrating on first run) and apply it to the runtime config. */
export function loadAndApplySettings(): PulsarSettings {
  let s = readStore();
  if (!s) {
    s = migrateFromFiles();
    writeStore(s);
  }
  current = s;
  applyToConfig(s);
  log(`settings: loaded (user=${s.githubUsername || 'unset'}, poller=${s.poller}, port=${s.serialPort}, interval=${s.pollIntervalMs}ms, mcp=${s.mcpEnabled})`);
  return s;
}

/** Persist a settings change, re-apply to runtime config, and return the new settings. */
export function updateSettings(patch: SettingsPatch): PulsarSettings {
  const prev = getSettings();
  const { githubToken, ...rest } = patch;
  const next: PulsarSettings = { ...prev, ...rest };
  if (githubToken !== undefined) {
    next.githubTokenEnc = encryptToken(githubToken);
  }
  current = next;
  writeStore(next);
  applyToConfig(next);
  return next;
}
