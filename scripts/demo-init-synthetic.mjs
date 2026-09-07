#!/usr/bin/env node
// Reproducible Init demo with an isolated data directory and a scripted (synthetic) maintainer model.
// It proves the local mechanics only: init MCP server -> durable queue -> unchanged Writer -> canonical Markdown -> read.
// It does not prove real-model semantics, nor that a real ChatGPT/Codex/Pi client called these tools.
//
//   node scripts/demo-init-synthetic.mjs [--home <dir>] [--keep-provider]
//
// Afterwards the printed Codex/Pi/ChatGPT configuration points at the same COMMON_MEMORY_HOME.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const home = resolve(args.includes('--home') ? args[args.indexOf('--home') + 1] : '/tmp/common-memory-demo');
const keepProvider = args.includes('--keep-provider');
const cli = join(root, 'dist/cli/main.js');
if (!existsSync(cli)) throw new Error('Run npm run build first');
if (existsSync(join(home, 'data'))) { rmSync(join(home, 'data'), { recursive: true, force: true }); }
mkdirSync(home, { recursive: true, mode: 0o700 });

// Synthetic, clearly fictional facts: not in this repository, not guessable from common sense.
const understanding = [
  'The user is an ecology student who keeps a rescued three-legged tortoise named Quillon.',
  'They are learning Rust on weekends and like answers in Chinese with English technical terms in parentheses.',
  'They dislike being addressed with honorifics.',
].join(' ');

// Scripted maintainer: retains the import as attributed understanding in Profile and the reply preference in Preferences.
const provider = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const projection = JSON.parse(JSON.parse(body).input[1].content[0].text);
  const imports = projection.observations.filter(o => o.source_kind === 'agent_import');
  const decisions = imports.length ? [
    { kind: 'retain', admission: 'remember', lifetime: 'until_changed', applicability: 'global', confidence: 0.7, evidence: imports.map(o => o.ref), reason: 'scripted demo',
      operations: [{ op: 'put_section', target: 'profile', section: null, title: 'Imported understanding', body: `Imported from ${imports[0].import.source_label} on ${projection.now.slice(0, 10)} (basis: ${imports[0].import.basis}; not user-verified): ${imports[0].text}\nGaps reported by the source: ${imports[0].import.gaps ?? 'none'}\n` }] },
    { kind: 'retain', admission: 'remember', lifetime: 'until_changed', applicability: 'global', confidence: 0.7, evidence: imports.map(o => o.ref), reason: 'scripted demo',
      operations: [{ op: 'put_section', target: 'preferences', section: null, title: 'Reply style (imported)', body: `Imported from ${imports[0].import.source_label}: answer in Chinese, keep English technical terms in parentheses, no honorifics.\n` }] },
  ] : [{ kind: 'ignore', applicability: 'uncertain', confidence: 1, evidence: [], reason: 'scripted demo ignores user turns' }];
  const decision = { version: 'memory_maintenance_v2', request_id: projection.request_id, decisions };
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: 'completed', incomplete_details: null, error: null, output: [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(decision), annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const port = provider.address().port;

const config = {
  schemaVersion: 2, dataRoot: join(home, 'data'),
  remote: { provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'scripted-demo', apiKeyEnv: 'COMMON_MEMORY_DEMO_KEY' },
  disclosure: { enabled: true, allowedScopes: ['global'], allowedProvenance: ['user_explicit', 'agent_observation'], maxExcerptBytes: 131072, maxCandidateBytes: 131072, maxTotalBytes: 131072 },
  writableScopes: ['global'],
  scheduler: { turnThreshold: 6, byteThreshold: 16384, idleMs: 120000, maxWaitMs: 600000, leaseMs: 120000, maxAttempts: 5 },
};
writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
writeFileSync(join(home, '.env'), 'COMMON_MEMORY_DEMO_KEY="synthetic-demo-key"\n', { mode: 0o600 });
const env = { ...process.env, COMMON_MEMORY_HOME: home };

// 1. "ChatGPT" side: init-only MCP process.
const client = new Client({ name: 'demo-init-client', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--client-id', 'demo-chatgpt', '--capability', 'init', '--global'], env, stderr: 'pipe' });
transport.stderr?.on('data', b => process.stderr.write(`[init-server] ${b}`));
await client.connect(transport);
console.log('init server tools:', (await client.listTools()).tools.map(t => t.name).join(', '));
const importId = `demo-${new Date().toISOString().slice(0, 10)}`;
const submit = await client.callTool({ name: 'memory_init', arguments: { importId, contextId: 'global', sourceLabel: 'demo-agent', basis: 'saved_memories', understanding, gaps: 'Synthetic demo; no real agent memory was accessed.' } });
console.log('memory_init ->', JSON.stringify(submit.structuredContent));
let status;
for (let i = 0; i < 60; i++) {
  status = (await client.callTool({ name: 'memory_status', arguments: { importId } })).structuredContent.import;
  if (!['pending', 'claimed'].includes(status.state)) break;
  await new Promise(r => setTimeout(r, 500));
}
console.log('memory_status ->', JSON.stringify(status));
await client.close();
if (status.state !== 'processed' || !status.retainedIn.length) { provider.close(); process.exit(1); }

// 2. Local view (what the user can inspect, and exactly what consumers read).
console.log('\n--- memory/profile.md ---\n' + readFileSync(join(home, 'data/memory/profile.md'), 'utf8'));
console.log('--- memory/preferences.md ---\n' + readFileSync(join(home, 'data/memory/preferences.md'), 'utf8'));

// 3. Consumer configuration for the same COMMON_MEMORY_HOME.
const node = process.execPath;
console.log(`
Codex CLI (~/.codex/config.toml or an isolated CODEX_HOME):
[mcp_servers.common_memory]
command = "${node}"
args = ["${cli}", "mcp", "--client-id", "codex-cli", "--capability", "read", "--global"]
env = { COMMON_MEMORY_HOME = "${home}" }
enabled_tools = ["memory_read", "memory_status"]
default_tools_approval_mode = "auto"

Pi (pinned 0.84.4 from this checkout):
COMMON_MEMORY_HOME=${home} node node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js -p --no-extensions --no-context-files --no-skills --no-prompt-templates --no-session -e ${join(root, 'dist/pi-extension/index.js')} "我是谁？"

Local view:
COMMON_MEMORY_HOME=${home} node ${cli} show
`);
if (keepProvider) { console.log(`Synthetic provider stays up on 127.0.0.1:${port}; press Ctrl-C to stop.`); }
else provider.close();
