import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { configDirectory } from '../config/config.js';
export const shellQuote=(value:string)=>"'"+value.replaceAll("'","'\"'\"'")+"'";
export interface LaunchOptions { wsl:boolean; distro?:string|undefined; user?:string|undefined; wslExe?:string|undefined; workspaces?:string[] }
export function runtimeLaunch(options:LaunchOptions,env:NodeJS.ProcessEnv=process.env) {
  const node=realpathSync(process.execPath),cli=realpathSync(process.argv[1]??fileURLToPath(new URL('./main.js',import.meta.url))),home=configDirectory(env);
  const distro=options.distro??env.WSL_DISTRO_NAME,user=options.user??userInfo().username;
  if(options.wsl&&(process.platform!=='linux'||!distro))throw new Error('--wsl requires a Linux runtime and a fixed --distro');
  const wslExe=options.wslExe??'C:\\Windows\\System32\\wsl.exe';
  if(options.wsl&&!/^[A-Za-z]:\\/.test(wslExe))throw new Error('wsl.exe must be an absolute Windows path');
  return {node,cli,home,distro,user,wslExe,command(args:string[]){return options.wsl?{command:wslExe,args:['-d',distro!,'-u',user,'-e','/usr/bin/env',`COMMON_MEMORY_HOME=${home}`,node,cli,...args]}:{command:node,args:[cli,...args],env:{COMMON_MEMORY_HOME:home}};}};
}
