import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CommonMemoryConfig } from '../config/config.js';
import { ProjectRegistry } from '../v2/registry.js';
import { withRepositoryLock } from '../v2/lock.js';
import { ServiceClient } from '../service/client.js';
import type { RuntimeStore } from '../v2/runtime.js';
import type { hostQueueStatus } from './host-session.js';
import { readAuthorizedMemory, renderMemoryView } from '../v2/reader.js';

/** CLI and TUI use identical scope selection. Reading never opens the queue. */
export function memoryView(config: CommonMemoryConfig, workspace?: string) {
  const contexts = ['global'];
  if (workspace !== undefined) {
    const project = new ProjectRegistry(config.dataRoot).resolve(workspace);
    if (!project) throw new Error('Workspace is not registered');
    contexts.push(`project:${project.id}`);
  }
  return readAuthorizedMemory({ dataRoot: config.dataRoot, contexts: contexts.filter(scope => config.disclosure.allowedScopes.includes(scope)) });
}

export function showMemory(config: CommonMemoryConfig, workspace?: string, log: (line: string) => void = console.log): void {
  log(`Memory files: ${join(config.dataRoot, 'memory')}`);
  log(renderMemoryView(memoryView(config, workspace)));
}

/** Runtime status is service-owned; canonical-only commands remain local. */
export type RuntimeStatus=ReturnType<RuntimeStore['status']>&{host:ReturnType<typeof hostQueueStatus>;sessions:unknown[]};
export async function runtimeStatus(_config:CommonMemoryConfig,afterRecoveryId?:string):Promise<RuntimeStatus|null>{
  try{return await new ServiceClient({kind:'cli'}).call<RuntimeStatus>('queue.status',{...(afterRecoveryId?{afterRecoveryId}:{})},{wake:false});}catch(error){if(error instanceof Error&&['SERVICE_NOT_INSTALLED','SERVICE_UNAVAILABLE'].includes(error.message))return null;throw error;}
}
async function explicitMutation(operation:string,payload:unknown,prefix:string):Promise<void>{const client=new ServiceClient({kind:'cli'}),options={requestId:`${prefix}-${randomUUID()}`};try{await client.call(operation,payload,options);}catch(error){if(!(error instanceof Error)||error.message!=='DELIVERY_UNCERTAIN')throw error;await client.call(operation,payload,options);}}
export async function retryJob(_config:CommonMemoryConfig,id:string):Promise<void>{await explicitMutation('queue.retry',{id},'queue-retry');}
export async function recoverHostInbox(_config:CommonMemoryConfig,id:string):Promise<void>{await explicitMutation('host.recover',{id},'host-recover');}
export async function cancelJob(_config:CommonMemoryConfig,id:string):Promise<void>{await explicitMutation('task.cancel',{id},'queue-cancel');}

export function listProjects(config: CommonMemoryConfig) { return new ProjectRegistry(config.dataRoot).list(); }
export function registerProject(config: CommonMemoryConfig, root: string, name: string) {
  return withRepositoryLock(config.dataRoot, () => new ProjectRegistry(config.dataRoot).register(root, name));
}
export function removeProject(config: CommonMemoryConfig, id: string): boolean {
  return withRepositoryLock(config.dataRoot, () => new ProjectRegistry(config.dataRoot).remove(id));
}
