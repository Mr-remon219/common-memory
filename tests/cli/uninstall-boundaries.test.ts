import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, loadConfig, saveConfig } from '../../src/config/config.js';
import { assertNoLiveManagedInstances, assertNoUnmanagedReferences, uninstallCompletely } from '../../src/cli/uninstall.js';
import { applicationRoot } from '../../src/cli/integrations.js';

let root: string, home: string;
beforeEach(() => { root=mkdtempSync(join(tmpdir(),'cm-uninstall-boundaries-'));home=join(root,'home');vi.stubEnv('COMMON_MEMORY_HOME',home);vi.stubEnv('HOME',root);vi.stubEnv('CODEX_HOME',join(root,'codex'));vi.stubEnv('PI_CODING_AGENT_DIR',join(root,'pi'));vi.stubEnv('PATH','');vi.stubEnv('WSL_DISTRO_NAME','');const config=defaultConfig();config.dataRoot=join(root,'data');config.remote.model='synthetic';saveConfig(config);mkdirSync(join(config.dataRoot,'memory'),{recursive:true});writeFileSync(join(home,'.env'),'OPENAI_API_KEY=secret\nOTHER=keep\n'); });
afterEach(()=>{vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});

it('ignores comments and unrelated trust paths but blocks parsed live MCP registrations', () => {
  mkdirSync(join(root,'codex'),{recursive:true});
  writeFileSync(join(root,'codex','config.toml'),'# common_memory historical desktop-test path\n[projects]\n[projects."/x"]\ntrust_level = "trusted"\n');
  mkdirSync(join(root,'pi'),{recursive:true});
  writeFileSync(join(root,'pi','settings.json'),JSON.stringify({trust:{paths:['common-memory historical note']}}));
  expect(()=>assertNoUnmanagedReferences([], undefined, {home, directories:[join(root,'codex'),join(root,'pi')]})).not.toThrow();
  writeFileSync(join(root,'codex','config.toml'),'[mcp_servers.common_memory]\ncommand="/opt/common-memory-core/dist/cli/main.js"\nargs=["mcp"]\n');
  expect(()=>assertNoUnmanagedReferences([], undefined, {home, directories:[join(root,'codex')]})).toThrow('未由此安装器管理');
});


it('blocks a registered live MCP/Pi instance automatically but does not pretend unknown candidates are confirmed', () => {
  expect(() => assertNoLiveManagedInstances([{pid:1,role:'mcp',version:'0.4.1',started:'1',executable:'node',cli:'cli',status:'loaded'}])).toThrow('已确认加载');
  expect(() => assertNoLiveManagedInstances([{pid:2,role:'unknown',version:'unknown',started:'1',executable:'node',cli:'cli',status:'unregistered'}])).not.toThrow();
});

it('can remove app/integrations while retaining configuration and private credentials independently from data', async () => {
  const config=loadConfig()!, installation={node:process.execPath,npm:'/fake/npm',prefix:'/fake',packageRoot:realpathSync(applicationRoot)};
  const result=await uninstallCompletely({config,deleteMemory:false,deleteConfiguration:false,clientsStopped:true,installation,removePackage:async()=>{}});
  expect(result).toEqual(expect.objectContaining({retained:config.dataRoot,configurationRetained:true}));
  expect(loadConfig()).toEqual(config); expect(readFileSync(join(home,'.env'),'utf8')).toContain('OPENAI_API_KEY=secret');
});
