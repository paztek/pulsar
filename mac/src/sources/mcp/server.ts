import { createServer, IncomingMessage, Server as HttpServer } from 'http';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { Core } from '../../core/core';
import { getSettings, updateSettings } from '../../core/settings';
import { McpPushSource } from './push-source';
import { LedId } from '../../core/types';
import { log } from '../../core/log';

// The MCP SDK ships a CJS build but uses a package "exports" map that classic TS
// moduleResolution doesn't read, so require() it (typed as any) rather than import.
/* eslint-disable @typescript-eslint/no-var-requires */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
/* eslint-enable */

const HOST = '127.0.0.1';

const jsonResource = (uri: URL, value: unknown) => ({
  contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }],
});

const ok = (text: string) => ({ content: [{ type: 'text', text }] });

const LED_ENUM = z.enum(['red', 'yellow', 'blue', 'green']);

/** Build a fresh McpServer wired to the Core + MCP push source. One per session. */
function buildServer(core: Core, push: McpPushSource): unknown {
  const server = new McpServer({ name: 'pulsar', version: '0.1.0' });

  // --- Resources (read) ---
  server.resource('status', 'pulsar://status', async (uri: URL) =>
    jsonResource(uri, core.getSnapshot()),
  );
  server.resource('events', 'pulsar://events', async (uri: URL) =>
    jsonResource(uri, core.getSnapshot().ruleHits),
  );
  server.resource('config', 'pulsar://config', async (uri: URL) => {
    const { githubTokenEnc, ...rest } = getSettings();
    return jsonResource(uri, { ...rest, hasToken: Boolean(githubTokenEnc) });
  });

  // --- Tools: semantic signals (compose with GitHub etc.) ---
  server.tool(
    'raise_signal',
    'Raise a signal that lights LEDs until cleared or its TTL expires. Composes with other sources (a reason for the LED to be on). Use for "X needs attention".',
    {
      leds: z.array(LED_ENUM).min(1),
      title: z.string(),
      url: z.string().optional(),
      notify: z.boolean().optional(),
      ttl_seconds: z.number().int().positive().optional(),
    },
    async (a: { leds: string[]; title: string; url?: string; notify?: boolean; ttl_seconds?: number }) => {
      const { id, expiresAt } = push.raise({
        leds: a.leds,
        title: a.title,
        url: a.url,
        notify: a.notify,
        ttlSeconds: a.ttl_seconds,
      });
      return ok(`Raised ${id}${expiresAt ? ` — expires ${new Date(expiresAt).toISOString()}` : ''}`);
    },
  );

  server.tool('clear_signal', 'Clear a previously raised signal by id.', { id: z.string() }, async (a: { id: string }) =>
    ok(push.clear(a.id) ? `Cleared ${a.id}` : `No such signal: ${a.id}`),
  );

  server.tool('list_signals', 'List the signals currently raised via MCP.', {}, async () => {
    const view = push.list().map((s) => ({
      id: s.id,
      leds: s.leds.map((l) => LedId[l].toLowerCase()),
      title: s.title,
      notify: s.notify,
      expiresAt: s.expiresAt ? new Date(s.expiresAt).toISOString() : null,
    }));
    return ok(JSON.stringify(view, null, 2));
  });

  // --- Tools: control / raw ---
  server.tool('poll_now', 'Trigger an immediate GitHub poll.', {}, async () => {
    await core.pollNow();
    return ok('Polled.');
  });

  server.tool(
    'set_led',
    'Force one LED on/off directly (raw, transient — the next recompute re-asserts source-driven state). For semantic status use raise_signal instead.',
    { led: LED_ENUM, on: z.boolean() },
    async (a: { led: 'red' | 'yellow' | 'blue' | 'green'; on: boolean }) => {
      await core.setLed(a.led, a.on);
      return ok(`LED ${a.led} → ${a.on ? 'on' : 'off'}`);
    },
  );

  server.tool('blink', 'Blink all LEDs (the connection-confirmation pattern).', {}, async () => {
    await core.blink();
    return ok('Blinked.');
  });

  server.tool('reload_config', 'Reload rules from settings and poll immediately.', {}, async () => {
    await core.reloadRules();
    return ok('Reloaded.');
  });

  return server;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

function isInitialize(body: unknown): boolean {
  return Boolean(body) && (body as { method?: string }).method === 'initialize';
}

/**
 * Toggleable MCP server over Streamable HTTP, bound to localhost. Standard
 * stateful session handling (a transport per MCP session id).
 */
export class McpManager {
  private http: HttpServer | null = null;
  private port: number;
  private push = new McpPushSource();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private transports: Record<string, any> = {};

  constructor(private core: Core) {
    this.port = getSettings().mcpPort;
  }

  isRunning(): boolean {
    return this.http !== null;
  }

  url(): string | null {
    return this.http ? `http://${HOST}:${this.port}/mcp` : null;
  }

  async setEnabled(on: boolean): Promise<void> {
    if (on) await this.start();
    else await this.stop();
    updateSettings({ mcpEnabled: on });
  }

  async start(): Promise<void> {
    if (this.http) return;
    this.port = getSettings().mcpPort;

    const http = createServer((req, res) => {
      void this.handle(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(this.port, HOST, () => resolve());
    });

    this.http = http;
    this.core.addPushSource(this.push); // agent-raised signals feed the LED state
    log(`mcp: listening on ${this.url()}`);
    this.core.setMcpInfo({ enabled: true, url: this.url() });
  }

  async stop(): Promise<void> {
    if (!this.http) return;
    this.core.removePushSource(this.push.name);
    for (const t of Object.values(this.transports)) {
      try {
        t.close?.();
      } catch {
        /* ignore */
      }
    }
    this.transports = {};
    await new Promise<void>((resolve) => this.http!.close(() => resolve()));
    this.http = null;
    log('mcp: stopped');
    this.core.setMcpInfo({ enabled: false, url: null });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handle(req: IncomingMessage, res: any): Promise<void> {
    try {
      const url = req.url ?? '';
      if (!url.startsWith('/mcp')) {
        res.writeHead(404).end();
        return;
      }
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (req.method === 'POST') {
        const body = await readBody(req);
        let transport = sessionId ? this.transports[sessionId] : undefined;

        if (!transport && isInitialize(body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              this.transports[sid] = transport;
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) delete this.transports[transport.sessionId];
          };
          const server = buildServer(this.core, this.push);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (server as any).connect(transport);
        } else if (!transport) {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session' }, id: null }),
          );
          return;
        }
        await transport.handleRequest(req, res, body);
        return;
      }

      // GET (SSE stream) and DELETE (end session) need an existing session.
      if (req.method === 'GET' || req.method === 'DELETE') {
        if (!sessionId || !this.transports[sessionId]) {
          res.writeHead(400).end();
          return;
        }
        await this.transports[sessionId].handleRequest(req, res);
        return;
      }

      res.writeHead(405).end();
    } catch (e) {
      log(`mcp: request error — ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  }
}
