import { GithubClient } from './types';
import { Rule, expandQuery } from './engine';
import { PullSource, PollContext, Signal } from './sources';
import { log } from './log';

const JITTER_MIN_MS = 200;
const JITTER_MAX_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function nextJitter(): number {
  return JITTER_MIN_MS + Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS);
}

/**
 * GitHub as a pull source. Owns the GitHub-specific bits — query placeholder
 * expansion, the per-rule sliding window (`lastChecked`), inter-rule jitter, and
 * rate-limit backoff — behind the generic PullSource interface.
 */
export class GithubSource implements PullSource {
  readonly name = 'github';
  readonly kind = 'pull' as const;

  constructor(private client: GithubClient) {}

  async poll(rules: Rule[], ctx: PollContext): Promise<Signal[] | null> {
    const mine = rules.filter((r) => r.source === 'github');
    const signals: Signal[] = [];

    for (let i = 0; i < mine.length; i++) {
      const rule = mine[i];
      const query = expandQuery(String(rule.params.query ?? ''), {
        username: ctx.username,
        lastChecked: rule.lastChecked,
        repos: ctx.repos,
        now: new Date(),
      });

      let items;
      try {
        items = await this.client.search(query);
      } catch (e) {
        log(`github: rule "${rule.name}" failed: ${(e as Error).message}`);
        throw e; // caller abandons the tick
      }
      if (items === null) return null; // backed off — keep current state this round

      rule.lastChecked = new Date();
      log(`  ${rule.name}: ${items.length} match(es)`);
      for (const it of items) {
        log(`    @${it.author} ${it.repo} "${it.title}" ${it.url}`);
        signals.push({
          id: it.url,
          source: 'github',
          group: rule.name,
          title: it.title,
          url: it.url,
          context: it.repo,
          author: it.author,
          leds: rule.leds,
          notify: rule.notify,
        });
      }

      if (i < mine.length - 1) await sleep(nextJitter());
    }

    return signals;
  }
}
