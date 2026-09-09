import { readFileSync, readlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { execFileSync } from 'node:child_process';

/** A bridge supplies the native host's PID and creation time, never its own PID. */
export function hostProcessInstance(): string {
  const bridge=process.env.COMMON_MEMORY_HOST_INSTANCE;
  if(bridge){if(!/^windows:\d+:\d+$/.test(bridge))throw new Error('INVALID_HOST_INSTANCE');return bridge;}
  let pid=process.ppid;
  for(let depth=0;pid>1&&depth<32;depth++) {
    if(process.platform==='linux') {
      const stat=readFileSync(`/proc/${pid}/stat`,'utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
      const exe=basename(readlinkSync(`/proc/${pid}/exe`));
      if(/^codex(?:-|$)/.test(exe))return `${readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()}:${pid}:${fields[19]}`;
      pid=Number(fields[1]);
    } else if(process.platform==='darwin') {
      const output=execFileSync('/bin/ps',['-p',String(pid),'-o','ppid=,lstart=,comm='],{encoding:'utf8'}).trim();
      const match=/^(\d+)\s+(.{24})\s+(.+)$/.exec(output);
      if(!match)throw new Error('CODEX_HOST_PROCESS_UNCONFIRMED');
      if(/^codex(?:-|$)/.test(basename(match[3]!)))return `darwin:${pid}:${match[2]}`;
      pid=Number(match[1]);
    } else throw new Error('CODEX_PROCESS_IDENTITY_UNSUPPORTED');
  }
  throw new Error('CODEX_HOST_PROCESS_UNCONFIRMED');
}
