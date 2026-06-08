import { SerialPort } from 'serialport';
import { config } from './config';
import { log } from './log';
import { LedId } from './types';

const RECONNECT_DELAY_MS = 3000;
// macOS doesn't reliably emit close/error on unplug, so we poll the port list.
const WATCHDOG_INTERVAL_MS = 1000;
// The Arduino resets when the serial port is opened; wait for its bootloader.
const BOOT_DELAY_MS = 2000;
// Connection-confirmation blink: all LEDs on/off, twice.
const CONFIRM_PHASES = [true, false, true, false];
const CONFIRM_PHASE_MS = 500;

const ALL_LEDS: LedId[] = [LedId.RED, LedId.YELLOW, LedId.BLUE, LedId.GREEN];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Normalize a macOS serial device path for comparison. Each USB serial device
 * exposes two nodes — /dev/cu.usbmodemXXXX (callout) and /dev/tty.usbmodemXXXX
 * (dial-in) — and SerialPort.list() reports the tty form while we open the cu
 * form. Stripping the prefix lets the two compare equal.
 */
function portKey(path: string): string {
  return path.replace(/^\/dev\/(?:cu|tty)\./, '').toLowerCase();
}

/**
 * Resilient serial link to the Arduino.
 *
 * - Connects even if the Arduino is plugged in *after* the daemon starts.
 * - Reconnects on its own when the device is unplugged and plugged back in.
 * - Tracks *desired* LED state (independent of the wire) and re-applies it on
 *   every (re)connect, since opening the port resets the Arduino to all-off.
 *
 * Heavily logged (prefix `serial:`) to diagnose connect/reconnect behaviour.
 * setLed/allOff never reject: when the link is down they just update desired
 * state, so a tick is never aborted by a missing or flapping cable.
 */
export type SerialStatus = 'connecting' | 'connected' | 'disconnected';

export class ArduinoController {
  private port: SerialPort | null = null;
  private desired: boolean[] = [false, false, false, false];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private connecting = false;
  private shuttingDown = false;
  private status: SerialStatus = 'disconnected';
  private statusCb: ((s: SerialStatus) => void) | null = null;

  /** Subscribe to connectivity changes. Single listener (the Core). */
  onStatus(cb: (s: SerialStatus) => void): void {
    this.statusCb = cb;
  }

  private setStatus(s: SerialStatus): void {
    if (this.status === s) return;
    this.status = s;
    log(`serial: status → ${s}`);
    this.statusCb?.(s);
  }

  /** One-line snapshot of internal state for every log line. */
  private state(): string {
    return `[port=${this.port ? 'set' : 'null'} open=${this.port?.isOpen ?? false} connecting=${this.connecting} reconnectPending=${this.reconnectTimer !== null} shuttingDown=${this.shuttingDown}]`;
  }

  /** Dump the OS serial-port list and whether our target path is present. */
  private async logPorts(context: string): Promise<void> {
    try {
      const ports = await SerialPort.list();
      const target = config.serial.port;
      const present = ports.some((p) => portKey(p.path) === portKey(target));
      const list = ports.map((p) => p.path).join(', ') || 'none';
      log(`serial: [${context}] target=${target} present=${present}; available=[${list}]`);
    } catch (e) {
      log(`serial: [${context}] SerialPort.list() threw: ${(e as Error).message}`);
    }
  }

  /** Begin connecting. Returns once the first attempt settles; retries run in the background. */
  async connect(): Promise<void> {
    this.shuttingDown = false;
    log(`serial: connect() called ${this.state()}`);
    await this.logPorts('connect');
    await this.tryOpen();
  }

  setLed(id: LedId, on: boolean): Promise<void> {
    if (this.desired[id] === on) {
      log(`serial: setLed ${LedId[id]} ${on ? 'ON' : 'OFF'} — no change`);
      return Promise.resolve();
    }
    this.desired[id] = on;
    log(`LED ${LedId[id]} → ${on ? 'ON' : 'OFF'}`);
    return this.write(id, on);
  }

  async allOff(): Promise<void> {
    log(`serial: allOff() ${this.state()}`);
    for (const id of ALL_LEDS) await this.setLed(id, false);
  }

  async close(): Promise<void> {
    log(`serial: close() called ${this.state()}`);
    this.shuttingDown = true;
    this.setStatus('disconnected');
    this.stopWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      log('serial: cleared pending reconnect timer');
    }
    const port = this.port;
    this.port = null;
    if (port && port.isOpen) {
      log('serial: closing open port');
      await new Promise<void>((resolve) => port.close(() => {
        log('serial: port closed');
        resolve();
      }));
    } else {
      log('serial: no open port to close');
    }
  }

  private async tryOpen(): Promise<void> {
    log(`serial: tryOpen() entry ${this.state()}`);
    if (this.shuttingDown) { log('serial: tryOpen() abort — shutting down'); return; }
    if (this.connecting) { log('serial: tryOpen() abort — already connecting'); return; }
    if (this.port?.isOpen) { log('serial: tryOpen() abort — port already open'); return; }

    this.connecting = true;
    this.setStatus('connecting');
    log(`serial: opening ${config.serial.port} @ ${config.serial.baudRate} baud`);

    const port = new SerialPort({
      path: config.serial.port,
      baudRate: config.serial.baudRate,
      autoOpen: false,
    });

    try {
      await new Promise<void>((resolve, reject) => {
        port.open((err) => (err ? reject(err) : resolve()));
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      this.connecting = false;
      this.setStatus('disconnected');
      log(`serial: open FAILED for ${config.serial.port}: ${err.message}${err.code ? ` (code=${err.code})` : ''}`);
      await this.logPorts('open-failed');
      this.scheduleReconnect();
      return;
    }

    log(`serial: open OK — waiting ${BOOT_DELAY_MS}ms for board to boot`);
    await sleep(BOOT_DELAY_MS);

    if (this.shuttingDown) {
      this.connecting = false;
      log('serial: shutting down during boot wait — closing port');
      port.close(() => {});
      return;
    }

    // These listeners stay attached for the port's lifetime. Removing the
    // 'error' listener would let a later stream 'error' go unhandled and crash
    // the process, so instead we guard each handler with `this.port === port`
    // to ignore events from a stale port we've already replaced.
    port.on('open', () => log('serial: event "open"'));
    port.on('close', (err?: Error) => {
      log(`serial: event "close"${err ? ` (${err.message})` : ''} ${this.state()}`);
      if (this.port === port) this.onDrop('port closed');
      else log('serial: (close on stale port — ignored)');
    });
    port.on('error', (err: Error) => {
      log(`serial: event "error" — ${err.message}`);
      if (this.port === port) this.onDrop(`error — ${err.message}`);
      else log('serial: (error on stale port — ignored)');
    });
    log('serial: attached open/close/error listeners');

    this.port = port;
    this.connecting = false;
    this.setStatus('connected');
    log(`serial: CONNECTED on ${config.serial.port} ${this.state()}`);

    // macOS won't emit close/error on unplug — poll the port list instead.
    this.startWatchdog();

    // Confirmation blink so you can see the link came up.
    await this.confirmBlink();

    // Re-apply desired state to the freshly reset board.
    log(`serial: resyncing desired state [${this.desired.map((b) => (b ? 1 : 0)).join('')}]`);
    for (const id of ALL_LEDS) await this.write(id, this.desired[id]);
    log('serial: resync complete');
  }

  /** Flash all LEDs on/off twice (raw writes, independent of desired state). */
  private async confirmBlink(): Promise<void> {
    log('serial: confirmation blink start');
    for (const on of CONFIRM_PHASES) {
      if (this.port?.isOpen !== true || this.shuttingDown) {
        log(`serial: confirmBlink aborted ${this.state()}`);
        return;
      }
      await Promise.all(ALL_LEDS.map((id) => this.write(id, on)));
      await sleep(CONFIRM_PHASE_MS);
    }
    log('serial: confirmation blink done');
  }

  private onDrop(reason: string): void {
    log(`serial: onDrop("${reason}") ${this.state()}`);
    if (this.port === null && !this.connecting) {
      log('serial: onDrop ignored — already disconnected/handling');
      return;
    }
    log(`serial: link DOWN (${reason}) — tearing down port`);
    this.setStatus('disconnected');
    this.stopWatchdog();
    const dead = this.port;
    this.port = null;
    if (dead) {
      // Keep listeners attached (the guarded 'error' handler must survive, or a
      // late stream error would be unhandled and crash the process).
      try {
        if (dead.isOpen) dead.close(() => {});
      } catch (e) {
        log(`serial: error closing dead port: ${(e as Error).message}`);
      }
    }
    void this.logPorts('drop');
    this.scheduleReconnect();
  }

  /** Poll the OS port list while connected; macOS won't fire close/error on unplug. */
  private startWatchdog(): void {
    this.stopWatchdog();
    log(`serial: watchdog started (every ${WATCHDOG_INTERVAL_MS}ms)`);
    this.watchdogTimer = setInterval(() => void this.checkPresence(), WATCHDOG_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
      log('serial: watchdog stopped');
    }
  }

  private async checkPresence(): Promise<void> {
    const port = this.port;
    if (!port) return;
    if (!port.isOpen) {
      log('serial: watchdog — port handle no longer open; treating as disconnect');
      this.onDrop('port not open (watchdog)');
      return;
    }
    let present: boolean;
    try {
      const ports = await SerialPort.list();
      present = ports.some((p) => portKey(p.path) === portKey(config.serial.port));
    } catch (e) {
      log(`serial: watchdog SerialPort.list() threw: ${(e as Error).message}`);
      return;
    }
    if (!present && this.port === port) {
      log(`serial: watchdog — ${config.serial.port} vanished from port list while open; treating as disconnect`);
      this.onDrop('device removed (watchdog)');
    }
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown) { log('serial: scheduleReconnect skipped — shutting down'); return; }
    if (this.reconnectTimer) { log('serial: scheduleReconnect skipped — one already pending'); return; }
    log(`serial: reconnect scheduled in ${RECONNECT_DELAY_MS}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      log('serial: reconnect timer fired');
      void this.tryOpen();
    }, RECONNECT_DELAY_MS);
  }

  private write(id: LedId, on: boolean): Promise<void> {
    return new Promise((resolve) => {
      const port = this.port;
      if (!port || !port.isOpen) {
        log(`serial: write "SET ${id} ${on ? 1 : 0}" skipped — link down ${this.state()}`);
        resolve();
        return;
      }
      port.write(`SET ${id} ${on ? 1 : 0}\n`, (err) => {
        if (err) {
          log(`serial: write "SET ${id} ${on ? 1 : 0}" FAILED — ${err.message}`);
          if (this.port === port) this.onDrop('write failed');
        } else {
          log(`serial: write "SET ${id} ${on ? 1 : 0}" ok`);
        }
        resolve();
      });
    });
  }
}
