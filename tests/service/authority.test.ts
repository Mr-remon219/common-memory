import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizeServiceRequest, provisionServiceGrant, saveServiceControl, serviceName } from '../../src/service/control.js';
import { authentication, frame, FrameReader, type ServiceRequest, type ChannelIdentity } from '../../src/service/protocol.js';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function setup(){const home=mkdtempSync(join(tmpdir(),'cm-grants-'));roots.push(home);saveServiceControl({version:1,enabled:true,dataRoot:join(home,'data'),node:process.execPath,cli:join(home,'cli.js'),packageVersion:'test',manager:'systemd',name:serviceName(home)},home);return home;}
function request(home:string,identity:ChannelIdentity){const grant=provisionServiceGrant(identity,home),unsigned={protocol:1 as const,id:'request',grantId:grant.id,channel:identity,operation:'queue.status',payload:{}};return {grant,request:{...unsigned,authentication:authentication(grant.secret,unsigned)}};}
it('a channel profile secret cannot forge another role, capability or workspace binding',()=>{
 const home=setup(),identity:ChannelIdentity={kind:'mcp',options:{clientId:'test',global:true,accept:false,workspaces:[],capabilities:['read']}};
 const {grant,request:r}=request(home,identity);expect(authorizeServiceRequest(r,home)).toEqual(identity);
 for(const channel of [{kind:'cli'}, {...identity,options:{...identity.options,accept:true,capabilities:['relay']}},{...identity,options:{...identity.options,workspaces:['/other']}}] as ChannelIdentity[]){const forged={...r,channel};forged.authentication=authentication(grant.secret,forged);expect(authorizeServiceRequest(forged,home)).toBeNull();}
 const altered={...r,payload:{id:'other'}};expect(authorizeServiceRequest(altered,home)).toBeNull();
});
it('Pi process correlation can change without widening the server-owned profile',()=>{
 const home=setup(),{grant,request:r}=request(home,{kind:'pi',processInstance:'first'});const next:ServiceRequest={...r,channel:{kind:'pi',processInstance:'second'}};next.authentication=authentication(grant.secret,next);
 expect(authorizeServiceRequest(next,home)).toEqual({kind:'pi',processInstance:'second'});
 const invalid:ServiceRequest={...r,channel:{kind:'pi',processInstance:'../outside'}};invalid.authentication=authentication(grant.secret,invalid);expect(authorizeServiceRequest(invalid,home)).toBeNull();
});
it('disabled services reject new channel provisioning but retain explicit CLI management access',()=>{
 const home=setup();saveServiceControl({version:1,enabled:false,dataRoot:join(home,'data'),node:process.execPath,cli:join(home,'cli.js'),packageVersion:'test',manager:'systemd',name:serviceName(home)},home);
 expect(()=>provisionServiceGrant({kind:'pi'},home)).toThrow('SERVICE_DISABLED');expect(provisionServiceGrant({kind:'cli'},home).identity).toEqual({kind:'cli'});
});
it('framing reassembles split UTF-8 input and rejects malformed or oversized input without truncation',()=>{
 const wire=frame({text:'汉字🙂'}),reader=new FrameReader();expect(reader.push(wire.subarray(0,7))).toEqual([]);expect(reader.push(wire.subarray(7))).toEqual([{text:'汉字🙂'}]);
 const huge=Buffer.alloc(4);huge.writeUInt32BE(0xffffffff);expect(()=>new FrameReader().push(huge)).toThrow('SERVICE_FRAME_TOO_LARGE');expect(()=>new FrameReader().push(Buffer.from([0,0,0,1,255]))).toThrow();
});
