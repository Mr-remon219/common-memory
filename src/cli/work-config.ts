import { execFileSync } from 'node:child_process';
import { loadConfig, configDirectory, type CommonMemoryConfig } from '../config/config.js';
import { ProjectRegistry } from '../v2/registry.js';
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, win32 } from 'node:path';
import { runtimeLaunch, shellQuote, type LaunchOptions } from './host-launch.js';
import type { HostClient } from './codex-session.js';
const psQuote=(s:string)=>"'"+s.replaceAll("'","''")+"'";

// Windows PowerShell 5.1 rewrites native argv (including trailing backslashes).
// Use the Windows CRT quoting rules explicitly with ProcessStartInfo instead.
// https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments
const windowsProcess = String.raw`
function Quote-NativeArgument([string]$Value) {
  if($Value.Length -gt 0 -and $Value -notmatch '[\s"]'){return $Value}
  $escaped=[regex]::Replace($Value,'(\\*)"', {param($m) ('\' * (2*$m.Groups[1].Length+1))+'"'})
  $escaped=[regex]::Replace($escaped,'(\\+)$', {param($m) '\' * (2*$m.Groups[1].Length)})
  return '"'+$escaped+'"'
}
function Invoke-Wsl([string[]]$Arguments, [string]$Body='') {
  $info=[System.Diagnostics.ProcessStartInfo]::new()
  $info.FileName=$wsl
  $info.Arguments=($Arguments | ForEach-Object { Quote-NativeArgument $_ }) -join ' '
  $info.UseShellExecute=$false
  $info.RedirectStandardInput=$true
  $info.RedirectStandardOutput=$true
  $info.RedirectStandardError=$true
  $info.StandardOutputEncoding=[System.Text.UTF8Encoding]::new($false)
  $info.StandardErrorEncoding=[System.Text.UTF8Encoding]::new($false)
  $child=[System.Diagnostics.Process]::new()
  $child.StartInfo=$info
  $started=$false
  try {
    $started=$child.Start()
    $stdout=$child.StandardOutput.ReadToEndAsync()
    $stderr=$child.StandardError.ReadToEndAsync()
    $bytes=[System.Text.Encoding]::UTF8.GetBytes($Body)
    $child.StandardInput.BaseStream.Write($bytes,0,$bytes.Length)
    $child.StandardInput.Close()
    $child.WaitForExit()
    [Console]::Error.Write($stderr.GetAwaiter().GetResult())
    return @{Code=$child.ExitCode;Output=$stdout.GetAwaiter().GetResult()}
  } finally {
    if($started -and !$child.HasExited){$child.Kill();$child.WaitForExit()}
    $child.Dispose()
  }
}
`;

/** Generated native bridge retains the long-lived host identity across WSL invocations. */
export function renderWindowsBridge(options:LaunchOptions,env:NodeJS.ProcessEnv=process.env):string {
  const r=runtimeLaunch(options,env);
  return `param([ValidateSet('work-hook','codex-hook','session-refresh')][string]$Action='work-hook', [string]$Client='chatgpt-work')
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
$ancestor=Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
$hostIdentity=$null
for($depth=0;$depth -lt 32 -and $ancestor.ParentProcessId -gt 0;$depth++) {
  $ancestor=Get-CimInstance Win32_Process -Filter "ProcessId=$($ancestor.ParentProcessId)"
  if($ancestor.Name -match '^codex(?:-|\\.exe$)') {
    $hostIdentity="windows:$($ancestor.ProcessId):$($ancestor.CreationDate.ToUniversalTime().Ticks)"
    break
  }
}
if(!$hostIdentity){throw 'CODEX_HOST_PROCESS_UNCONFIRMED'}
$wsl=${psQuote(r.wslExe)}
${windowsProcess}$prefix=@(${['-d',r.distro!,'-u',r.user,'-e'].map(psQuote).join(',')})
$launch=@('/usr/bin/env',${psQuote('COMMON_MEMORY_HOME='+r.home)},"COMMON_MEMORY_HOST_INSTANCE=$hostIdentity", "CODEX_THREAD_ID=$env:CODEX_THREAD_ID",${psQuote(r.node)},${psQuote(r.cli)},$Action,'--home',${psQuote(r.home)})
if($Action -eq 'session-refresh') {
  $result=Invoke-Wsl -Arguments ($prefix+$launch+@('--client',$Client))
} else {
  $event=[Console]::In.ReadToEnd() | ConvertFrom-Json
  foreach($field in @('cwd','transcript_path')) {
    $path=$event.$field
    if($path -notmatch '^/') {
      $converted=Invoke-Wsl -Arguments ($prefix+@('/usr/bin/wslpath','-u',$path))
      if($converted.Code -ne 0){throw 'WSL_PATH_CONVERSION_FAILED'}
      $event.$field=$converted.Output.Trim()
    }
  }
  $result=Invoke-Wsl -Arguments ($prefix+$launch) -Body ($event | ConvertTo-Json -Compress -Depth 100)
}
[Console]::Write($result.Output)
exit $result.Code
`;
}
export function renderHostConfig(client:HostClient,options:LaunchOptions,env:NodeJS.ProcessEnv=process.env,bridgePath?:string):{config:string;skill:string;policy:string;bridge?:string} {
  if(!options.wsl&&!['linux','darwin'].includes(process.platform))throw new Error('Select a supported POSIX runtime or Windows-to-WSL mode');
  const r=runtimeLaunch(options,env);
  if(options.wsl&&(!bridgePath||!win32.isAbsolute(bridgePath)||/["\r\n]/.test(bridgePath)))throw new Error('--bridge-path requires the absolute Windows destination of the generated launcher');
  const command=(action:string)=> {
    if(!options.wsl)return [r.node,r.cli,action,'--home',r.home,...(action==='session-refresh'?['--client',client]:[])].map(shellQuote).join(' ');
    // Encode the PowerShell expression so neither cmd nor PowerShell expands path metacharacters.
    const expression=`& ${psQuote(bridgePath!)} -Action ${action} -Client ${client}; exit $LASTEXITCODE`;
    return `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -EncodedCommand ${Buffer.from(expression,'utf16le').toString('base64')}`;
  };
  const lines=['# Review commands and establish host trust with /hooks. Regenerate after moving this runtime.','[features]','hooks = true',''];
  for(const event of ['SessionStart','UserPromptSubmit','PostToolUse','Stop','Interrupt','SessionEnd'])lines.push(`[[hooks.${event}]]`,`[[hooks.${event}.hooks]]`,'type = "command"',`command = ${JSON.stringify(command(client==='codex'?'codex-hook':'work-hook'))}`,'async = false','timeout = 3','additionalContextLimit = 0','');
  for(const [name,id,capability] of [['common_memory',client==='codex'?'codex-cli':'chatgpt-work','read'],['common_memory_init','chatgpt-desktop','init']]) {
    lines.push(`[mcp_servers.${name}]`);
    if(client==='codex'&&capability==='init'){lines.push('enabled = false','');continue;}
    const launch=r.command(['mcp','--client-id',id!,'--capability',capability!,'--global',...(capability==='read'?(options.workspaces??[]).flatMap(w=>['--workspace',w]):[])]);
    lines.push(`command = ${JSON.stringify(launch.command)}`,`args = ${JSON.stringify(launch.args)}`,...(launch.env?[`env = { COMMON_MEMORY_HOME = ${JSON.stringify(r.home)} }`]:[]),`default_tools_approval_mode = "${capability==='init'?'approve':'auto'}"`,'');
  }
  return {config:lines.join('\n'),skill:`---\nname: memory-refresh\ndescription: Explicitly replace this activation's frozen Common Memory snapshot with currently authorized memory.\n---\n\nRun this exact local command when the user invokes /memory-refresh:\n\n\`\`\`sh\n${command('session-refresh')}\n\`\`\`\n\nReport a command failure. Success queues the new snapshot for PostToolUse or the next UserPromptSubmit. Do not call memory_init or reset session state.\n`,policy:'policy:\n  allow_implicit_invocation: false\n',...(options.wsl?{bridge:renderWindowsBridge(options,env)}:{})};
}
export function prepareHostBundle(config:CommonMemoryConfig,args:string[],client:HostClient='chatgpt-work') {
  let output:string|undefined,mode:string|undefined,bridgePath:string|undefined;
  const options:LaunchOptions={wsl:false};
  for(let i=0;i<args.length;i++){
    const arg=args[i]!,value=args[++i];if(!value||value.startsWith('--'))throw new Error(`${arg} requires a value`);
    if(arg==='--output')output=value;else if(arg==='--mode')mode=value;else if(arg==='--distro')options.distro=value;else if(arg==='--user')options.user=value;else if(arg==='--bridge-path')bridgePath=value;else if(arg==='--wsl-exe')options.wslExe=value;else if(arg==='--workspace'){if(!isAbsolute(value))throw new Error('--workspace requires an absolute runtime path');(options.workspaces??=[]).push(value);}else throw new Error(`Unknown work-config option ${arg}`);
  }
  if(!['posix','windows-wsl'].includes(mode??''))throw new Error('Select --mode posix (agent and runtime in the same environment) or --mode windows-wsl (native Windows agent); terminal and WSL_DISTRO_NAME do not identify the agent');
  if(!output||!isAbsolute(output))throw new Error('--output <absolute-directory> is required');
  for(const workspace of options.workspaces??[])if(!new ProjectRegistry(config.dataRoot).resolve(workspace))throw new Error(`UNREGISTERED_WORKSPACE: ${workspace}`);
  options.wsl=mode==='windows-wsl';
  if(options.wsl&&!bridgePath)bridgePath=execFileSync('/usr/bin/wslpath',['-w',join(output,'common-memory-bridge.ps1')],{encoding:'utf8'}).trim();
  const bundle=renderHostConfig(client,options,process.env,bridgePath);
  return {output,bundle};
}

/** Preflight the entire bundle before writing. Existing directories remain supported by the CLI. */
export function writeHostBundle(output:string,bundle:ReturnType<typeof renderHostConfig>):void {
  if(!isAbsolute(output))throw new Error('Bundle output must be absolute');
  const files:[string,string][]=[['common-memory.config.toml',bundle.config],['skills/memory-refresh/SKILL.md',bundle.skill],['skills/memory-refresh/agents/openai.yaml',bundle.policy],...(bundle.bridge?[[ 'common-memory-bridge.ps1',bundle.bridge] as [string,string]]:[])];
  const stat=(path:string)=>{try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}};
  for(const directory of [output,join(output,'skills'),join(output,'skills/memory-refresh'),join(output,'skills/memory-refresh/agents')]){
    const existing=stat(directory);if(existing&&(!existing.isDirectory()||existing.isSymbolicLink()))throw new Error(`Unsafe bundle directory: ${directory}`);
  }
  for(const [path] of files)if(stat(join(output,path)))throw new Error(`Bundle file already exists: ${join(output,path)}`);
  mkdirSync(dirname(output),{recursive:true,mode:0o700});
  mkdirSync(join(output,'skills/memory-refresh/agents'),{recursive:true,mode:0o700});
  for(const [path,body] of files)writeFileSync(join(output,path),path.endsWith('.ps1')?'\ufeff'+body:body,{flag:'wx',mode:0o600});
}

export function runWorkConfig(args:string[],client:HostClient='chatgpt-work'):void {
  const config=loadConfig(join(configDirectory(),'config.json'));if(!config)throw new Error('Run common-memory config first');
  const {output,bundle}=prepareHostBundle(config,args,client);
  writeHostBundle(output,bundle);
  process.stdout.write(`Generated configuration and explicit refresh skill in ${output}. Review before installing in the agent configuration directory.\n`);
}
