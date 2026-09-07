import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { RuntimeStore } from '../../src/v2/runtime.js';
import { defaultConfig } from '../../src/config/config.js';
import { McpIngress } from '../../src/mcp/ingress.js';
import { createMcpServer } from '../../src/mcp/server.js';

// Characterize the pinned SDK limitation, not a desired MCP contract. Update on SDK fix/upgrade.
it.each([[0, 1], [1, 0]])('SDK cancellation requestId=%s leaves %s pending submissions', async (id, pending) => {
  const root = mkdtempSync(join(tmpdir(), 'cm-cancel-'));
  const store = new RuntimeStore(root);
  const server = createMcpServer(new McpIngress(store, { ...defaultConfig(), dataRoot: root }, { clientId: 'probe', workspaces: [], global: true, accept: true, capabilities: ['relay'] }));
  const transport: Parameters<typeof server.connect>[0] = {
    async start() {}, async send() {}, async close() { transport.onclose?.(); },
  };
  try {
    await server.connect(transport);
    transport.onmessage!({ jsonrpc: '2.0', id: 99, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } });
    await new Promise(resolve => setImmediate(resolve));
    transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });
    transport.onmessage!({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'memory_submit_user_turn', arguments: { submissionId: 'one', contextId: 'global', text: 'Prefer concise replies.' } } });
    transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });
    await new Promise(resolve => setImmediate(resolve));
    expect(store.pending()).toHaveLength(pending);
  } finally { await server.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
