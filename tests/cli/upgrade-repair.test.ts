import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stubInstalledBuild } from '../helpers/installation-build.js';
import { defaultConfig, saveConfig } from '../../src/config/config.js';
import { installIntegrations, readInstallationState } from '../../src/cli/integrations.js';
import { repairManagedIntegrations } from '../../src/cli/tui-integrations.js';
import type { IntegrationTarget } from '../../src/cli/integration-targets.js';

let root: string, home: string;
beforeEach(() => { root=realpathSync(mkdtempSync(join(tmpdir(), 'cm-upgrade-repair-'))); home=join(root,'home'); vi.stubEnv('COMMON_MEMORY_HOME',home); stubInstalledBuild(); const config=defaultConfig();config.remote.model='synthetic';saveConfig(config); });
afterEach(()=>{vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});

it('reapplies the recorded managed target graph through the owned transaction and is idempotent', () => {
  const config=defaultConfig(); config.dataRoot=join(home,'data');
  const target: IntegrationTarget={id:'codex',name:'Codex',root:join(root,'codex'),mode:'posix',hooks:true};
  installIntegrations([target],config.dataRoot,{home});
  const first=repairManagedIntegrations(config,{home});
  expect(first).toEqual({installed:[],removed:[],retained:['codex']});
  expect(existsSync(join(target.root,'hooks.json'))).toBe(true);
  const before=readInstallationState();
  expect(repairManagedIntegrations(config,{home})).toEqual({installed:[],removed:[],retained:['codex']});
  expect(readInstallationState()).toEqual(before);
});
