import { PushSource, Signal } from './sources';
import { LedId } from '../core/types';
import { log } from '../core/log';

/**
 * Dev-only push source (enabled with PULSAR_TEST_PUSH=1). Raises a BLUE signal a
 * few seconds after start, then clears it — to exercise the push/onChange
 * re-aggregation path before the real MCP push source lands (Phase D). Doubles
 * as a minimal example PushSource implementation.
 */
export class TestPushSource implements PushSource {
  readonly name = 'test';
  readonly kind = 'push' as const;

  private signals: Signal[] = [];
  private timers: NodeJS.Timeout[] = [];

  start(onChange: () => void): void {
    this.timers.push(
      setTimeout(() => {
        log('test-push: raising BLUE signal');
        this.signals = [
          { id: 'test-1', source: 'test', group: 'Test push', title: 'hello from push', leds: [LedId.BLUE], notify: true },
        ];
        onChange();
      }, 4000),
    );
    this.timers.push(
      setTimeout(() => {
        log('test-push: clearing signal');
        this.signals = [];
        onChange();
      }, 9000),
    );
  }

  currentSignals(): Signal[] {
    return this.signals;
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
