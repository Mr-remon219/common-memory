import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { configDirectory } from '../config/config.js';
import { ServiceClient } from '../service/client.js';
import { wakeService } from '../service/manager.js';

/** Compatibility wake: never spawns a Writer in the host process. */
export function launchSessionDrain(home=configDirectory()):undefined{try{wakeService(home);}catch{process.stderr.write('[common-memory] service wake failed; inspect common-memory status.\n');}return undefined;}
export async function runSessionDrain(args:string[]):Promise<void>{
  const recoveryIndex=args.indexOf('--recover'),recoveryId=recoveryIndex>=0&&recoveryIndex+1<args.length?args[recoveryIndex+1]:undefined;if(recoveryIndex>=0&&!recoveryId)throw new Error('session-drain --recover requires a recovery ID');const remaining=recoveryIndex<0?args:[...args.slice(0,recoveryIndex),...args.slice(recoveryIndex+2)];const home=remaining.length===0?configDirectory():remaining.length===2&&remaining[0]==='--home'&&isAbsolute(remaining[1]!)?remaining[1]!:null;if(!home)throw new Error('session-drain requires [--home <absolute-path>] [--recover <id>]');
  const client=new ServiceClient({kind:'cli'},home);if(recoveryId)await client.call('host.recover',{id:recoveryId},{requestId:`host-recover-${recoveryId}`});await client.call('queue.flush',{}, {requestId:`drain-${Date.now()}`});
  const deadline=Date.now()+60000;while(Date.now()<deadline){const status=await client.call<{observations:{state:string;count:number}[];jobStates:{state:string;count:number}[];host:{complete:boolean}}>('queue.status',{}, {wake:false});const active=status.observations.some(row=>['pending','claimed'].includes(row.state))||status.jobStates.some(row=>['running','retry'].includes(row.state));if(!active){if(!status.host.complete||status.observations.some(row=>['buffered','paused','dead','quarantined'].includes(row.state)))process.exitCode=1;return;}await delay(250);}process.exitCode=1;
}
