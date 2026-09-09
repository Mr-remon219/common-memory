import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, isAbsolute } from 'node:path';
import { loadConfig, configDirectory } from '../config/config.js';
import { createConfiguredWriter } from '../config/runtime.js';
import { drainSessions } from '../v2/session-drain.js';
import { consumeCodexInbox } from './codex-session.js';
export function launchSessionDrain(home=configDirectory()):number|undefined {
  const child=spawn(process.execPath,[fileURLToPath(new URL('./main.js',import.meta.url)),'session-drain','--home',home],{detached:true,stdio:'ignore',env:{...process.env,COMMON_MEMORY_HOME:home}});
  child.on('error',()=>process.stderr.write('[common-memory] consumer launch failed; run common-memory session-drain.\n'));
  child.unref();
  return child.pid;
}
export async function runSessionDrain(args:string[]):Promise<void> {
  const home=args.length===0?configDirectory():args.length===2&&args[0]==='--home'&&isAbsolute(args[1]!)?args[1]!:null;
  if(!home)throw new Error('session-drain requires --home <absolute-path>');
  process.env.COMMON_MEMORY_HOME=home;
  const config=loadConfig(join(home,'config.json'));if(!config)throw new Error('UNCONFIGURED');
  // Run sealed work between inbox admissions so completion watches do not delay maintenance.
  const writer=createConfiguredWriter(config);
  try { await consumeCodexInbox(config,async()=>{while((await writer.run()).outcome!=='idle'&&writer.store.hasWork()){ /* next sealed batch */ }}); const complete=await drainSessions(writer); if(!complete)process.exitCode=1; }
  finally {await writer.close();}
}
