// Connects to the running Pulsar MCP server with the official SDK client and
// exercises resources + tools. Requires the app running (the MCP server is
// always on). Run: node scripts/verify-mcp.js
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const URL_ = process.env.MCP_URL || 'http://127.0.0.1:7332/mcp';

(async () => {
  const transport = new StreamableHTTPClientTransport(new URL(URL_));
  const client = new Client({ name: 'verify-mcp', version: '0.0.1' });
  await client.connect(transport);
  console.log('connected to', URL_);

  const tools = await client.listTools();
  console.log('tools:', tools.tools.map((t) => t.name).join(', '));

  const resources = await client.listResources();
  console.log('resources:', resources.resources.map((r) => r.uri).join(', '));

  const status = await client.readResource({ uri: 'pulsar://status' });
  const snap = JSON.parse(status.contents[0].text);
  console.log('status.serial:', snap.serial, '| leds:', JSON.stringify(snap.leds));

  const cfg = await client.readResource({ uri: 'pulsar://config' });
  const config = JSON.parse(cfg.contents[0].text);
  console.log('config redacted:', 'githubTokenEnc' in config ? 'LEAKED!' : `ok (hasToken=${config.hasToken})`);

  const poll = await client.callTool({ name: 'poll_now', arguments: {} });
  console.log('poll_now →', poll.content[0].text);

  // Push-source flow: raise a semantic signal, confirm it shows in status, clear it.
  const raised = await client.callTool({
    name: 'raise_signal',
    arguments: { leds: ['blue'], title: 'verify needs attention', notify: false, ttl_seconds: 30 },
  });
  const id = raised.content[0].text.replace(/^Raised /, '').split(' ')[0];
  console.log('raise_signal →', raised.content[0].text);

  const afterRaise = JSON.parse((await client.readResource({ uri: 'pulsar://status' })).contents[0].text);
  console.log('status after raise: blue =', afterRaise.leds.blue, '| signals =', afterRaise.signals.map((s) => s.source + ':' + s.leds.join('')));

  const listed = await client.callTool({ name: 'list_signals', arguments: {} });
  console.log('list_signals →', listed.content[0].text.replace(/\s+/g, ' ').slice(0, 120));

  const cleared = await client.callTool({ name: 'clear_signal', arguments: { id } });
  console.log('clear_signal →', cleared.content[0].text);

  const afterClear = JSON.parse((await client.readResource({ uri: 'pulsar://status' })).contents[0].text);
  console.log('status after clear: blue =', afterClear.leds.blue, '| signals =', afterClear.signals.length);

  await client.close();
  console.log('OK: MCP server verified');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
