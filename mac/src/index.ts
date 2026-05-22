import { ArduinoController } from './serial';
import { GithubAPIClient, GithubCLIClient } from './github';
import { notify } from './notifications';
import { log } from './log';
import { GithubClient, LedId } from './types';
import { config, loadRules } from './config';
import { evaluate, expandQuery, ResolvedConfig, RuleHit } from './engine';

const ALL_LEDS: LedId[] = [LedId.RED, LedId.YELLOW, LedId.BLUE, LedId.GREEN];

const JITTER_MIN_MS = 200;
const JITTER_MAX_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function nextJitter(): number {
  return JITTER_MIN_MS + Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS);
}

async function tick(arduino: ArduinoController, github: GithubClient, rules: ResolvedConfig) {
  log('--- tick ---');
  const hits: RuleHit[] = [];
  for (let i = 0; i < rules.rules.length; i++) {
    const rule = rules.rules[i];
    const query = expandQuery(rule.query, {
      username: config.github.username,
      lastChecked: rule.lastChecked,
      repos: rules.repos,
      now: new Date(),
    });

    let items;
    try {
      items = await github.search(query);
    } catch (e) {
      log(`rule "${rule.name}" failed: ${(e as Error).message} — skipping tick`);
      return;
    }
    if (items === null) {
      // Client is backed off; abandon the rest of the tick to avoid stale partial state.
      return;
    }
    rule.lastChecked = new Date();
    hits.push({ rule, items });
    log(`  ${rule.name}: ${items.length} match(es)`);
    for (const it of items) {
      log(`    @${it.author} ${it.repo} "${it.title}" ${it.url}`);
    }
    if (i < rules.rules.length - 1) await sleep(nextJitter());
  }

  const { ledsOn, notifications } = evaluate(hits, rules);
  log(`engine: LEDs on = [${[...ledsOn].map((id) => LedId[id]).join(', ') || 'none'}]; notifications = ${notifications.length}`);

  await Promise.all(ALL_LEDS.map((id) => arduino.setLed(id, ledsOn.has(id))));

  for (const n of notifications) {
    notify(n.title, n.message, n.url);
  }
}

async function main() {
  if (!config.github.username) {
    console.error('Missing GITHUB_USERNAME in .env');
    process.exit(1);
  }
  if (config.github.poller === 'api' && !config.github.token) {
    console.error('GITHUB_POLLER=api requires GITHUB_TOKEN in .env');
    process.exit(1);
  }

  const rules = loadRules();
  log(`loaded ${rules.rules.length} rule(s); repos scope: ${rules.repos.length === 0 ? '(all)' : rules.repos.join(', ')}`);

  const arduino = new ArduinoController();
  const github: GithubClient = config.github.poller === 'api'
    ? new GithubAPIClient()
    : new GithubCLIClient();
  log(`client: ${config.github.poller}; user: ${config.github.username}; interval: ${config.poll.intervalMs}ms`);

  await arduino.connect();
  log(`Pulsar connected on ${config.serial.port}`);

  await tick(arduino, github, rules);
  const interval = setInterval(() => tick(arduino, github, rules), config.poll.intervalMs);

  process.on('SIGINT', async () => {
    log('SIGINT — shutting down');
    clearInterval(interval);
    await arduino.allOff();
    await arduino.close();
    process.exit(0);
  });
}

main().catch(console.error);
