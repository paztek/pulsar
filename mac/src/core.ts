import { EventEmitter } from 'events';
import { ArduinoController, SerialStatus } from './serial';
import { GithubAPIClient, GithubCLIClient } from './github';
import { notify } from './notifications';
import { log } from './log';
import { GithubClient, LedId, SearchItem } from './types';
import { config, getActiveRules } from './config';
import { ledNameToId, ResolvedConfig } from './engine';
import { aggregateLeds, isActive, notificationFor, PullSource, PushSource, Signal } from './sources';
import { GithubSource } from './github-source';

const ALL_LEDS: LedId[] = [LedId.RED, LedId.YELLOW, LedId.BLUE, LedId.GREEN];

export type LedState = Record<'red' | 'yellow' | 'blue' | 'green', boolean>;

export interface RuleHitSummary {
  rule: string;
  items: SearchItem[];
}

/** A currently-active signal, flattened for the snapshot (LEDs as names). */
export interface SignalView {
  id: string;
  source: string;
  group: string;
  title: string;
  url?: string;
  leds: string[];
  notify: boolean;
  expiresAt?: number;
}

/** Everything tray / GUI / MCP need to render, in one object. */
export interface Snapshot {
  serial: SerialStatus;
  serialPort: string;
  leds: LedState;
  lastTickAt: string | null;
  ruleHits: RuleHitSummary[];
  signals: SignalView[];
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

  // Source registry + aggregation state.
  private pushSources: PushSource[] = [];
  private lastSignals: Map<string, Signal[]> = new Map(); // per pull-source, last good poll
  private notifiedIds: Set<string> = new Set(); // signal ids already notified for
  private recomputing = false;
  private recomputePending = false;

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
    for (const s of this.pushSources) s.stop();
    await this.arduino.allOff();
    await this.arduino.close();
  }

  /** Register a push source; its onChange triggers a coalesced re-aggregation. */
  addPushSource(src: PushSource): void {
    this.pushSources.push(src);
    src.start(() => this.requestRecompute());
    log(`core: push source "${src.name}" registered`);
    this.requestRecompute();
  }

  removePushSource(name: string): void {
    const idx = this.pushSources.findIndex((s) => s.name === name);
    if (idx === -1) return;
    const [src] = this.pushSources.splice(idx, 1);
    src.stop();
    log(`core: push source "${src.name}" removed`);
    this.requestRecompute();
  }

  /** Coalesced request to recompute effective state (e.g. from a push onChange). */
  requestRecompute(): void {
    void this.recompute();
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
      signals: this.collectSignals().map(signalView),
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

  /** Poll the pull sources, refresh their cached signals, then recompute. */
  private async tick(): Promise<void> {
    if (this.ticking) {
      log('core: tick already in progress — skipping');
      return;
    }
    this.ticking = true;
    try {
      log('--- tick ---');
      const ctx = { username: config.github.username, repos: this.rules.repos };
      for (const src of this.pullSources()) {
        let signals: Signal[] | null;
        try {
          signals = await src.poll(this.rules.rules, ctx);
        } catch (e) {
          log(`core: ${src.name} poll failed — ${(e as Error).message}; keeping last signals`);
          this.emit('error', e as Error);
          continue;
        }
        if (signals === null) {
          log(`core: ${src.name} backed off — keeping last signals`);
          continue;
        }
        this.lastSignals.set(src.name, signals);
      }
      await this.recompute();
    } finally {
      this.ticking = false;
    }
  }

  private pullSources(): PullSource[] {
    return [this.github];
  }

  /**
   * Single writer: union every source's active signals → effective LED state →
   * write changed LEDs, update the snapshot, emit, and fire notifications for
   * newly-appeared signals only. Coalesced so a poll tick and a push onChange
   * can't interleave.
   */
  private async recompute(): Promise<void> {
    if (this.recomputing) {
      this.recomputePending = true;
      return;
    }
    this.recomputing = true;
    try {
      do {
        this.recomputePending = false;
        const signals = this.collectSignals();
        const ledsOn = aggregateLeds(signals, this.rules.allClear);
        log(`engine: LEDs on = [${[...ledsOn].map((id) => LedId[id]).join(', ') || 'none'}]; signals = ${signals.length}`);

        await Promise.all(ALL_LEDS.map((id) => this.arduino.setLed(id, ledsOn.has(id))));

        this.leds = {
          red: ledsOn.has(LedId.RED),
          yellow: ledsOn.has(LedId.YELLOW),
          blue: ledsOn.has(LedId.BLUE),
          green: ledsOn.has(LedId.GREEN),
        };
        this.lastTickAt = new Date().toISOString();
        this.ruleHits = ruleHitsFromSignals(signals);
        this.emit('leds', { ...this.leds });
        this.emit('tick', this.getSnapshot());

        this.fireFreshNotifications(signals);
      } while (this.recomputePending);
    } finally {
      this.recomputing = false;
    }
  }

  /** Union of every source's currently-active signals. */
  private collectSignals(): Signal[] {
    const now = Date.now();
    const out: Signal[] = [];
    for (const sigs of this.lastSignals.values()) {
      for (const s of sigs) if (isActive(s, now)) out.push(s);
    }
    for (const src of this.pushSources) {
      for (const s of src.currentSignals()) if (isActive(s, now)) out.push(s);
    }
    return out;
  }

  /** Notify once per newly-appeared notify-signal (by id), not on every recompute. */
  private fireFreshNotifications(signals: Signal[]): void {
    const currentIds = new Set<string>();
    const justNotified = new Set<string>();
    for (const s of signals) {
      currentIds.add(s.id);
      if (s.notify && !this.notifiedIds.has(s.id) && !justNotified.has(s.id)) {
        justNotified.add(s.id);
        const n = notificationFor(s);
        notify(n.title, n.message, n.url);
      }
    }
    this.notifiedIds = currentIds;
  }
}

function makeClient(): GithubClient {
  return config.github.poller === 'api' ? new GithubAPIClient() : new GithubCLIClient();
}

function signalView(s: Signal): SignalView {
  return {
    id: s.id,
    source: s.source,
    group: s.group,
    title: s.title,
    url: s.url,
    leds: s.leds.map((l) => LedId[l].toLowerCase()),
    notify: s.notify,
    expiresAt: s.expiresAt,
  };
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
