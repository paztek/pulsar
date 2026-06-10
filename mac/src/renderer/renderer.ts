// Browser-side script (no imports — must stay a plain script so it loads via
// <script>). Talks to the main process only through window.pulsar (preload).

interface SearchItem {
  title: string;
  url: string;
  repo: string;
  author: string;
}
interface SignalView {
  id: string;
  source: string;
  group: string;
  title: string;
  url?: string;
  context?: string;
  leds: string[];
  notify: boolean;
  expiresAt?: number;
}
interface Snapshot {
  serial: 'connecting' | 'connected' | 'disconnected';
  serialPort: string;
  leds: Record<'red' | 'yellow' | 'blue' | 'green', boolean>;
  lastTickAt: string | null;
  ruleHits: Array<{ rule: string; items: SearchItem[] }>;
  signals: SignalView[];
  mcp: { enabled: boolean; url: string | null };
}
interface SettingsView {
  githubUsername: string;
  hasToken: boolean;
  poller: 'cli' | 'api';
  serialPort: string;
  pollIntervalMs: number;
  ruleConfig: unknown;
  mcpEnabled: boolean;
  mcpPort: number;
  launchAtLogin: boolean;
}
interface PulsarApi {
  getSnapshot(): Promise<Snapshot>;
  getSettings(): Promise<SettingsView>;
  updateSettings(patch: Record<string, unknown>): Promise<SettingsView>;
  listSerialPorts(): Promise<string[]>;
  pollNow(): Promise<void>;
  onSnapshot(cb: (snapshot: Snapshot) => void): () => void;
}

const api = (window as unknown as { pulsar: PulsarApi }).pulsar;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const STATUS_LABEL: Record<Snapshot['serial'], string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Arduino not found',
};

function renderStatus(snap: Snapshot): void {
  document.body.dataset.status = snap.serial;
  $('conn-label').textContent =
    snap.serial === 'connected' ? `Connected — ${snap.serialPort}` : STATUS_LABEL[snap.serial];

  for (const name of ['red', 'yellow', 'blue', 'green'] as const) {
    const el = document.querySelector(`.led[data-led="${name}"]`) as HTMLElement | null;
    if (el) el.dataset.on = String(Boolean(snap.leds[name]));
  }

  $('last-poll').textContent = snap.lastTickAt
    ? new Date(snap.lastTickAt).toLocaleTimeString()
    : '—';

  renderSignals(snap.signals);
}

function remaining(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 'expiring';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s left` : `${Math.round(s / 60)}m left`;
}

function renderSignals(signals: SignalView[]): void {
  const list = $('matches');
  list.innerHTML = '';

  if (signals.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing needs attention';
    list.appendChild(li);
    return;
  }

  for (const s of signals) {
    const li = document.createElement('li');

    const head = document.createElement('div');
    head.className = 'sig-head';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = s.source;
    const rule = document.createElement('span');
    rule.className = 'rule';
    rule.textContent = s.group;
    head.append(badge, rule);
    if (s.expiresAt) {
      const ttl = document.createElement('span');
      ttl.className = 'ttl';
      ttl.textContent = remaining(s.expiresAt);
      head.append(ttl);
    }

    const dots = document.createElement('div');
    dots.className = 'sig-leds';
    for (const led of s.leds) {
      const d = document.createElement('span');
      d.className = `mini mini--${led}`;
      dots.append(d);
    }

    li.append(head, dots);

    const detailText = s.context ? `${s.context}: ${s.title}` : s.group !== s.title ? s.title : '';
    if (detailText) {
      const detail = document.createElement('div');
      detail.className = 'repo';
      detail.textContent = detailText;
      li.append(detail);
    }

    list.appendChild(li);
  }
}

async function populatePorts(current: string): Promise<void> {
  let ports: string[] = [];
  try {
    ports = await api.listSerialPorts();
  } catch {
    /* ignore */
  }
  if (current && !ports.includes(current)) ports.unshift(current);
  const select = $<HTMLSelectElement>('f-port');
  select.innerHTML = '';
  for (const p of ports) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    if (p === current) opt.selected = true;
    select.appendChild(opt);
  }
}

async function loadSettings(): Promise<void> {
  const s = await api.getSettings();
  $<HTMLInputElement>('f-username').value = s.githubUsername;
  $<HTMLInputElement>('f-token').placeholder = s.hasToken ? '•••• set (blank = keep)' : 'ghp_…';
  $<HTMLSelectElement>('f-poller').value = s.poller;
  $<HTMLInputElement>('f-interval').value = String(Math.round(s.pollIntervalMs / 1000));
  $<HTMLTextAreaElement>('f-rules').value = JSON.stringify(s.ruleConfig, null, 2);
  await populatePorts(s.serialPort);
}

function toast(msg: string, kind: 'ok' | 'error'): void {
  const el = $('toast');
  el.textContent = msg;
  el.dataset.kind = kind;
  el.dataset.show = 'true';
  setTimeout(() => (el.dataset.show = 'false'), 2600);
}

async function save(e: Event): Promise<void> {
  e.preventDefault();

  let ruleConfig: unknown;
  try {
    ruleConfig = JSON.parse($<HTMLTextAreaElement>('f-rules').value);
  } catch (err) {
    toast(`Invalid rules JSON: ${(err as Error).message}`, 'error');
    return;
  }

  const interval = parseInt($<HTMLInputElement>('f-interval').value, 10);
  const patch: Record<string, unknown> = {
    githubUsername: $<HTMLInputElement>('f-username').value.trim(),
    poller: $<HTMLSelectElement>('f-poller').value,
    serialPort: $<HTMLSelectElement>('f-port').value,
    pollIntervalMs: Number.isFinite(interval) ? Math.max(10, interval) * 1000 : 60000,
    ruleConfig,
  };
  const token = $<HTMLInputElement>('f-token').value;
  if (token) patch.githubToken = token;

  $<HTMLButtonElement>('save').disabled = true;
  try {
    const next = await api.updateSettings(patch);
    $<HTMLInputElement>('f-token').value = '';
    $<HTMLInputElement>('f-token').placeholder = next.hasToken ? '•••• set (blank = keep)' : 'ghp_…';
    toast('Saved', 'ok');
  } catch (err) {
    toast(`Save failed: ${(err as Error).message}`, 'error');
  } finally {
    $<HTMLButtonElement>('save').disabled = false;
  }
}

async function init(): Promise<void> {
  $('settings-form').addEventListener('submit', save);
  $('poll-now').addEventListener('click', () => void api.pollNow());
  api.onSnapshot(renderStatus);
  await loadSettings();
  try {
    renderStatus(await api.getSnapshot());
  } catch {
    /* snapshot unavailable */
  }
}

document.addEventListener('DOMContentLoaded', () => void init());
