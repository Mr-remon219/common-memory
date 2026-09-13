import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, isAbsolute } from 'node:path';
import { loadConfig, configDirectory } from '../config/config.js';
import { createConfiguredWriter } from '../config/runtime.js';
import { drainSessions } from '../v2/session-drain.js';
import { consumeCodexInbox, recoverCodexInbox } from './codex-session.js';
export function launchSessionDrain(home=configDirectory()):number|undefined {
  const child=spawn(process.execPath,[fileURLToPath(new URL('./main.js',import.meta.url)),'session-drain','--home',home],{detached:true,stdio:'ignore',env:{...process.env,COMMON_MEMORY_HOME:home}});
  child.on('error',()=>process.stderr.write('[common-memory] consumer launch failed; run common-memory session-drain.\n'));
  child.unref();
  return child.pid;
}
export async function runSessionDrain(args:string[]):Promise<void> {
  const recoveryIndex=args.indexOf('--recover');
  const recoveryId=recoveryIndex>=0&&recoveryIndex+1<args.length?args[recoveryIndex+1]!:undefined;
  if(recoveryIndex>=0&&!recoveryId)throw new Error('session-drain --recover requires a recovery ID');
  const remaining=recoveryIndex<0?args:[...args.slice(0,recoveryIndex),...args.slice(recoveryIndex+2)];
  const home=remaining.length===0?configDirectory():remaining.length===2&&remaining[0]==='--home'&&isAbsolute(remaining[1]!)?remaining[1]!:null;
  if(!home)throw new Error('session-drain requires [--home <absolute-path>] [--recover <id>]');
  process.env.COMMON_MEMORY_HOME=home;
  const config=loadConfig(join(home,'config.json'));if(!config)throw new Error('UNCONFIGURED');
  if(recoveryId)recoverCodexInbox(config,recoveryId);
  // Run sealed work between inbox admissions so completion watches do not delay maintenance.
  const writer=createConfiguredWriter(config);
  try {
    const host=await consumeCodexInbox(config,async()=>{while((await writer.run()).outcome!=='idle'&&writer.store.hasWork()){ /* next sealed batch */ }});
    const sessionsComplete=await drainSessions(writer);
    if(!host.complete||!sessionsComplete)process.exitCode=1;
  } finally {await writer.close();}
}
