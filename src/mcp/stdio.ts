import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from '../config/config.js';
import { MCP_CAPABILITIES, type McpCapability, type McpOptions } from './ingress.js';
import { McpChannelIngress } from './channel-ingress.js';
import { createMcpServer } from './server.js';
import { MCP_MAX_MESSAGE_BYTES } from './contract.js';
import { currentRuntimeVersion, registerRuntimeInstance } from '../cli/runtime-instances.js';

export function parseMcpOptions(args: string[]): McpOptions {
  const options: McpOptions = { clientId: '', workspaces: [], global: false, accept: false, capabilities: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--global') options.global = true;
    else if (arg === '--accept-client-reported-user-turns') options.accept = true;
    else if (arg === '--client-id' || arg === '--workspace' || arg === '--workspace-project-id' || arg === '--capability') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('MCP option requires a value');
      if (arg === '--workspace') options.workspaces.push(value);
      else if (arg === '--workspace-project-id') (options.workspaceProjectIds ??= []).push(value);
      else if (arg === '--capability') {
        if (!MCP_CAPABILITIES.includes(value as McpCapability)) throw new Error('Unknown MCP capability');
        if (!options.capabilities.includes(value as McpCapability)) options.capabilities.push(value as McpCapability);
      }
      else { if (options.clientId) throw new Error('Duplicate --client-id'); options.clientId = value; }
    } else throw new Error('Unknown MCP option');
  }
  if (!options.clientId) throw new Error('MCP requires --client-id');
  if (!options.capabilities.length) options.capabilities.push('relay');
  return options;
}

/** Stdio is only a channel. EOF closes this connection and never cancels accepted Core work. */
export async function runMcp(args: string[]): Promise<void> {
  const options=parseMcpOptions(args),config=loadConfig();if(!config)throw new Error('Run common-memory config first');
  const unregister=registerRuntimeInstance({role:'mcp',version:currentRuntimeVersion(),pid:process.pid,executable:process.execPath,cli:process.argv[1]??'unknown',lifecycle:'channel',wireProtocol:1});
  const ingress=new McpChannelIngress(config,options);
  let closing:Promise<void>|undefined,finish!:()=>void;
  const finished=new Promise<void>(resolve=>{finish=resolve;});
  const report=()=>{process.stderr.write('[common-memory] MCP channel unavailable; inspect common-memory status.\n');};
  const transport=new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:MCP_MAX_MESSAGE_BYTES});
  const handle=serveStdio(()=>createMcpServer(ingress),{transport,onerror:report});
  const shutdown=()=>{
    if(closing)return;
    closing=handle.close().catch(report).finally(()=>{
      unregister();process.stdin.off('end',shutdown);process.stdin.off('error',shutdown);process.stdout.off('error',shutdown);process.off('SIGINT',shutdown);process.off('SIGTERM',shutdown);finish();
    });
  };
  const sdkClose=transport.onclose;transport.onclose=()=>{sdkClose?.();shutdown();};
  process.stdin.once('end',shutdown);process.stdin.once('error',shutdown);process.stdout.once('error',shutdown);process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  if(process.stdin.readableEnded||process.stdin.destroyed)shutdown();
  await finished;
}
