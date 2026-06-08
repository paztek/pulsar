import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { ResolvedConfig } from './engine';
import { log } from './log';
import { defaultResolved, resolveRules } from './rules';

dotenv.config();

/**
 * Runtime connection config that the rest of the app reads (github.ts, serial.ts,
 * core.ts). Defaults come from .env for the standalone path; under Electron the
 * settings store overrides these via applyConnectionSettings() before Core starts.
 */
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

export interface ConnectionSettings {
  githubToken: string;
  githubUsername: string;
  poller: 'cli' | 'api';
  serialPort: string;
  pollIntervalMs: number;
}

/** Override the runtime connection config (used by the Electron settings store). */
export function applyConnectionSettings(s: Partial<ConnectionSettings>): void {
  if (s.githubToken !== undefined) config.github.token = s.githubToken;
  if (s.githubUsername !== undefined) config.github.username = s.githubUsername;
  if (s.poller !== undefined) config.github.poller = s.poller;
  if (s.serialPort !== undefined) config.serial.port = s.serialPort;
  if (s.pollIntervalMs !== undefined) config.poll.intervalMs = s.pollIntervalMs;
}

let activeRules: ResolvedConfig | null = null;

/** Set the active rules (used by the settings store). Overrides file-based loadRules(). */
export function setActiveRules(r: ResolvedConfig): void {
  activeRules = r;
}

/** Active rules: the store's rules when set (Electron), else loaded from config.json. */
export function getActiveRules(): ResolvedConfig {
  return activeRules ?? loadRules();
}

/** Standalone path: read and validate rules from config.json (or built-in defaults). */
export function loadRules(filePath: string = config.rulesPath): ResolvedConfig {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    log(`config.json not found at ${resolved}; using built-in defaults`);
    return defaultResolved();
  }
  log(`loading rules from ${resolved}`);

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (e) {
    throw new Error(`Invalid JSON in ${resolved}: ${(e as Error).message}`);
  }

  return resolveRules(raw, resolved);
}
