import { ArduinoController } from './serial';
import { GithubAPIPoller, GithubCLIPoller } from './github';
import { notify } from './notifications';
import { LedId, Poller } from './types';
import { config, loadRules } from './config';
import { evaluate, titleFor, ResolvedConfig } from './engine';

const ALL_LEDS: LedId[] = [LedId.RED, LedId.YELLOW, LedId.BLUE, LedId.GREEN];

async function tick(arduino: ArduinoController, github: Poller, rules: ResolvedConfig) {
  const events = await github.poll();
  const { ledsOn, notifications } = evaluate(events, rules);

  await Promise.all(ALL_LEDS.map((id) => arduino.setLed(id, ledsOn.has(id))));

  for (const ev of notifications) {
    notify(titleFor(ev.kind), `${ev.repo}: ${ev.title}`, ev.url);
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

  const arduino = new ArduinoController();
  const github: Poller = config.github.poller === 'api'
    ? new GithubAPIPoller(rules.repos)
    : new GithubCLIPoller(rules.repos);

  await arduino.connect();
  console.log(`Pulsar connected on ${config.serial.port}`);

  await tick(arduino, github, rules);
  const interval = setInterval(() => tick(arduino, github, rules), config.poll.intervalMs);

  process.on('SIGINT', async () => {
    clearInterval(interval);
    await arduino.allOff();
    await arduino.close();
    process.exit(0);
  });
}

main().catch(console.error);
