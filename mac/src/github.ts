import { execFile } from 'child_process';
import { promisify } from 'util';
import { Octokit } from '@octokit/rest';
import { config } from './config';
import { EventKind, Poller, PrEntry } from './types';

const execFileAsync = promisify(execFile);

interface SearchItem {
  title: string;
  html_url: string;
  repository_url: string;
  user: { login: string } | null;
}

function buildQueries(username: string, lastChecked: Date, repos: string[]): Array<{ q: string; kind: EventKind }> {
  const scope = repos.length === 0 ? '' : ' ' + repos.map((r) => `repo:${r}`).join(' ');
  return [
    { kind: 'needs_review',  q: `is:pr is:open review-requested:${username}${scope}` },
    { kind: 'new_comment',   q: `is:pr is:open author:${username} updated:>${lastChecked.toISOString()} -author:${username}${scope}` },
    { kind: 'build_failing', q: `is:pr is:open author:${username} status:failure${scope}` },
  ];
}

export class GithubAPIPoller implements Poller {
  private octokit: Octokit;
  private lastChecked: Date = new Date(0);

  constructor(private repos: string[] = []) {
    this.octokit = new Octokit({ auth: config.github.token });
  }

  async poll(): Promise<PrEntry[]> {
    const queries = buildQueries(config.github.username, this.lastChecked, this.repos);
    const results = await Promise.all(queries.map(({ q, kind }) => this.search(q, kind)));
    this.lastChecked = new Date();
    return results.flat();
  }

  private async search(q: string, kind: EventKind): Promise<PrEntry[]> {
    const { data } = await this.octokit.search.issuesAndPullRequests({ q, per_page: 10 });
    return data.items.map((item) => toEntry(item as SearchItem, kind));
  }
}

export class GithubCLIPoller implements Poller {
  private lastChecked: Date = new Date(0);

  constructor(private repos: string[] = []) {}

  async poll(): Promise<PrEntry[]> {
    const queries = buildQueries(config.github.username, this.lastChecked, this.repos);
    const results = await Promise.all(queries.map(({ q, kind }) => this.search(q, kind)));
    this.lastChecked = new Date();
    return results.flat();
  }

  private async search(q: string, kind: EventKind): Promise<PrEntry[]> {
    // Don't leak GITHUB_TOKEN / GH_TOKEN to gh: an empty or stale token in .env
    // would override the working keyring auth and produce 401s.
    const env = { ...process.env };
    delete env.GITHUB_TOKEN;
    delete env.GH_TOKEN;
    const { stdout } = await execFileAsync('gh', [
      'api', '-X', 'GET', 'search/issues',
      '-f', `q=${q}`,
      '-F', 'per_page=10',
    ], { env });
    const data = JSON.parse(stdout) as { items: SearchItem[] };
    return data.items.map((item) => toEntry(item, kind));
  }
}

function toEntry(pr: SearchItem, kind: EventKind): PrEntry {
  return {
    title: pr.title,
    url: pr.html_url,
    repo: pr.repository_url.split('/').slice(-2).join('/'),
    author: pr.user?.login ?? '',
    kind,
  };
}
