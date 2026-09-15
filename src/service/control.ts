import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { atomicWrite } from '../v2/canonical.js';
import { safeDirectory, withRepositoryLock } from '../v2/lock.js';
import { authenticated, grantIdentity, type ChannelIdentity, type GrantIdentity, type ServiceRequest } from './protocol.js';
import { configDirectory } from '../config/config.js';

export const SERVICE_PROTOCOL = 1;
export interface ServiceControl {
  version: 1; enabled: boolean; dataRoot: string;
  node: string; cli: string; packageVersion: string;
  manager: 'systemd' | 'launchd' | 'wsl-task'; name: string;
  distro?: string; user?: string;
}
export function serviceDirectory(home = configDirectory()) { return join(resolve(home), '.service'); }
export function serviceName(home = configDirectory()) { return `common-memory-${createHash('sha256').update(resolve(home)).digest('hex').slice(0,20)}`; }
export function privateDirectory(path:string):void {
  safeDirectory(path);
  const stat=lstatSync(path);
  if (process.getuid && stat.uid !== process.getuid()) throw new Error('UNSAFE_SERVICE_PATH');
  if ((stat.mode & 0o077) !== 0) chmodSync(path,0o700);
}
export function privateFile(path:string):string {
  const stat=lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || (stat.mode & 0o077)!==0 || process.getuid && stat.uid!==process.getuid()) throw new Error('UNSAFE_SERVICE_PATH');
  return readFileSync(path,'utf8');
}
export function loadServiceControl(home = configDirectory()):ServiceControl|null {
  const path=join(serviceDirectory(home),'control.json');
  if(!existsSync(path))return null;
  const value=JSON.parse(privateFile(path)) as ServiceControl;
  if(value.version!==1 || typeof value.enabled!=='boolean' || ![value.dataRoot,value.node,value.cli].every(p=>typeof p==='string'&&isAbsolute(p)&&!p.includes('\0')) || !['systemd','launchd','wsl-task'].includes(value.manager) || value.name!==serviceName(home))throw new Error('INVALID_SERVICE_CONTROL');
  return value;
}
export function saveServiceControl(value:ServiceControl,home = configDirectory()):void {
  privateDirectory(serviceDirectory(home));
  atomicWrite(join(serviceDirectory(home),'control.json'),JSON.stringify(value)+'\n');
}
export interface ChannelGrant {version:1;id:string;identity:GrantIdentity;secret:string}
export function channelGrantId(identity:ChannelIdentity|GrantIdentity):string {return createHash('sha256').update(JSON.stringify(grantIdentity(identity))).digest('hex');}
function readGrant(id:string,home:string):ChannelGrant {
  if(!/^[a-f0-9]{64}$/.test(id))throw new Error('INVALID_CHANNEL_GRANT');
  const grant=JSON.parse(privateFile(join(serviceDirectory(home),'grants',`${id}.json`))) as ChannelGrant;
  if(grant.version!==1||grant.id!==id||channelGrantId(grant.identity)!==id||!/^[a-f0-9]{64}$/.test(grant.secret))throw new Error('INVALID_CHANNEL_GRANT');
  return grant;
}
export function serviceGrant(identity:ChannelIdentity|GrantIdentity,home=configDirectory()):ChannelGrant {return readGrant(channelGrantId(identity),home);}
/** Only Common Memory management calls this, never an RPC tool's arguments. */
export function provisionServiceGrant(identity:ChannelIdentity|GrantIdentity,home=configDirectory()):ChannelGrant {
  const control=loadServiceControl(home);
  if(!control||!control.enabled&&identity.kind!=='cli')throw new Error('SERVICE_DISABLED');
  privateDirectory(serviceDirectory(home));
  return withRepositoryLock(serviceDirectory(home),()=>{
    const fixed=grantIdentity(identity),id=channelGrantId(fixed),directory=join(serviceDirectory(home),'grants');privateDirectory(directory);
    const path=join(directory,`${id}.json`);
    if(!existsSync(path))atomicWrite(path,JSON.stringify({version:1,id,identity:fixed,secret:randomBytes(32).toString('hex')})+'\n');
    return readGrant(id,home);
  });
}
/** Ignore claimed authority: only the persisted launch grant supplies it. */
export function authorizeServiceRequest(request:ServiceRequest,home=configDirectory()):ChannelIdentity|null {
  try {
    const grant=readGrant(request.grantId,home);
    if(channelGrantId(request.channel)!==grant.id||!authenticated(request,grant.secret))return null;
    if(grant.identity.kind==='pi'){
      const processInstance=request.channel.kind==='pi'?request.channel.processInstance:'';
      return /^[A-Za-z0-9_-]{1,128}$/.test(processInstance)?{kind:'pi',processInstance}:null;
    }
    return grant.identity;
  }catch{return null;}
}
export function socketPath(home = configDirectory()):string {
  // sun_path is small on both Linux and macOS. The per-user private directory is
  // derived from the full home identity, never supplied by a tool argument.
  // A channel's TMP/TMPDIR must not redirect it away from the supervised Core.
  // /private/tmp avoids macOS's /tmp symlink while retaining a short sun_path.
  return join(process.platform==='darwin'?'/private/tmp':'/tmp',`${serviceName(home)}-${process.getuid?.() ?? 'user'}`,'core.sock');
}
