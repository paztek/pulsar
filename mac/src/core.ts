import { EventEmitter } from 'events';
import { ArduinoController, SerialStatus } from './serial';
import { GithubAPIClient, GithubCLIClient } from './github';
import { notify } from './notifications';
import { log } from './log';
import { GithubClient, LedId, SearchItem } from './types';
import { config, getActiveRules } from './config';
import { ledNameToId, ResolvedConfig } from './engine';
import { aggregate, Notification, Signal } from './sources';
import { GithubSource } from './github-source';

const ALL_LEDS: LedId[] = [LedId.RED, LedId.YELLOW, LedId.BLUE, LedId.GREEN];

export type LedState = Record<'red' | 'yellow' | 'blue' | 'green', boolean>;

export interface RuleHitSummary {
  rule: string;
  items: SearchItem[];
}

/** Everything tray / GUI / MCP need to render, in one object. */
export interface Snapshot {
  serial: SerialStatus;
  serialPort: string;
  leds: LedState;
  lastTickAt: string | null;
  ruleHits: RuleHitSummary[];
  mcp: { enabled: boolean; url: string | null };
}

type CoreEvents = {
  'serial-status': (status: SerialStatus) => void;
  leds: (leds: LedState) => void;
  tick: (snapshot: Snapshot) => void;
  error: (err: Error) => void;
};

// Typed event surface over EventEmitter (interface merge).
export interface Core {
  on<E extends keyof CoreEvents>(event: E, listener: CoreEvents[E]): this;
  off<E extends keyof CoreEvents>(event: E, listener: CoreEvents[E]): this;
  emit<E extends keyof CoreEvents>(event: E, ...args: Parameters<CoreEvents[E]>): boolean;
}

/**
 * Owns the Arduino link, the GitHub client, and the rules, and runs the poll
 * loop. The single source of truth subscribed to by the tray, the renderer, and
 * the MCP server. Emits 'serial-status' | 'leds' | 'tick' | 'error'.
 */
export class Core extends EventEmitter {
  private arduino: ArduinoController;
  private github: GithubSource;
  private rules: ResolvedConfig;
  private interval: NodeJS.Timeout | null = null;
  private ticking = false;

  private serialStatus: SerialStatus = 'disconnected';
  private leds: LedState = { red: false, yellow: false, blue: false, green: false };
  private lastTickAt: string | null = null;
  private ruleHits: RuleHitSummary[] = [];
  private mcpInfo: { enabled: boolean; url: string | null } = { enabled: false, url: null };

  constructor() {
    super();
    // Guarantee an 'error' listener: Node treats a listener-less 'error' emit as
    // an unhandled exception and crashes the process. A failed poll must not.
    this.on('error', (err) => log(`core: error — ${err.message}`));
    this.rules = getActiveRules();
    this.arduino = new ArduinoController();
    this.arduino.onStatus((s) => {
      this.serialStatus = s;
      this.emit('serial-status', s);
    });
    this.github = new GithubSource(makeClient());
  }

  async start(): Promise<void> {
    log(`core: ${this.rules.rules.length} rule(s); repos scope: ${this.rules.repos.length === 0 ? '(all)' : this.rules.repos.join(', ')}`);
    log(`core: client ${config.github.poller}; user ${config.github.username}; interval ${config.poll.intervalMs}ms`);
    await this.arduino.connect();
    // The first poll must never abort startup (e.g. a transient GitHub/gh error).
    try {
      await this.tick();
    } catch (e) {
      log(`core: first tick failed — ${(e as Error).message}`);
    }
    this.interval = setInterval(() => void this.tick(), config.poll.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    await this.arduino.allOff();
    await this.arduino.close();
  }

  /** Force an immediate poll (used by tray "Poll now" and the MCP poll_now tool). */
  async pollNow(): Promise<void> {
    await this.tick();
  }

  /** Re-read the active rules (after a settings change) and poll immediately. */
  async reloadRules(): Promise<void> {
    this.rules = getActiveRules();
    log(`core: reloaded ${this.rules.rules.length} rule(s)`);
    await this.tick();
  }

  private setPollInterval(ms: number): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = setInterval(() => void this.tick(), ms);
      log(`core: poll interval → ${ms}ms`);
    }
  }

  private rebuildClient(): void {
    this.github = new GithubSource(makeClient());
    log(`core: github client → ${config.github.poller}`);
  }

  private async reconnectSerial(): Promise<void> {
    log('core: reconnecting serial (settings change)');
    await this.arduino.close();
    await this.arduino.connect();
  }

  /**
   * Apply settings already written to the runtime config (by the store) to the
   * running Core. Reconnects serial only when the port actually changed, to
   * avoid a disruptive blink on every save.
   */
  async applySettings(opts: { reconnectSerial: boolean }): Promise<void> {
    this.rebuildClient();
    this.setPollInterval(config.poll.intervalMs);
    this.rules = getActiveRules();
    if (opts.reconnectSerial) await this.reconnectSerial();
    await this.tick();
  }

  getSnapshot(): Snapshot {
    return {
      serial: this.serialStatus,
      serialPort: config.serial.port,
      leds: { ...this.leds },
      lastTickAt: this.lastTickAt,
      ruleHits: this.ruleHits.map((h) => ({ rule: h.rule, items: h.items })),
      mcp: { ...this.mcpInfo },
    };
  }

  /** Update reported MCP state and refresh subscribers (tray/window). */
  setMcpInfo(info: { enabled: boolean; url: string | null }): void {
    this.mcpInfo = info;
    this.emit('tick', this.getSnapshot());
  }

  /** Manually drive one LED (transient — the next tick re-asserts rule state). Used by MCP. */
  async setLed(name: keyof LedState, on: boolean): Promise<void> {
    const id = ledNameToId(name);
    if (id === undefined) return;
    await this.arduino.setLed(id, on);
  }

  /** Run the connection-confirmation blink. Used by the MCP blink tool. */
  async blink(): Promise<void> {
    await this.arduino.blink();
  }

  private async tick(): Promise<void> {
    if (this.ticking) {
      log('core: tick already in progress — skipping');
      return;
    }
    this.ticking = true;
    try {
      log('--- tick ---');
      let signals: Signal[] | null;
      try {
        signals = await this.github.poll(this.rules.rules, {
          username: config.github.username,
          repos: this.rules.repos,
        });
      } catch (e) {
        log(`core: poll failed — ${(e as Error).message}; skipping tick`);
        this.emit('error', e as Error);
        return;
      }
      if (signals === null) return; // a source backed off; keep current state
      await this.applyDecision(signals, ruleHitsFromSignals(signals));
    } finally {
      this.ticking = false;
    }
  }

  /**
   * The single LED writer: aggregate signals → board state + notifications, write
   * the changed LEDs, update the snapshot, and emit. Every path that changes the
   * board goes through here (poll loop now; push sources / overrides later).
   */
  private async applyDecision(signals: Signal[], ruleHits: RuleHitSummary[]): Promise<void> {
    const { ledsOn, notifications } = aggregate(signals, this.rules.allClear);
    log(`engine: LEDs on = [${[...ledsOn].map((id) => LedId[id]).join(', ') || 'none'}]; notifications = ${notifications.length}`);

    await Promise.all(ALL_LEDS.map((id) => this.arduino.setLed(id, ledsOn.has(id))));

    this.leds = {
      red: ledsOn.has(LedId.RED),
      yellow: ledsOn.has(LedId.YELLOW),
      blue: ledsOn.has(LedId.BLUE),
      green: ledsOn.has(LedId.GREEN),
    };
    this.lastTickAt = new Date().toISOString();
    this.ruleHits = ruleHits;
    this.emit('leds', { ...this.leds });
    this.emit('tick', this.getSnapshot());

    this.fireNotifications(notifications);
  }

  private fireNotifications(notifications: Notification[]): void {
    for (const n of notifications) notify(n.title, n.message, n.url);
  }
}

function makeClient(): GithubClient {
  return config.github.poller === 'api' ? new GithubAPIClient() : new GithubCLIClient();
}

/** Rebuild the snapshot's per-group hit summary from the active signals. */
function ruleHitsFromSignals(signals: Signal[]): RuleHitSummary[] {
  const byGroup = new Map<string, SearchItem[]>();
  for (const s of signals) {
    const items = byGroup.get(s.group) ?? [];
    items.push({ title: s.title, url: s.url ?? '', repo: s.context ?? '', author: s.author ?? '' });
    byGroup.set(s.group, items);
  }
  return [...byGroup.entries()].map(([rule, items]) => ({ rule, items }));
}
