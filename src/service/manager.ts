import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../v2/sqlite.js';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWrite } from '../v2/canonical.js';
import { configDirectory, loadConfig, type CommonMemoryConfig } from '../config/config.js';
import { ServiceClient } from './client.js';
import { provisionServiceGrant, loadServiceControl, privateDirectory, saveServiceControl, serviceDirectory, serviceName, socketPath, type ServiceControl } from './control.js';

const shell=(value:string)=>`'${value.replaceAll("'","'\"'\"'")}'`;
const xml=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const ps=(value:string)=>`'${value.replaceAll("'","''")}'`;
const unitArgument=(value:string)=>JSON.stringify(value).replaceAll('%','%%').replaceAll('$','$$');
function managementLock(home:string){
  privateDirectory(serviceDirectory(home));const db=openDatabase(join(serviceDirectory(home),'management.sqlite'),{timeout:0});
  try{db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS owner(id INTEGER); BEGIN IMMEDIATE');return db;}catch{db.close();throw new Error('SERVICE_MANAGEMENT_BUSY');}
}
const run=(command:string,args:string[])=>execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000});
export function launcherPath(home=configDirectory()) {return join(serviceDirectory(home),'launch');}
export function managerDefinition(control:ServiceControl,home:string):{path:string;body:string}|null {
  const launcher=launcherPath(home);
  if(control.manager==='systemd')return {path:join(homedir(),'.config/systemd/user',`${control.name}.service`),body:`# Common Memory ${control.name}\n[Unit]\nDescription=Common Memory independent runtime\nStartLimitIntervalSec=0\n[Service]\nType=simple\nExecStart=/bin/sh ${unitArgument(launcher)} service run --home ${unitArgument(home)}\nRestart=on-failure\nRestartSec=2\nKillMode=control-group\nTimeoutStopSec=30\nUMask=0077\n[Install]\nWantedBy=default.target\n`};
  if(control.manager==='launchd')return {path:join(homedir(),'Library/LaunchAgents',`${control.name}.plist`),body:`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${control.name}</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(launcher)}</string><string>service</string><string>run</string><string>--home</string><string>${xml(home)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>2</integer><key>ExitTimeOut</key><integer>30</integer></dict></plist>\n`};
  return null;
}
function powershell(script:string):string {
  const executable='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  return run(executable,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(`[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';${script}`,'utf16le').toString('base64')]);
}
function windowsTask(control:ServiceControl,home:string,action:'install'|'start'|'stop'|'remove'):void {
  const name=ps(control.name),description=ps(`Common Memory service ${control.name}`);
  const check=`$old=Get-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue;if($old -and $old.Description -ne ${description}){throw 'SERVICE_OWNERSHIP_CONFLICT'};`;
  if(action==='install') {
    if(!control.distro||!control.user)throw new Error('WSL_IDENTITY_REQUIRED');
    const quote=(v:string)=>/^[A-Za-z0-9_.:/-]+$/.test(v)?v:`"${v.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')}"`;
    // wsl.exe parses its own raw option prefix: quoting "-d" turns it into
    // a Linux command instead of a WSL option. Quote values, never these flags.
    const args=['-d',quote(control.distro),'-u',quote(control.user),'--exec','/bin/sh',quote(launcherPath(home)),'service','run','--home',quote(home)].join(' ');
    powershell(`${check}$action=New-ScheduledTaskAction -Execute "$env:WINDIR\\System32\\wsl.exe" -Argument ${ps(args)};$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited;$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable;$trigger=New-ScheduledTaskTrigger -AtLogOn -User $principal.UserId;$recovery=New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 1);Register-ScheduledTask -TaskName ${name} -Description ${description} -Action $action -Principal $principal -Settings $settings -Trigger @($trigger,$recovery) -Force | Out-Null;`);
  } else if(action==='start')powershell(`${check}if(!$old){throw 'SERVICE_NOT_INSTALLED'};Enable-ScheduledTask -TaskName ${name}|Out-Null;Start-ScheduledTask -TaskName ${name};`);
  else powershell(`${check}if($old){Disable-ScheduledTask -TaskName ${name}|Out-Null;Stop-ScheduledTask -TaskName ${name};${action==='remove'?`Unregister-ScheduledTask -TaskName ${name} -Confirm:$false;`:''}};exit 0;`);
}
export function wakeService(home=configDirectory()):void {
  if(!loadServiceControl(home)?.enabled)throw new Error('SERVICE_DISABLED');
  const lock=managementLock(home);try{const control=loadServiceControl(home);if(!control?.enabled)throw new Error('SERVICE_DISABLED');startNative(control,home);}finally{lock.close();}
}
function startNative(control:ServiceControl,home:string):void {
  if(control.manager==='systemd')run('systemctl',['--user','start',`${control.name}.service`]);
  else if(control.manager==='wsl-task')windowsTask(control,home,'start');
  else run('launchctl',['kickstart',`gui/${process.getuid!()}/${control.name}`]);
}
export async function installService(config:CommonMemoryConfig,home=configDirectory()):Promise<ServiceControl> {
  home=resolve(home);const lock=managementLock(home);try{return await installUnlocked(config,home);}finally{lock.close();}
}
async function installUnlocked(config:CommonMemoryConfig,home:string):Promise<ServiceControl> {
  const prior=loadServiceControl(home);
  if(prior?.enabled)await stopUnlocked(home);
  const wsl=process.platform==='linux'&&(Boolean(process.env.WSL_DISTRO_NAME)||/microsoft/i.test(readFileSync('/proc/sys/kernel/osrelease','utf8')));
  const manager=process.platform==='darwin'?'launchd':process.platform==='linux'?(wsl?'wsl-task':'systemd'):null;
  if(!manager)throw new Error('CORE_PLATFORM_UNSUPPORTED');
  const distro=process.env.WSL_DISTRO_NAME??prior?.distro;if(manager==='wsl-task'&&!distro)throw new Error('WSL_IDENTITY_REQUIRED');
  const cli=fileURLToPath(new URL('../cli/main.js',import.meta.url));
  const packageVersion=(JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')) as {version:string}).version;
  const control:ServiceControl={version:1,enabled:false,dataRoot:config.dataRoot,node:process.execPath,cli,packageVersion,manager,name:serviceName(home),...(manager==='wsl-task'?{distro:distro!,user:userInfo().username}:{})};
  privateDirectory(serviceDirectory(home));
  const launcher=launcherPath(home),log=join(serviceDirectory(home),'core.log');
  if(!existsSync(log))atomicWrite(log,'');
  atomicWrite(launcher,`#!/bin/sh\n# Common Memory stable entry\numask 077\nif [ "\${1-}" = service ] && [ "\${2-}" = run ]; then exec >> ${shell(log)} 2>&1; fi\nexec ${shell(control.node)} ${shell(control.cli)} "$@"\n`);chmodSync(launcher,0o700);
  saveServiceControl(control,home);provisionServiceGrant({kind:'cli'},home);
  const definition=managerDefinition(control,home);
  if(definition){
    const old=prior?managerDefinition(prior,home):null;
    if(existsSync(definition.path)&&(!old||readFileSync(definition.path,'utf8')!==old.body))throw new Error('SERVICE_OWNERSHIP_CONFLICT');
    privateDirectory(dirname(definition.path));atomicWrite(definition.path,definition.body);
    if(manager==='systemd'){run('systemctl',['--user','daemon-reload']);run('systemctl',['--user','enable',`${control.name}.service`]);}
    else {try{run('launchctl',['bootout',`gui/${process.getuid!()}/${control.name}`]);}catch{}run('launchctl',['enable',`gui/${process.getuid!()}/${control.name}`]);run('launchctl',['bootstrap',`gui/${process.getuid!()}`,definition.path]);}
  } else windowsTask(control,home,'install');
  control.enabled=true;saveServiceControl(control,home);
  try {startNative(control,home);await waitService(home,true);}catch(error){control.enabled=false;saveServiceControl(control,home);throw error;}
  return control;
}
async function waitService(home:string,online:boolean):Promise<void> {
  const deadline=Date.now()+30000,client=new ServiceClient({kind:'cli'},home);
  while(Date.now()<deadline){
    try {await client.call('service.status',{}, {wake:false,timeoutMs:500});if(online)return;}
    catch {if(!online&&!existsSync(socketPath(home)))return;}
    await delay(100);
  }
  throw new Error(online?'SERVICE_START_TIMEOUT':'SERVICE_STOP_TIMEOUT');
}
export async function stopService(home=configDirectory(),remove=false):Promise<void> {
  if(!loadServiceControl(home))return;
  const lock=managementLock(home);try{await stopUnlocked(home,remove);}finally{lock.close();}
}
async function stopUnlocked(home:string,remove=false):Promise<void> {
  const control=loadServiceControl(home);if(!control)return;
  control.enabled=false;saveServiceControl(control,home);
  try {await new ServiceClient({kind:'cli'},home).call('service.stop',{}, {wake:false,timeoutMs:2000});}catch { /* Native manager owns crash/stale-process cleanup below. */ }
  // Await graceful handoff before asking Task Scheduler to terminate its wsl.exe.
  // This transaction lock is released by the kernel on crash; PIDs are not proof.
  const ownerPath=join(control.dataRoot,'runtime/service-owner.sqlite');
  if(existsSync(ownerPath)){const db=openDatabase(ownerPath,{timeout:30000});try{db.exec('BEGIN IMMEDIATE; ROLLBACK');}finally{db.close();}}
  // Disable external supervision as well as admission. Only our exact named unit
  // is stopped; no Agent host or arbitrary process tree is signalled.
  if(control.manager==='wsl-task')windowsTask(control,home,remove?'remove':'stop');
  else if(control.manager==='systemd')run('systemctl',['--user','disable','--now',`${control.name}.service`]);
  else {run('launchctl',['disable',`gui/${process.getuid!()}/${control.name}`]);try{run('launchctl',['bootout',`gui/${process.getuid!()}/${control.name}`]);}catch{}}
  if(remove){const definition=managerDefinition(control,home);if(definition&&existsSync(definition.path)){if(readFileSync(definition.path,'utf8')!==definition.body)throw new Error('SERVICE_OWNERSHIP_CONFLICT');unlinkSync(definition.path);if(control.manager==='systemd')run('systemctl',['--user','daemon-reload']);}}
}
export async function serviceCommand(args:string[]):Promise<void> {
  const [action,...tail]=args,rest=action==='grant'?tail.slice(1):tail;const home=rest.length===2&&rest[0]==='--home'?resolve(rest[1]!):rest.length===0?configDirectory():null;
  if(!home)throw new Error('service requires <start|stop|status|wake|remove|run> [--home path]');
  process.env.COMMON_MEMORY_HOME=home;
  if(action==='grant'){if(!tail[0]||!/^[A-Za-z0-9_-]+$/.test(tail[0]))throw new Error('INVALID_CHANNEL_GRANT');provisionServiceGrant(JSON.parse(Buffer.from(tail[0],'base64url').toString('utf8')),home);return;}
  if(action==='run'){await (await import('./daemon.js')).runService(home);return;}
  if(action==='wake'){wakeService(home);return;}
  if(action==='stop'||action==='remove'){await stopService(home,action==='remove');return;}
  if(action==='start'){const config=loadConfig(join(home,'config.json'));if(!config)throw new Error('UNCONFIGURED');console.log(JSON.stringify(await installService(config,home)));return;}
  if(action==='status'){console.log(JSON.stringify(await new ServiceClient({kind:'cli'},home).call('service.status',{}, {wake:false})));return;}
  throw new Error('UNKNOWN_SERVICE_COMMAND');
}
