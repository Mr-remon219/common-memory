import { createServer, type Socket } from 'node:net';
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig, defaultConfig, configDirectory, type CommonMemoryConfig } from '../config/config.js';
import { createConfiguredWriter } from '../config/runtime.js';
import { openDatabase } from '../v2/sqlite.js';
import { consumeCodexInbox } from '../cli/host-session.js';
import { SERVICE_PROTOCOL, authorizeServiceRequest, loadServiceControl, socketPath, privateDirectory } from './control.js';
import { validRequest, frame, FrameReader, type ChannelIdentity, type ServiceRequest, type ServiceResponse } from './protocol.js';
import { dispatchOperation, replayOperation, type ServiceJournal } from './operations.js';

const safeCodes=new Set(['CONFIGURATION','SERVICE_DISABLED','SERVICE_FORBIDDEN','SERVICE_PROTOCOL_MISMATCH','SUBMISSION_CONFLICT','INVALID_SERVICE_REQUEST','INVALID_SUBMISSION_ID','INVALID_SESSION_IDENTITY','INVALID_TEXT_SIZE','CONTEXT_UNAVAILABLE','SUBMISSION_DISABLED','INIT_DISABLED','IMPORT_DISABLED','READ_DISABLED','STATUS_UNAVAILABLE','ADJUSTMENT_DISABLED','CAPTURE_NOT_AUTHORIZED','SENSITIVE_CONTENT_REJECTED','INVALID_IMPORT_LABEL','INVALID_IMPORT_BASIS','INVALID_IMPORT_AUTHOR','IMPORT_CHUNK_TOO_LARGE','UNREGISTERED_WORKSPACE','RETRY_UNAVAILABLE','TASK_UNAVAILABLE','CANCELLED','DELIVERY_UNCERTAIN','SESSION_REFRESH_IDENTITY_REQUIRED','SESSION_REFRESH_ACTIVATION_REQUIRED','CODEX_RECOVERY_UNAVAILABLE','SERVICE_CONFIGURATION_CHANGED']);
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const journalled=new Set(['mcp.submit','mcp.init','pi.start','pi.input','pi.delivered','pi.bind','pi.context','pi.cancel-inputs','pi.settled','pi.end','pi.import','pi.ui.import','pi.ui.adjust','pi.flush','pi.ui.retry','pi.ui.cancel','hook.event','hook.refresh','queue.flush','queue.retry','host.recover','edit.submit','document.import','task.cancel']);

/** One foreground Core process. An OS manager, never an Agent host, owns it. */
export async function runService(home=configDirectory()):Promise<void> {
  process.env.COMMON_MEMORY_HOME=home;
  const loadedControl=loadServiceControl(home);if(!loadedControl?.enabled)return;
  const control=loadedControl;
  privateDirectory(join(control.dataRoot,'runtime'));
  const ownerPath=join(control.dataRoot,'runtime/service-owner.sqlite');
  for(const suffix of ['', '-journal','-wal','-shm'])if(existsSync(ownerPath+suffix)){const s=lstatSync(ownerPath+suffix);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw new Error('UNSAFE_SERVICE_PATH');}
  const owner=openDatabase(ownerPath,{timeout:0});
  try {owner.exec('PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS owner(id INTEGER); BEGIN IMMEDIATE');}
  catch {owner.close();throw new Error('SERVICE_ALREADY_RUNNING');}
  let writer:ReturnType<typeof createConfiguredWriter>|undefined;
  const path=socketPath(home),sockets=new Set<Socket>();
  let stopping=false,running:Promise<unknown>|undefined;
  const execution=new AbortController();let taskExecution=new AbortController();
  let wake:()=>void=()=>{};
  const signalStop=()=>{stopping=true;execution.abort(new Error('SERVICE_HANDOFF'));wake();};
  const server=createServer(socket=>{
    sockets.add(socket);const reader=new FrameReader();socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.setTimeout(10000,()=>socket.destroy());
    socket.on('data',chunk=>{
      try {for(const value of reader.push(chunk))void respond(socket,value);}
      catch{socket.destroy();}
    });
  });
  async function respond(socket:Socket,value:unknown):Promise<void>{
    if(!validRequest(value)){socket.destroy();return;}
    const identity=authorizeServiceRequest(value,home);if(!identity){socket.end(frame({protocol:SERVICE_PROTOCOL,id:value.id,ok:false,code:'SERVICE_FORBIDDEN'}));return;}
    const request:ServiceRequest={...value,channel:identity};let response:ServiceResponse;
    try {
      if(request.operation==='service.status')response={protocol:SERVICE_PROTOCOL,id:request.id,ok:true,result:{pid:process.pid,protocol:SERVICE_PROTOCOL,packageVersion:control.packageVersion,enabled:loadServiceControl(home)?.enabled===true,active:Boolean(running)}};
      else if(request.operation==='service.stop') {if(request.channel.kind!=='cli')throw new Error('SERVICE_FORBIDDEN');signalStop();response={protocol:SERVICE_PROTOCOL,id:request.id,ok:true,result:{stopping:true}};}
      else {
        if(stopping||!loadServiceControl(home)?.enabled)throw new Error('SERVICE_DISABLED');
        let config:CommonMemoryConfig|null=null;try{config=loadConfig(join(home,'config.json'));}catch{}
        if(!config||config.dataRoot!==control.dataRoot)throw new Error('CONFIGURATION');
        const outcome=dispatch(request,identity,config);
        if(outcome.cancelActive)taskExecution.abort(new Error('CANCELLED'));
        response={protocol:SERVICE_PROTOCOL,id:request.id,ok:true,result:outcome.result};
        if(outcome.wake)wake();
      }
    }catch(error){const code=error instanceof Error&&safeCodes.has(error.message)?error.message:'MEMORY_UNAVAILABLE';response={protocol:SERVICE_PROTOCOL,id:request.id,ok:false,code};}
    if(!socket.destroyed)socket.end(frame(response));
  }
  function dispatch(request:ServiceRequest,channel:ChannelIdentity,config:CommonMemoryConfig){
    const store=writer!.store;
    if(!journalled.has(request.operation))return dispatchOperation(store,request,channel,config,home);
    return store.transaction(()=>{
      const key=`${digest(channel)}:${request.id}`,hash=digest([request.operation,request.payload]);
      const prior=store.db.prepare('SELECT digest,result FROM service_requests WHERE id=?').get(key);
      if(prior){if(prior.digest!==hash)throw new Error('SUBMISSION_CONFLICT');const journal=JSON.parse(String(prior.result)) as ServiceJournal;return {result:replayOperation(store,journal,config),journal};}
      const outcome=dispatchOperation(store,request,channel,config,home);
      store.db.prepare('INSERT INTO service_requests(id,digest,result) VALUES(?,?,?)').run(key,hash,JSON.stringify(outcome.journal));
      return outcome;
    });
  }
  try {
    let config:CommonMemoryConfig|null=null;try{config=loadConfig(join(home,'config.json'));}catch{}
    if(!config||config.dataRoot!==control.dataRoot){config=defaultConfig({COMMON_MEMORY_HOME:home});config.dataRoot=control.dataRoot;config.disclosure.allowedScopes=[];config.writableScopes=[];}
    writer=createConfiguredWriter(config);
    writer.store.db.exec('CREATE TABLE IF NOT EXISTS service_requests(id TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT NOT NULL)');
    privateDirectory(dirname(path));
    if(existsSync(path)){const stat=lstatSync(path);if(!stat.isSocket()||process.getuid&&stat.uid!==process.getuid())throw new Error('UNSAFE_SERVICE_PATH');unlinkSync(path);}
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,()=>{server.off('error',reject);chmodSync(path,0o600);resolve();});});
    process.once('SIGINT',signalStop);process.once('SIGTERM',signalStop);
    while(!stopping){
      if(!loadServiceControl(home)?.enabled){signalStop();break;}
      // Ingress uses current authorization; an active Writer retains its own frozen
      // model/credential snapshot until its task ends. Saving never restarts it.
      let current:CommonMemoryConfig|null=null;try{current=loadConfig(join(home,'config.json'));}catch{}
      if(current?.dataRoot===control.dataRoot){running=consumeCodexInbox(current,async()=>{}, {singlePass:true,store:writer.store});await running;running=undefined;}
      if(stopping)break;
      taskExecution=new AbortController();
      running=writer.run({signal:AbortSignal.any([execution.signal,taskExecution.signal])});const result=await running as {outcome:string};running=undefined;
      if(['committed','ignored','quarantined','noop'].includes(result.outcome))continue;
      await new Promise<void>(resolve=>{const timer=setTimeout(resolve,500);wake=()=>{clearTimeout(timer);resolve();};});
    }
  } finally {
    signalStop();process.off('SIGINT',signalStop);process.off('SIGTERM',signalStop);
    await Promise.resolve(running).catch(()=>{});await writer?.close();
    for(const socket of sockets)socket.destroy();
    if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(existsSync(path)&&lstatSync(path).isSocket())unlinkSync(path);
    owner.close();
  }
}
