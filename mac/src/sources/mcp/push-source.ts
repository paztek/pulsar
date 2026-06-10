import { randomUUID } from 'crypto';
import { PushSource, Signal } from '../sources';
import { ledNameToId } from '../../core/engine';
import { LedId } from '../../core/types';
import { log } from '../../core/log';

export interface RaiseInput {
  leds: string[];
  title: string;
  url?: string;
  notify?: boolean;
  ttlSeconds?: number;
}

/**
 * MCP as a push source: an agent raises/clears semantic signals that light LEDs
 * and compose with the GitHub (and future) sources. Signals may carry a TTL; an
 * internal timer expires them and re-aggregates so the LED reverts on its own.
 */
export class McpPushSource implements PushSource {
  readonly name = 'mcp';
  readonly kind = 'push' as const;

  private signals = new Map<string, Signal>();
  private onChange: () => void = () => {};
  private expiryTimer: NodeJS.Timeout | null = null;

  start(onChange: () => void): void {
    this.onChange = onChange;
    this.scheduleExpiry();
  }

  currentSignals(): Signal[] {
    return [...this.signals.values()];
  }

  stop(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.signals.clear();
  }

  raise(input: RaiseInput): { id: string; expiresAt?: number } {
    const id = randomUUID();
    const leds = input.leds.map(ledNameToId).filter((x): x is LedId => x !== undefined);
    const expiresAt = input.ttlSeconds ? Date.now() + input.ttlSeconds * 1000 : undefined;
    this.signals.set(id, {
      id,
      source: 'mcp',
      group: input.title,
      title: input.title,
      url: input.url,
      leds,
      notify: input.notify ?? false,
      expiresAt,
    });
    log(`mcp-push: raised ${id} leds=[${input.leds.join(',')}] ttl=${input.ttlSeconds ?? '∞'}`);
    this.scheduleExpiry();
    this.onChange();
    return { id, expiresAt };
  }

  clear(id: string): boolean {
    const existed = this.signals.delete(id);
    if (existed) {
      log(`mcp-push: cleared ${id}`);
      this.scheduleExpiry();
      this.onChange();
    }
    return existed;
  }

  /**
   * Direct LED control as a stable per-LED override: `on` lights it (optionally
   * for `ttlSeconds`, after which the app reverts it); `off` clears the override.
   * Repeated calls for the same LED replace the previous one.
   */
  setLed(led: string, on: boolean, ttlSeconds?: number): { id: string; expiresAt?: number } | null {
    const id = `led:${led}`;
    if (!on) {
      if (this.signals.delete(id)) {
        log(`mcp-push: cleared ${led}`);
        this.scheduleExpiry();
        this.onChange();
      }
      return null;
    }
    const ledId = ledNameToId(led);
    if (ledId === undefined) return null;
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
    this.signals.set(id, {
      id,
      source: 'mcp',
      group: `${led} (manual)`,
      title: `${led} on`,
      leds: [ledId],
      notify: false,
      expiresAt,
    });
    log(`mcp-push: set ${led} on${ttlSeconds ? ` for ${ttlSeconds}s` : ''}`);
    this.scheduleExpiry();
    this.onChange();
    return { id, expiresAt };
  }

  list(): Signal[] {
    this.prune();
    return [...this.signals.values()];
  }

  private prune(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, s] of this.signals) {
      if (s.expiresAt !== undefined && s.expiresAt <= now) {
        this.signals.delete(id);
        changed = true;
      }
    }
    if (changed) this.onChange();
  }

  /** Arm a single timer for the earliest TTL so expired signals revert promptly. */
  private scheduleExpiry(): void {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    let next = Infinity;
    for (const s of this.signals.values()) {
      if (s.expiresAt !== undefined && s.expiresAt < next) next = s.expiresAt;
    }
    if (next === Infinity) return;
    const delay = Math.max(0, next - Date.now()) + 10;
    this.expiryTimer = setTimeout(() => {
      this.prune();
      this.scheduleExpiry();
    }, delay);
  }
}
