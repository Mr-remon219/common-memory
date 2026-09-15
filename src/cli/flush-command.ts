import type { CommonMemoryConfig } from '../config/config.js';
import { ServiceClient } from '../service/client.js';
import { setTimeout as delay } from 'node:timers/promises';

interface QueueStatus {observations:{state:string;count:number}[];jobStates:{state:string;count:number}[];host:{complete:boolean}}
/** Request service processing and wait locally. Ctrl+C stops only this wait, never accepted work. */
export async function runFlush(_config:CommonMemoryConfig,log:(line:string)=>void=console.log):Promise<number>{
  const client=new ServiceClient({kind:'cli'}),controller=new AbortController(),cancel=()=>controller.abort();process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  try{
    await client.call('queue.flush',{}, {requestId:`flush-${Date.now()}`});
    while(!controller.signal.aborted){
      const status=await client.call<QueueStatus>('queue.status',{}, {wake:false,signal:controller.signal});
      const active=status.observations.some(row=>['pending','claimed'].includes(row.state))||status.jobStates.some(row=>['running','retry'].includes(row.state));
      if(!active){const failure=status.observations.find(row=>['buffered','paused','dead','quarantined'].includes(row.state));const failed=Boolean(failure)||!status.host.complete;log(JSON.stringify({outcome:failure?.state??(failed?'incomplete':'idle')}));return failed?1:0;}
      await delay(250,undefined,{signal:controller.signal});
    }
    return 1;
  }catch(error){if(controller.signal.aborted)return 1;throw error;}finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);}
}
