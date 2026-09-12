import { execFileSync } from 'node:child_process';
import { stubInstalledBuild } from '../helpers/installation-build.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installIntegrations, integrationHealth, readInstallationState, reconcileIntegrations, removeIntegrations } from '../../src/cli/integrations.js';
import { installationTransaction, readInstallationFile, writeInstallationFile } from '../../src/cli/installation-files.js';
import { scanIntegrationTargets, type IntegrationTarget } from '../../src/cli/integration-targets.js';

vi.mock('node:child_process', async importOriginal => {const actual=await importOriginal<typeof import('node:child_process')>();return {...actual,execFileSync:vi.fn(actual.execFileSync)};});
let root: string, home: string, dataRoot: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'cm-integrations-'))); home = join(root, 'common-memory'); dataRoot = join(home, 'data'); vi.stubEnv('COMMON_MEMORY_HOME', home); stubInstalledBuild();vi.mocked(execFileSync).mockImplementation((()=> 'C:\\Synthetic\\common-memory-bridge.ps1') as unknown as typeof execFileSync); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function target(id: 'codex' | 'chatgpt' | 'pi', hooks = id !== 'chatgpt'): IntegrationTarget { return { id, name: id, root: join(root, id === 'pi' ? 'pi' : 'codex'), mode: 'posix', hooks }; }
const install = (targets: IntegrationTarget[]) => installIntegrations(targets, dataRoot, { home });

it('installs and removes Pi automatically while preserving unrelated settings and all Memory data', () => {
  const pi = target('pi'); mkdirSync(pi.root); writeFileSync(join(pi.root, 'settings.json'), JSON.stringify({ theme: 'dark', extensions: ['/user/other.js'] }));
  mkdirSync(join(dataRoot, 'memory'), { recursive: true }); writeFileSync(join(dataRoot, 'memory/profile.md'), '# Keep\n');
  install([pi]);
  const wrapper = join(home, 'integrations/pi/common-memory.js');
  expect(JSON.parse(readFileSync(join(pi.root, 'settings.json'), 'utf8')).extensions).toEqual(['/user/other.js', wrapper]);
  expect(readFileSync(wrapper, 'utf8')).toContain('COMMON_MEMORY_HOME');
  expect(integrationHealth(readInstallationState()!, 'pi')).toBe(true);
  install([pi]); expect(JSON.parse(readFileSync(join(pi.root, 'settings.json'), 'utf8')).extensions).toHaveLength(2);
  removeIntegrations(['pi']);
  expect(JSON.parse(readFileSync(join(pi.root, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark', extensions: ['/user/other.js'] });
  expect(existsSync(wrapper)).toBe(false); expect(readFileSync(join(dataRoot, 'memory/profile.md'), 'utf8')).toBe('# Keep\n');
});
it('merges TOML without rewriting user comments and installs owned hooks and refresh skill', () => {
  const codex = target('codex'); mkdirSync(codex.root);
  const before = '# Keep this comment\nmodel = "unrelated"\n\n[mcp_servers.other]\ncommand = "other"\n';
  writeFileSync(join(codex.root, 'config.toml'), before);
  writeFileSync(join(codex.root, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] } }));
  install([codex]);
  const body = readFileSync(join(codex.root, 'config.toml'), 'utf8');
  expect(body.startsWith(before)).toBe(true); expect(parse(body).mcp_servers).toHaveProperty('common_memory');
  expect(body).toContain('"read"'); expect(body).not.toContain('"init"'); expect(body).not.toContain('dangerously');
  const hook = JSON.parse(readFileSync(join(codex.root, 'hooks.json'), 'utf8')); expect(hook.hooks.Stop).toHaveLength(2);
  expect(existsSync(join(codex.root, 'skills/memory-refresh/SKILL.md'))).toBe(true);
  removeIntegrations(['codex']);
  expect(readFileSync(join(codex.root, 'config.toml'), 'utf8')).toBe(before);
  expect(JSON.parse(readFileSync(join(codex.root, 'hooks.json'), 'utf8'))).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] } });
});
it('shares a read MCP resource but not Codex hooks between Codex CLI and Desktop', () => {
  const codex = target('codex'), desktop = target('chatgpt'); install([codex, desktop]);
  const state = readInstallationState()!;
  expect(state.resources.filter(r => r.kind === 'toml')).toHaveLength(1);
  expect(state.resources.find(r => r.kind === 'toml')!.owners).toEqual(['codex', 'chatgpt']);
  expect(state.resources.filter(r => r.kind === 'array').every(r => JSON.stringify(r.owners) === '["codex"]')).toBe(true);
  removeIntegrations(['codex']);
  expect(existsSync(join(codex.root, 'hooks.json'))).toBe(false); expect(integrationHealth(readInstallationState()!, 'chatgpt')).toBe(true);
  removeIntegrations(['chatgpt']); expect(existsSync(join(codex.root, 'config.toml'))).toBe(false);
});
it('read-only clients do not get unsupported hooks or import authority', () => {
  const codex = target('codex', false); install([codex]);
  expect(existsSync(join(codex.root, 'hooks.json'))).toBe(false);
  expect(readFileSync(join(codex.root, 'config.toml'), 'utf8')).not.toContain('memory_init');
});
it('preflights build availability and all selected clients before committing any of them', () => {
  const pi = target('pi'), codex = target('codex');
  stubInstalledBuild(false);
  expect(() => install([pi, codex])).toThrow('缺少构建产物');
  expect(readInstallationState()).toBeNull();
  expect(existsSync(join(pi.root, 'settings.json'))).toBe(false);
  stubInstalledBuild();
  mkdirSync(codex.root);
  writeFileSync(join(codex.root, 'config.toml'), '[mcp_servers.common_memory]\ncommand = "user-owned"\n');
  expect(() => install([pi, codex])).toThrow('未归属');
  expect(existsSync(join(pi.root, 'settings.json'))).toBe(false); expect(existsSync(join(home, 'integrations/pi/common-memory.js'))).toBe(false);
  expect(readInstallationState()).toBeNull();
});
it('does not override explicitly disabled hooks or malformed configs', () => {
  const codex = target('codex'); mkdirSync(codex.root); writeFileSync(join(codex.root, 'config.toml'), '[features]\nhooks=false\n');
  expect(() => install([codex])).toThrow('禁用 Hooks');
  writeFileSync(join(codex.root, 'config.toml'), '[[malformed'); expect(() => install([codex])).toThrow();
  expect(existsSync(join(codex.root, 'hooks.json'))).toBe(false);
});
it('uninstall preserves external edits and can resume after missing owned files', () => {
  const pi = target('pi'); install([pi]); const wrapper = join(home, 'integrations/pi/common-memory.js');
  const original = readFileSync(wrapper, 'utf8'); writeFileSync(wrapper, 'user-edited');
  expect(integrationHealth(readInstallationState()!, 'pi')).toBe(false);
  expect(() => removeIntegrations(['pi'])).toThrow('已被修改'); expect(readInstallationState()!.targets).toHaveLength(1);
  writeFileSync(wrapper, original); rmSync(wrapper); removeIntegrations(['pi']);
  expect(readInstallationState()!.targets).toHaveLength(0); expect(existsSync(join(pi.root, 'settings.json'))).toBe(false);
});
it('leaves unrelated changes made after installation intact', () => {
  const codex = target('codex', false); install([codex]); const path = join(codex.root, 'config.toml');
  writeFileSync(path, readFileSync(path, 'utf8') + '\n# Later\n[mcp_servers.other]\ncommand="other"\n');
  removeIntegrations(['codex']); expect(readFileSync(path, 'utf8')).toContain('# Later'); expect(parse(readFileSync(path, 'utf8')).mcp_servers).toEqual({ other: { command: 'other' } });
});
it.skipIf(process.platform === 'win32')('rejects symlink destinations before installing anything', () => {
  const other = join(root, 'other'); mkdirSync(other); symlinkSync(other, join(root, 'pi'));
  expect(() => install([target('pi')])).toThrow('不安全'); expect(existsSync(join(other, 'settings.json'))).toBe(false);
});
it('recovers a crash halfway through the multi-file transaction before starting another operation', () => {
  mkdirSync(home); const a = join(root, 'a'), b = join(root, 'b'); writeFileSync(a, 'old');
  writeInstallationFile(join(home, '.installation/transaction.json'), JSON.stringify([{ path: a, before: 'old', after: 'new' }, { path: b, before: null, after: 'created' }]));
  writeFileSync(a, 'new');
  installationTransaction(home, () => {});
  expect(readFileSync(a, 'utf8')).toBe('old'); expect(existsSync(b)).toBe(false); expect(existsSync(join(home, '.installation/transaction.json'))).toBe(false);
});
it('a recovery conflict preserves every file and the journal for retry', () => {
  mkdirSync(home); const a = join(root, 'a'); writeFileSync(a, 'outside-change');
  const journal = join(home, '.installation/transaction.json'); writeInstallationFile(journal, JSON.stringify([{ path: a, before: 'old', after: 'new' }]));
  expect(() => installationTransaction(home, () => {})).toThrow('外部修改'); expect(readFileSync(a, 'utf8')).toBe('outside-change'); expect(existsSync(journal)).toBe(true);
});
it('compares files again at commit instead of overwriting a concurrent client edit', () => {
  mkdirSync(home); const path = join(root, 'config'); writeFileSync(path, 'old');
  expect(() => installationTransaction(home, commit => { writeFileSync(path, 'outside'); commit([{ path, before: 'old', after: 'new' }]); })).toThrow('配置已变化');
  expect(readFileSync(path, 'utf8')).toBe('outside');
});
it('discovers supported POSIX clients and distinguishes incompatible capture versions', () => {
  const base = { home: root, env: { PATH: '', CODEX_HOME: join(root, 'custom-codex'), PI_CODING_AGENT_DIR: join(root, 'custom-pi') }, platform: 'linux' as const, executable: (name: string) => name === 'chatgpt' ? undefined : name, version: (path: string) => path === 'pi' ? '0.84.4' : 'codex-cli 0.154.0' };
  expect(scanIntegrationTargets(base)).toMatchObject([{ id: 'codex', root: join(root, 'custom-codex'), hooks: true }, { id: 'pi', root: join(root, 'custom-pi'), hooks: true }]);
  expect(scanIntegrationTargets({ ...base, version: () => 'unknown' }).map(t => t.id)).toEqual(['codex', 'pi']);
});
it('allows installed Pi without launching it or using its version as an installation gate', () => {
  const version = vi.fn(() => { throw new Error('Pi must not be launched during discovery'); });
  const [pi] = scanIntegrationTargets({ home: root, env: { PATH: '' }, platform: 'linux', executable: name => name === 'pi' ? name : undefined, version });
  expect(pi).toMatchObject({ id: 'pi', root: join(root, '.pi/agent'), hooks: true });
  expect(version).not.toHaveBeenCalled();
});
it.each(['system', 'user'])('discovers macOS Desktop in the %s Applications directory without a CLI', location => {
  const applications = [join(root, 'Applications'), join(home, 'Applications')];
  const app = join(applications[location === 'system' ? 0 : 1]!, 'ChatGPT.app');
  mkdirSync(app, { recursive: true });
  const options = { home, env: { PATH: '' }, platform: 'darwin' as const, executable: () => undefined, applications };
  expect(scanIntegrationTargets(options)).toMatchObject([{ id: 'chatgpt', root: join(home, '.codex'), mode: 'posix', hooks: true }]);
  rmSync(app, { recursive: true }); writeFileSync(app, 'not an application directory');
  expect(scanIntegrationTargets(options)).toEqual([]);
});
it('discovers native Windows Desktop from an explicit app probe, not merely WSL presence', () => {
  const base = { home: root, env: { PATH: '', WSL_DISTRO_NAME: 'Synthetic' }, platform: 'linux' as const, executable: () => undefined };
  expect(scanIntegrationTargets({ ...base, windowsHome: () => undefined })).toEqual([]);
  const [desktop] = scanIntegrationTargets({ ...base, windowsHome: () => join(root, 'windows') });
  expect(desktop).toMatchObject({ id: 'chatgpt', mode: 'windows-wsl', hooks: true });
  installIntegrations([desktop!], dataRoot, { home, env: base.env });
  const body = readInstallationFile(join(desktop!.root, 'config.toml'))!;
  expect(body).toContain('wsl.exe'); expect(body).toContain('Synthetic'); expect(body).toContain('COMMON_MEMORY_HOME=');
  const bridge=join(desktop!.root,'common-memory-bridge.ps1');
  expect(readFileSync(bridge).subarray(0,3)).toEqual(Buffer.from([0xef,0xbb,0xbf]));
  expect(readFileSync(bridge,'utf8')).toContain('CreationDate');expect(body).not.toContain('common_memory_init');expect(body).not.toContain('chatgpt-desktop');
  const hooks=JSON.parse(readFileSync(join(desktop!.root,'hooks.json'),'utf8')).hooks;
  for(const entries of Object.values(hooks) as any[])expect(Buffer.from(entries[0].hooks[0].command.split(' -EncodedCommand ')[1],'base64').toString('utf16le')).toContain('-Action codex-hook -Client codex');
  expect(integrationHealth(readInstallationState()!,'chatgpt')).toBe(true);
  installIntegrations([desktop!],dataRoot,{home,env:base.env});removeIntegrations(['chatgpt']);expect(existsSync(bridge)).toBe(false);
});

it('reconciles Pi + Codex to Pi + ChatGPT atomically while retaining shared MCP and unchanged Pi files', () => {
  const pi = target('pi'), codex = target('codex'), chatgpt = target('chatgpt');
  install([pi, codex]);
  const wrapper = join(home, 'integrations/pi/common-memory.js'), mcp = join(codex.root, 'config.toml');
  const piBefore = statSync(wrapper), mcpBefore = statSync(mcp), mcpContent = readFileSync(mcp, 'utf8');
  const change = reconcileIntegrations([pi, chatgpt], dataRoot, { home, expectedState: readInstallationState() });
  expect(change).toEqual({ installed: ['chatgpt'], removed: ['codex'], retained: ['pi'] });
  const state = readInstallationState()!;
  expect(state.targets.map(t => t.id)).toEqual(['pi', 'chatgpt']);
  expect(state.resources.find(r => r.kind === 'toml')!.owners).toEqual(['chatgpt']);
  expect(integrationHealth(state, 'pi')).toBe(true); expect(integrationHealth(state, 'chatgpt')).toBe(true);
  expect(existsSync(join(codex.root, 'hooks.json'))).toBe(false);
  expect(existsSync(join(codex.root, 'skills/memory-refresh/SKILL.md'))).toBe(false);
  expect(readFileSync(mcp, 'utf8')).toBe(mcpContent);
  expect(statSync(wrapper).ino).toBe(piBefore.ino); expect(statSync(wrapper).mtimeMs).toBe(piBefore.mtimeMs);
  expect(statSync(mcp).ino).toBe(mcpBefore.ino); expect(statSync(mcp).mtimeMs).toBe(mcpBefore.mtimeMs);
});
it('does not remove deselected integrations if an added client fails preflight', () => {
  const pi = target('pi'), codex = target('codex'); install([pi]);
  const before = readInstallationState();
  mkdirSync(codex.root); writeFileSync(join(codex.root, 'config.toml'), '[mcp_servers.common_memory]\ncommand="user-owned"\n');
  expect(() => reconcileIntegrations([codex], dataRoot, { home, expectedState: before })).toThrow('未归属');
  expect(readInstallationState()).toEqual(before); expect(integrationHealth(before!, 'pi')).toBe(true);
  expect(existsSync(join(codex.root, 'hooks.json'))).toBe(false);
});
it('does not install added clients if removing a deselected client fails ownership validation', () => {
  const pi = target('pi'), codex = target('codex'); install([pi]);
  const before = readInstallationState(), wrapper = join(home, 'integrations/pi/common-memory.js');
  writeFileSync(wrapper, 'external edit');
  expect(() => reconcileIntegrations([codex], dataRoot, { home, expectedState: before })).toThrow('已被修改');
  expect(readInstallationState()).toEqual(before); expect(readFileSync(wrapper, 'utf8')).toBe('external edit');
  expect(existsSync(join(codex.root, 'config.toml'))).toBe(false);
  expect(existsSync(join(codex.root, 'hooks.json'))).toBe(false);
});
it('treats unchanged selection as a no-op even when the current installed client is no longer discoverable', () => {
  const pi = target('pi'); install([pi]);
  const before = readInstallationState(), path = join(home, '.installation/state.json'), metadata = statSync(path);
  stubInstalledBuild(false);
  expect(reconcileIntegrations([pi], dataRoot, { home, expectedState: before })).toEqual({ installed: [], removed: [], retained: ['pi'] });
  expect(readInstallationState()).toEqual(before);
  expect(statSync(path).ino).toBe(metadata.ino); expect(statSync(path).mtimeMs).toBe(metadata.mtimeMs);
});
it('rejects a selection based on stale installation ownership before applying any differences', () => {
  const pi = target('pi'), codex = target('codex'); install([pi]);
  const before = readInstallationState(); install([codex]); const concurrent = readInstallationState();
  expect(() => reconcileIntegrations([], dataRoot, { home, expectedState: before })).toThrow('接入状态已被其他操作修改');
  expect(readInstallationState()).toEqual(concurrent);
  expect(integrationHealth(concurrent!, 'pi')).toBe(true); expect(integrationHealth(concurrent!, 'codex')).toBe(true);
});
it('checks explicitly disabled hooks even when switching from a shared read-only ChatGPT integration', () => {
  const chatgpt = target('chatgpt'), codex = target('codex'); install([chatgpt]);
  const path = join(codex.root, 'config.toml');
  writeFileSync(path, readFileSync(path, 'utf8') + '\n[features]\nhooks=false\n');
  const before = readInstallationState();
  expect(() => reconcileIntegrations([codex], dataRoot, { home, expectedState: before })).toThrow('禁用 Hooks');
  expect(readInstallationState()).toEqual(before); expect(existsSync(join(codex.root, 'hooks.json'))).toBe(false);
  expect(integrationHealth(before!, 'chatgpt')).toBe(true);
});
it.each(['missing', 'modified'])('rejects a %s retained integration before committing additions or removals', failure => {
  const pi = target('pi'), codex = target('codex'), chatgpt = target('chatgpt'); install([pi, codex]);
  const before = readInstallationState(), wrapper = join(home, 'integrations/pi/common-memory.js');
  if (failure === 'missing') rmSync(wrapper);
  else writeFileSync(wrapper, 'external edit');
  expect(() => reconcileIntegrations([pi, chatgpt], dataRoot, { home, expectedState: before })).toThrow('接入文件缺失或已变更');
  expect(readInstallationState()).toEqual(before);
  expect(integrationHealth(before!, 'codex')).toBe(true);
  expect(readInstallationState()!.resources.find(r => r.kind === 'toml')!.owners).toEqual(['codex']);
  if (failure === 'missing') expect(existsSync(wrapper)).toBe(false);
  else expect(readFileSync(wrapper, 'utf8')).toBe('external edit');
});
it('preserves both owners when a shared MCP resource was modified before removing one integration', () => {
  const codex = target('codex'), chatgpt = target('chatgpt'); install([codex, chatgpt]);
  const before = readInstallationState(), path = join(codex.root, 'config.toml');
  writeFileSync(path, '[mcp_servers.common_memory]\ncommand="external"\n');
  expect(() => removeIntegrations(['codex'])).toThrow('共享接入文件缺失或已变更');
  expect(readInstallationState()).toEqual(before);
  expect(existsSync(join(codex.root, 'hooks.json'))).toBe(true);
  expect(readFileSync(path, 'utf8')).toBe('[mcp_servers.common_memory]\ncommand="external"\n');
});

it.each(['codex','chatgpt'] as const)('one shared host pipeline survives removing %s without adding import capability',removed=>{
 const codex=target('codex'),chatgpt=target('chatgpt',true);install([codex,chatgpt]);
 const hooksPath=join(codex.root,'hooks.json'),skillPath=join(codex.root,'skills/memory-refresh/SKILL.md');
 const hooks=readFileSync(hooksPath,'utf8'),skill=readFileSync(skillPath,'utf8');
 for(const entries of Object.values(JSON.parse(hooks).hooks) as any[]) {expect(entries).toHaveLength(1);expect(entries[0].hooks[0].command).toContain('codex-hook');}
 expect(skill).toContain("'codex'");
 const mcp=parse(readFileSync(join(codex.root,'config.toml'),'utf8')).mcp_servers as any;
 expect(Object.keys(mcp)).toEqual(['common_memory']);expect(mcp.common_memory.args).toContain('read');expect(mcp.common_memory.enabled_tools).toEqual(['memory_read','memory_status']);
 removeIntegrations([removed]);expect(readFileSync(hooksPath,'utf8')).toBe(hooks);expect(readFileSync(skillPath,'utf8')).toBe(skill);
 const remaining=removed==='codex'?'chatgpt':'codex';expect(integrationHealth(readInstallationState()!,remaining)).toBe(true);
 expect(parse(readFileSync(join(codex.root,'config.toml'),'utf8')).mcp_servers).not.toHaveProperty('common_memory_init');
 removeIntegrations([remaining]);expect(existsSync(hooksPath)).toBe(false);expect(existsSync(skillPath)).toBe(false);
});
it.each(['codex','chatgpt'] as const)('reselecting a managed v0.3.5 read-only %s upgrades the desired graph transactionally',id=>{
 const prior=target(id,false);install([prior]);const before=readInstallationState()!,read=before.resources[0]!.content!;
 const selected={...prior,hooks:true,hint:'new capture support'};
 reconcileIntegrations([selected],dataRoot,{home,expectedState:before});
 expect(readInstallationState()!.targets).toEqual([selected]);expect(readFileSync(join(prior.root,'config.toml'),'utf8')).toBe(read);
 expect(Object.keys(JSON.parse(readFileSync(join(prior.root,'hooks.json'),'utf8')).hooks)).toHaveLength(6);
 expect(existsSync(join(prior.root,'skills/memory-refresh/agents/openai.yaml'))).toBe(true);
 const next=readInstallationState();reconcileIntegrations([selected],dataRoot,{home,expectedState:next});expect(readInstallationState()).toEqual(next);
});
it('retained Desktop upgrade refuses disabled hooks and modified owned resources with no partial changes',()=>{
 const prior=target('chatgpt',false);install([prior]);const path=join(prior.root,'config.toml'),body=readFileSync(path,'utf8'),before=readInstallationState();
 writeFileSync(path,body+'\n[features]\nhooks=false\n');expect(()=>reconcileIntegrations([{...prior,hooks:true}],dataRoot,{home})).toThrow('禁用 Hooks');
 expect(readInstallationState()).toEqual(before);expect(existsSync(join(prior.root,'hooks.json'))).toBe(false);
 writeFileSync(path,body.replace('common_memory','external_edit'));expect(()=>reconcileIntegrations([{...prior,hooks:true}],dataRoot,{home})).toThrow();expect(readInstallationState()).toEqual(before);
});
it('unowned host capture definitions are never duplicated across JSON and inline TOML',()=>{
 const desktop=target('chatgpt',true);mkdirSync(desktop.root);
 writeFileSync(join(desktop.root,'config.toml'),'[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype="command"\ncommand="common-memory work-hook"\n');
 expect(()=>install([desktop])).toThrow('未归属');expect(readInstallationState()).toBeNull();
});
it('managed Windows read-only Desktop upgrades without changing its exact read block',()=>{
 const desktop={...target('chatgpt',false),mode:'windows-wsl' as const};const env={WSL_DISTRO_NAME:'Synthetic'};
 installIntegrations([desktop],dataRoot,{home,env});const before=readInstallationState()!,read=before.resources[0]!.content!;
 reconcileIntegrations([{...desktop,hooks:true}],dataRoot,{home,env,expectedState:before});
 expect(readFileSync(join(desktop.root,'config.toml'),'utf8')).toContain(read);expect(integrationHealth(readInstallationState()!,'chatgpt')).toBe(true);
 expect(readFileSync(join(desktop.root,'common-memory-bridge.ps1')).subarray(0,3)).toEqual(Buffer.from([0xef,0xbb,0xbf]));
 const state=readInstallationState();reconcileIntegrations([{...desktop,hooks:true}],dataRoot,{home,env,expectedState:state});expect(readInstallationState()).toEqual(state);
});
it('ordinary Linux/WSL executables and web browser presence never identify Desktop',()=>{
 expect(scanIntegrationTargets({home:root,platform:'linux',env:{WSL_DISTRO_NAME:'Synthetic'},executable:name=>['chatgpt','browser'].includes(name)?name:undefined,windowsHome:()=>undefined})).toEqual([]);
});
it('preserves BOM ownership bytes for Windows files without regressing BOM client config parsing',()=>{
 const desktop=target('chatgpt',true);mkdirSync(desktop.root);const config='\ufeff# Windows editor\nmodel="synthetic"\n';writeFileSync(join(desktop.root,'config.toml'),config);writeFileSync(join(desktop.root,'hooks.json'),'\ufeff{"hooks":{}}');
 install([desktop]);expect(readFileSync(join(desktop.root,'config.toml'),'utf8')).toContain(config);expect(integrationHealth(readInstallationState()!,'chatgpt')).toBe(true);
 removeIntegrations(['chatgpt']);expect(readFileSync(join(desktop.root,'config.toml'),'utf8')).toBe(config);
});

it('automatic Desktop capture leaves a separately configured manual init server unowned and unchanged',()=>{
 const desktop=target('chatgpt',true);mkdirSync(desktop.root);
 const manual='[mcp_servers.common_memory_init]\ncommand="manual-runtime"\nargs=["mcp","--capability","init"]\n';
 const path=join(desktop.root,'config.toml');writeFileSync(path,manual);
 install([desktop]);expect(readFileSync(path,'utf8')).toContain(manual);
 expect(readInstallationState()!.resources.some(r=>r.content?.includes('common_memory_init'))).toBe(false);
 removeIntegrations(['chatgpt']);expect(readFileSync(path,'utf8')).toBe(manual);
});
