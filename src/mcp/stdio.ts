import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from '../config/config.js';
import { createConfiguredWriter } from '../config/runtime.js';
import { MCP_CAPABILITIES, McpIngress, type McpCapability, type McpOptions } from './ingress.js';
import { createMcpServer } from './server.js';

export function parseMcpOptions(args: string[]): McpOptions {
  const options: McpOptions = { clientId: '', workspaces: [], global: false, accept: false, capabilities: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--global') options.global = true;
    else if (arg === '--accept-client-reported-user-turns') options.accept = true;
    else if (arg === '--client-id' || arg === '--workspace' || arg === '--capability') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('MCP option requires a value');
      if (arg === '--workspace') options.workspaces.push(value);
      else if (arg === '--capability') {
        if (!MCP_CAPABILITIES.includes(value as McpCapability)) throw new Error('Unknown MCP capability');
        if (!options.capabilities.includes(value as McpCapability)) options.capabilities.push(value as McpCapability);
      }
      else { if (options.clientId) throw new Error('Duplicate --client-id'); options.clientId = value; }
    } else throw new Error('Unknown MCP option');
  }
  if (!options.clientId) throw new Error('MCP requires --client-id');
  // Without --capability the process keeps its original relay behaviour.
  if (!options.capabilities.length) options.capabilities.push('relay');
  return options;
}

/** One process owns one Writer, even if SDK discovery invokes the factory twice. Read-only launches own none. */
export async function runMcp(args: string[]): Promise<void> {
  const options = parseMcpOptions(args);
  const config = loadConfig();
  if (!config) throw new Error('Run common-memory config first');
  const readOnly = options.capabilities.every(c => c === 'read');
  const writer = readOnly ? null : createConfiguredWriter(config);
  let ingress: McpIngress;
  try { ingress = new McpIngress(writer?.store ?? null, config, options); }
  catch { writer?.close(); throw new Error('MCP context configuration is invalid'); }
  const abort = new AbortController();
  let running: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const report = () => { process.stderr.write('[common-memory] MCP maintenance unavailable; inspect common-memory status.\n'); };
  const check = () => {
    if (closing || running || !writer) return;
    running = writer.run({ signal: abort.signal }).then(value => { if (value.outcome === 'failed') report(); }, report)
      .finally(() => { running = undefined; });
  };
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 });
  const handle = serveStdio(() => createMcpServer(ingress), { transport, onerror: report });
  const timer = setInterval(check, 1000); timer.unref();
  const shutdown = () => {
    if (closing) return;
    // Publish closing before the async cleanup can trigger transport.onclose again.
    closing = Promise.resolve().then(async () => {
      clearInterval(timer);
      abort.abort();
      try { writer?.store.requestFlush(); } catch { report(); }
      try { await handle.close(); await running; }
      finally {
        writer?.close();
        process.stdin.off('end', shutdown); process.stdin.off('error', shutdown);
        process.stdout.off('error', shutdown);
        process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown);
      }
    }).catch(report).finally(finish);
  };
  const sdkClose = transport.onclose;
  transport.onclose = () => { sdkClose?.(); shutdown(); };
  process.stdin.once('end', shutdown); process.stdin.once('error', shutdown);
  process.stdout.once('error', shutdown);
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  if (process.stdin.readableEnded || process.stdin.destroyed) shutdown();
  else check();
  await finished;
}
