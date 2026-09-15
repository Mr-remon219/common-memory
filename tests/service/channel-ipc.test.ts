import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { ServiceClient } from '../../src/service/client.js';
import { authorizeServiceRequest, provisionServiceGrant, saveServiceControl, serviceName, socketPath } from '../../src/service/control.js';
import { frame, FrameReader, type ServiceRequest } from '../../src/service/protocol.js';

describe('service channel IPC',()=>{it('preserves a stable request across an uncertain response retry',async()=>{
  const home=mkdtempSync(join(tmpdir(),'cm-channel-ipc-')),dataRoot=join(home,'data');mkdirSync(dataRoot,{mode:0o700});chmodSync(home,0o700);
  saveServiceControl({version:1,enabled:true,dataRoot,node:process.execPath,cli:join(home,'unused.mjs'),packageVersion:'test',manager:'systemd',name:serviceName(home)},home);
  provisionServiceGrant({kind:'mcp',options:{clientId:'test-client',capabilities:['relay'],global:false,accept:false,workspaces:[]}},home);
  const path=socketPath(home);mkdirSync(dirname(path),{recursive:true,mode:0o700});const requests:ServiceRequest[]=[];
  const server=createServer(socket=>{const reader=new FrameReader();socket.on('data',chunk=>{for(const value of reader.push(chunk)){const request=value as ServiceRequest;requests.push(request);expect(authorizeServiceRequest(request,home)).toEqual({kind:'mcp',options:{clientId:'test-client',capabilities:['relay'],global:false,accept:false,workspaces:[]}});if(requests.length===1)socket.destroy();else socket.end(frame({protocol:1,id:request.id,ok:true,result:{accepted:true}}));}});});
  await new Promise<void>((resolve,reject)=>server.listen(path,resolve).once('error',reject));
  const client=new ServiceClient({kind:'mcp',options:{clientId:'test-client',capabilities:['relay'],global:false,accept:false,workspaces:[]}},home),options={requestId:'stable-request-1',wake:false,timeoutMs:1000} as const;
  await expect(client.call('mcp.submit',{submissionId:'s'},options)).rejects.toThrow(/DELIVERY_UNCERTAIN/);
  expect(await client.call('mcp.submit',{submissionId:'s'},options)).toEqual({accepted:true});
  expect(requests).toHaveLength(2);expect(requests[0]!.id).toBe(requests[1]!.id);expect(requests[0]!.authentication).toBe(requests[1]!.authentication);
  await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(home,{recursive:true,force:true});rmSync(dirname(path),{recursive:true,force:true});
});

it('fixes Pi grant authority to the channel kind',()=>{
  const home=mkdtempSync(join(tmpdir(),'cm-pi-grant-')),dataRoot=join(home,'data');mkdirSync(dataRoot,{mode:0o700});chmodSync(home,0o700);
  saveServiceControl({version:1,enabled:true,dataRoot,node:process.execPath,cli:join(home,'unused.mjs'),packageVersion:'test',manager:'systemd',name:serviceName(home)},home);const grant=provisionServiceGrant({kind:'pi'},home);
  expect(grant.identity.kind).toBe('pi');rmSync(home,{recursive:true,force:true});
});});
