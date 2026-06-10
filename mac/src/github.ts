import { execFile } from 'child_process';
import { promisify } from 'util';
import { Octokit } from '@octokit/rest';
import { config } from './config';
import { log } from './log';
import { GithubClient, SearchItem } from './types';

const execFileAsync = promisify(execFile);

interface RawSearchItem {
  title: string;
  html_url: string;
  repository_url: string;
  user: { login: string } | null;
}

// Exponential floor for repeated secondary rate-limit hits (seconds).
const BACKOFF_FLOOR_SECS = [60, 120, 240, 480, 900];

class RateLimitTracker {
  private until: Date | null = null;
  private consecutive = 0;

  blockedUntil(): Date | null {
    if (this.until && new Date() < this.until) return this.until;
    return null;
  }

  recordHit(retryAfterSecs: number | null): Date {
    this.consecutive += 1;
    const floor = BACKOFF_FLOOR_SECS[Math.min(this.consecutive - 1, BACKOFF_FLOOR_SECS.length - 1)];
    const wait = Math.max(retryAfterSecs ?? 0, floor);
    this.until = new Date(Date.now() + wait * 1000);
    return this.until;
  }

  recordSuccess(): boolean {
    if (this.consecutive === 0) return false;
    this.consecutive = 0;
    this.until = null;
    return true;
  }
}

// Returns retry-after seconds (or null = rate limited without header), or undefined if unrelated.
function detectApiRateLimit(e: unknown): number | null | undefined {
  const err = e as { status?: number; response?: { headers?: Record<string, string | undefined> }; message?: string };
  const status = err?.status;
  const msg = err?.message ?? '';
  const isLimit = status === 403 || status === 429 || /rate limit/i.test(msg);
  if (!isLimit) return undefined;
  const ra = err?.response?.headers?.['retry-after'];
  if (ra) {
    const n = parseInt(ra, 10);
    if (!isNaN(n)) return n;
  }
  const reset = err?.response?.headers?.['x-ratelimit-reset'];
  if (reset) {
    const epoch = parseInt(reset, 10);
    if (!isNaN(epoch)) return Math.max(0, epoch - Math.floor(Date.now() / 1000));
  }
  return null;
}

function detectCliRateLimit(e: unknown): number | null | undefined {
  const err = e as { stderr?: string; stdout?: string };
  const blob = (err?.stderr ?? '') + (err?.stdout ?? '');
  if (/rate limit|secondary rate|abuse detection/i.test(blob)) return null;
  return undefined;
}

function toItem(pr: RawSearchItem): SearchItem {
  return {
    title: pr.title,
    url: pr.html_url,
    repo: pr.repository_url.split('/').slice(-2).join('/'),
    author: pr.user?.login ?? '',
  };
}

export class GithubAPIClient implements GithubClient {
  private octokit: Octokit;
  private limits = new RateLimitTracker();

  constructor() {
    this.octokit = new Octokit({ auth: config.github.token });
  }

  async search(query: string): Promise<SearchItem[] | null> {
    const blocked = this.limits.blockedUntil();
    if (blocked) {
      log(`search skipped — rate-limited until ${blocked.toISOString()}`);
      return null;
    }
    try {
      const { data } = await this.octokit.search.issuesAndPullRequests({ q: query, per_page: 10 });
      if (this.limits.recordSuccess()) log('rate limit cleared');
      return data.items.map((item) => toItem(item as RawSearchItem));
    } catch (e) {
      const retryAfter = detectApiRateLimit(e);
      if (retryAfter !== undefined) {
        const until = this.limits.recordHit(retryAfter);
        log(`rate limited — backing off until ${until.toISOString()}`);
        return null;
      }
      throw e;
    }
  }
}

export class GithubCLIClient implements GithubClient {
  private limits = new RateLimitTracker();

  async search(query: string): Promise<SearchItem[] | null> {
    const blocked = this.limits.blockedUntil();
    if (blocked) {
      log(`search skipped — rate-limited until ${blocked.toISOString()}`);
      return null;
    }
    // Don't leak GITHUB_TOKEN / GH_TOKEN to gh: an empty or stale token in .env
    // would override the working keyring auth and produce 401s.
    const env = { ...process.env };
    delete env.GITHUB_TOKEN;
    delete env.GH_TOKEN;
    // GUI-launched apps (Finder/Spotlight) inherit a minimal PATH without
    // Homebrew, so `gh` (commonly /opt/homebrew/bin or /usr/local/bin) isn't
    // found. Make sure those locations are on PATH.
    env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', env.PATH].filter(Boolean).join(':');
    try {
      const { stdout } = await execFileAsync('gh', [
        'api', '-X', 'GET', 'search/issues',
        '-f', `q=${query}`,
        '-F', 'per_page=10',
      ], { env });
      const data = JSON.parse(stdout) as { items: RawSearchItem[] };
      if (this.limits.recordSuccess()) log('rate limit cleared');
      return data.items.map(toItem);
    } catch (e) {
      const retryAfter = detectCliRateLimit(e);
      if (retryAfter !== undefined) {
        const until = this.limits.recordHit(retryAfter);
        log(`rate limited — backing off until ${until.toISOString()}`);
        return null;
      }
      throw e;
    }
  }
}
