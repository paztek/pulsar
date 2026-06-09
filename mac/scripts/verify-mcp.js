// Connects to the running Pulsar MCP server with the official SDK client and
// exercises resources + tools. Requires the app running with the MCP server on
// (PULSAR_MCP=1 npm run app). Run: node scripts/verify-mcp.js
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

  const led = await client.callTool({ name: 'set_led', arguments: { led: 'blue', on: true } });
  console.log('set_led →', led.content[0].text);

  await client.close();
  console.log('OK: MCP server verified');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
