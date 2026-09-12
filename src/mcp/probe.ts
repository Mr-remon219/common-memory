import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

/** Disposable read-capability handshake only; never call tools or start an init/Writer process. */
export async function probeReadServer(launch: { command: string; args: string[]; env?: Record<string, string> }, timeout: number): Promise<boolean> {
  const client = new Client({ name: 'common-memory-install-check', version: '1' });
  try {
    const transport = new StdioClientTransport({ ...launch, stderr: 'ignore', maxBufferSize: 1_048_576 });
    await client.connect(transport, { timeout });
    const names = (await client.listTools(undefined, { timeout })).tools.map(t => t.name).sort();
    return names.join(',') === 'memory_read,memory_status';
  } catch {
    // Never expose arbitrary process errors, environment values or credentials.
    return false;
  } finally { await client.close().catch(() => {}); }
}
