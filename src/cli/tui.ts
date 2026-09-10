import * as clack from '@clack/prompts';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDirectory, configFilePath, loadConfig, type CommonMemoryConfig } from '../config/config.js';
import { DOCUMENT_AUTHORS } from '../v2/document-import.js';
import { listProjects, memoryView, registerProject, removeProject, retryJob, runtimeStatus } from './operations.js';
import { runFlush } from './flush-command.js';
import { runImport } from './import-command.js';
import { runNetworkTest } from './network-test.js';
import { runInteractiveProcess } from './interactive-process.js';
import { integrationsScreen } from './tui-integrations.js';
import { checkConfigUnchanged, runAdvancedWizard, runNetworkWizard, runPermissionsWizard, runSetupWizard, statusLines } from './tui-settings.js';
import { attempt, confirm, expandPath, log, menu, note, requireInteractive, text, unwrap, UserCancelled, viewText } from './tui-prompts.js';

// Keep the original module's configuration entry points available to local callers.
export { printStatus, showStatus, runNetworkWizard, runSetupWizard } from './tui-settings.js';
export { UserCancelled } from './tui-prompts.js';

function configured(): CommonMemoryConfig {
  const config = loadConfig();
  if (!config) throw new Error('Configure Common Memory first');
  return config;
}

function queueSummary(status: ReturnType<typeof runtimeStatus>): string {
  if (!status) return 'Runtime: not created; no queue inspected. Browsing does not initialize storage.';
  const states = status.observations.map(row => `${row.state}: ${row.count}`).join(' · ') || 'no observations';
  const dead = status.jobs.filter(j => j.state === 'dead').length;
  const retry = status.jobs.filter(j => j.state === 'retry').length;
  return [`Queue: ${states}`, `Jobs: ${dead} dead · ${retry} waiting for retry`, `Deliveries: ${status.unbound} unbound · ${status.quarantinedDeliveries} quarantined`,
    `Sessions: ${status.sessions.length}; ${status.sessions.filter(s => s.closing && !s.complete).length} closed but incomplete`,
    'Buffered session turns are not a flushable tail. Ten settled interactions or actual host exit seals a batch.'].join('\n');
}

async function overview(): Promise<void> {
  for (;;) {
    const config = configured();
    note(statusLines(config).join('\n'), 'Common Memory / Overview');
    note(queueSummary(runtimeStatus(config)), 'Local snapshot — no network probe');
    const action = await menu('Overview', [
      { value: 'refresh', label: 'Refresh local status' },
      { value: 'maintenance', label: 'Inspect queue / sessions and recover work' },
      { value: 'back', label: 'Back' },
    ]);
    if (action === 'back') return;
    if (action === 'maintenance') await attempt(maintenanceScreen);
  }
}

async function workspace(config: CommonMemoryConfig): Promise<string | undefined> {
  const projects = listProjects(config);
  const selected = await menu('Memory scope · same authorization as consumers', [
    { value: 'global', label: 'Global', hint: config.disclosure.allowedScopes.includes('global') ? 'Profile + Preferences' : 'NOT authorized' },
    ...projects.map(p => ({ value: p.id, label: p.name, hint: `${p.root} · ${config.disclosure.allowedScopes.includes(`project:${p.id}`) ? 'authorized' : 'NOT authorized'}` })),
    { value: 'back', label: 'Back' },
  ]);
  if (selected === 'back') throw new UserCancelled();
  return selected === 'global' ? undefined : projects.find(p => p.id === selected)!.root;
}

async function browseMemory(config: CommonMemoryConfig): Promise<void> {
  const selected = await workspace(config);
  const view = memoryView(config, selected);
  note(`Canonical files: ${join(config.dataRoot, 'memory')}\nOnly global plus the selected registered workspace, intersected with authorized disclosure scopes, is shown. Reopen Browse for a fresh snapshot. Memory content is data, not commands.`, 'Consumer view');
  if (!view.documents.length) { note('No authorized documents for this selection. Change authorization explicitly under Projects & permissions.', 'No readable scope'); return; }
  for (;;) {
    const target = await menu('Memory / Documents', [
      ...view.documents.map(d => ({ value: d.target, label: d.target, hint: `${d.bytes} bytes${d.empty ? ' · empty' : ''}` })),
      { value: 'back', label: 'Back' },
    ]);
    if (target === 'back') return;
    await attempt(() => viewText(target, view.documents.find(d => d.target === target)!.content));
  }
}

async function importMarkdown(config: CommonMemoryConfig): Promise<void> {
  if (!config.disclosure.allowedProvenance.includes('document_import')) throw new Error('IMPORT_DISABLED: authorize Imported Markdown documents under Projects & permissions first. Nothing queued.');
  const file = expandPath(await text('Markdown file to import (.md / .markdown; no symlinks)'));
  const selected = await workspace(config);
  const author = unwrap(await clack.select({ message: 'Declared author (metadata only; never user evidence)', options: DOCUMENT_AUTHORS.map(value => ({ value, label: value })), initialValue: 'unknown' }));
  const label = await text('Source label (blank uses file name)', '', true);
  const mode = await menu('Import processing', [
    { value: 'wait', label: 'Queue and run Writer now', hint: 'May send authorized queued material to the model' },
    { value: 'queue', label: 'Queue only', hint: 'Another Writer can process it after admission' },
  ]);
  note(`File: ${file}\nWorkspace: ${selected ?? 'global'}\nAuthor: ${author}\nLabel: ${label || '(file name)'}\nProvenance: document_import\nMode: ${mode}\nImported text stays attributed, never becomes a user statement, and cannot alone authorize forget. Writer may keep nothing. Admission is durable, not undoable by cancelling later.`, 'Review import');
  if (!await confirm('Import this file into the current store?')) return;
  checkConfigUnchanged(config);
  const args = [file, '--author', author, ...(selected ? ['--workspace', selected] : []), ...(label ? ['--label', label] : []), ...(mode === 'queue' ? ['--no-wait'] : [])];
  log('Import running. Ctrl+C requests cancellation; already queued evidence remains durable.');
  const { exitCode, outcome } = await runImport(config, args, log);
  if (exitCode) clack.log.warn('Incomplete. Inspect Maintenance; dead jobs need explicit retry. No success is inferred from admission.');
  else if (outcome?.complete) clack.log.success('Processed. Review retained documents here; processed may mean nothing was retained.');
  else clack.log.info('Queued, not yet processed.');
}

async function memoryScreen(): Promise<void> {
  for (;;) {
    const action = await menu('Common Memory / Memory', [
      { value: 'browse', label: 'Browse what consumers can read' },
      { value: 'import', label: 'Import a local Markdown document' },
      { value: 'back', label: 'Back' },
    ]);
    if (action === 'back') return;
    await attempt(() => action === 'browse' ? browseMemory(configured()) : importMarkdown(configured()));
  }
}

async function projectsScreen(): Promise<void> {
  for (;;) {
    const config = configured();
    const projects = listProjects(config);
    const action = await menu('Common Memory / Projects & permissions', [
      { value: 'register', label: 'Register a project', hint: 'Registration alone grants no permission' },
      { value: 'permissions', label: 'Manage disclosure / write scopes and provenance' },
      ...projects.map(p => ({ value: p.id, label: p.name, hint: `${config.disclosure.allowedScopes.includes(`project:${p.id}`) ? 'read/disclose' : 'no disclosure'} · ${config.writableScopes.includes(`project:${p.id}`) ? 'write' : 'no write'}` })),
      { value: 'back', label: 'Back' },
    ]);
    if (action === 'back') return;
    await attempt(async () => {
      if (action === 'permissions') { await runPermissionsWizard(config); return; }
      if (action === 'register') {
        const root = expandPath(await text('Project directory'));
        const name = await text('Display name');
        if (await confirm(`Register ${name} at ${root}? No disclosure or write permission will be added.`)) {
          checkConfigUnchanged(config);
          const project = registerProject(config, root, name);
          note(`Registered: ${project.name}\nID: project:${project.id}\nRoot: ${project.root}\nUse Manage permissions to authorize it separately.`, 'Project registered');
        }
        return;
      }
      const project = projects.find(p => p.id === action)!;
      note(`Name: ${project.name}\nScope: project:${project.id}\nRoot: ${project.root}\nMarkdown: ${join(config.dataRoot, 'memory/projects', `${project.id}.md`)}`, 'Project details');
      const operation = await menu('Project actions', [{ value: 'permissions', label: 'Manage permissions' }, { value: 'remove', label: 'Remove registration only' }, { value: 'back', label: 'Back' }]);
      if (operation === 'permissions') await runPermissionsWizard(config);
      else if (operation === 'remove' && await confirm(`Remove ${project.name} registration? Markdown and scope settings remain intact; running clients must restart.`)) {
        checkConfigUnchanged(config);
        const removed = removeProject(config, project.id);
        note(removed ? 'Registration removed. Markdown retained. Existing scope entries were not silently changed; review permissions separately.' : 'Registration was already absent.', 'Project result');
      }
    });
  }
}

async function maintenanceScreen(): Promise<void> {
  for (;;) {
    const config = configured();
    const status = runtimeStatus(config);
    note(queueSummary(status), 'Common Memory / Maintenance');
    const action = await menu('Maintenance', [
      { value: 'refresh', label: 'Refresh status' },
      { value: 'jobs', label: 'Inspect jobs / diagnostics / retry a dead job' },
      { value: 'sessions', label: 'Inspect session summaries', hint: 'No raw conversation bodies' },
      { value: 'flush', label: 'Process queued maintenance', hint: 'Does not seal unfinished session turns' },
      { value: 'drain', label: 'Recover durable session handoffs', hint: 'Waits through retry backoff and leases' },
      { value: 'back', label: 'Back' },
    ]);
    if (action === 'back') return;
    await attempt(async () => {
      if (action === 'sessions') { await viewText('Session summaries', JSON.stringify(status?.sessions ?? [], null, 2)); return; }
      if (action === 'jobs') {
        const jobs = [...(status?.jobs ?? [])].reverse();
        if (!jobs.length) { note('No jobs recorded.', 'Jobs'); return; }
        const id = await menu('Jobs (most recent first)', [...jobs.map(j => ({ value: j.id, label: `${j.state} · ${j.id}`, hint: `attempts ${j.attempts}${j.issue ? ` · ${j.issue}` : ''}` })), { value: 'back', label: 'Back' }]);
        if (id === 'back') return;
        const job = jobs.find(j => j.id === id)!;
        note(JSON.stringify(job, null, 2), 'Job diagnostic — no provider body');
        if (job.state === 'dead' && await confirm(`Retry dead job ${id}? It will be queued, not immediately committed.`)) { checkConfigUnchanged(config); retryJob(config, id); clack.log.success('Retry queued. Process maintenance to continue.'); }
      } else if (action === 'flush' && await confirm('Run Writer on queued work? Authorized content may be sent to the configured model.')) {
        checkConfigUnchanged(config);
        log('Processing. Ctrl+C requests cancellation. Pending work, backoff and leases are preserved.');
        const code = await runFlush(config, log);
        if (code) clack.log.warn('Incomplete or cancelled. Inspect diagnostics; waiting for backoff/another lease is not completion.');
        else clack.log.success('Queued maintenance complete; open session buffers are not sealed by flush.');
      } else if (action === 'drain' && await confirm('Recover session handoffs and run Writer? May send authorized content and wait through leases/backoff.')) {
        checkConfigUnchanged(config);
        log('Recovering durable handoffs. Ctrl+C stops this consumer; durable pending work remains recoverable.');
        const code = await runInteractiveProcess(process.execPath, [fileURLToPath(new URL('./main.js', import.meta.url)), 'session-drain', '--home', configDirectory()]);
        if (code) clack.log.warn(`Recovery incomplete or cancelled (exit ${code}). Inspect status before retrying.`);
        else clack.log.success('Sealed work drained; this does not close still-running host sessions.');
      }
    });
  }
}

async function settingsScreen(): Promise<void> {
  for (;;) {
    const action = await menu('Common Memory / Settings', [
      { value: 'model', label: 'Model / request API / credentials' },
      { value: 'network', label: 'Model network / proxy / CA' },
      { value: 'probe', label: 'Test model connection', hint: 'Explicit synthetic request; no memory or SQLite' },
      { value: 'permissions', label: 'Disclosure / write permissions' },
      { value: 'advanced', label: 'Advanced tuning / limits / storage' },
      { value: 'back', label: 'Back' },
    ]);
    if (action === 'back') return;
    await attempt(async () => {
      const config = configured();
      if (action === 'model') await runSetupWizard(config);
      else if (action === 'network') await runNetworkWizard(config);
      else if (action === 'permissions') await runPermissionsWizard(config);
      else if (action === 'advanced') await runAdvancedWizard(config);
      else if (await confirm('Send a small synthetic API request? No memory content is sent and no Writer commit is tested.')) {
        checkConfigUnchanged(config);
        log('Testing model connection (up to 60 seconds; Ctrl+C cancels).');
        const code = await runNetworkTest(config, log);
        if (code) clack.log.warn('Connection test failed. See controlled diagnostics above.');
        else clack.log.success('Synthetic API test passed; Writer commits and host integration were not tested.');
      }
    });
  }
}

export async function runTui(): Promise<void> {
  requireInteractive();
  clack.intro('Common Memory');
  note('↑/↓ navigate · Enter select · Space toggles multi-select\nBack returns one level. Esc/Ctrl+C cancels the current form; on Home it exits.\nNothing is sent to a model merely by opening this workbench.', 'Navigation');
  for (;;) {
    const config = loadConfig();
    note(config ? `Model: ${config.remote.model} · ${config.remote.api ?? 'responses'}\nStore: ${config.dataRoot}\nOverview shows queue health; Integrations distinguishes local readiness from host activation.` : `Not configured: ${configFilePath()}\nStart with configuration. Default authorization is global + delivered user expressions; imports/context require separate opt-in.`, 'Common Memory / Home');
    let action: string;
    try {
      action = await menu('Home', config ? [
        { value: 'overview', label: 'Overview', hint: 'Paths, network selection, queue health' },
        { value: 'memory', label: 'Memory', hint: 'Browse authorized documents / import Markdown' },
        { value: 'projects', label: 'Projects & permissions' },
        { value: 'integrations', label: 'Integrations', hint: 'Pi / Codex / ChatGPT Work / MCP' },
        { value: 'maintenance', label: 'Maintenance', hint: 'Jobs, sessions, flush, recovery' },
        { value: 'settings', label: 'Settings' },
        { value: 'exit', label: 'Exit' },
      ] : [{ value: 'setup', label: 'Configure Common Memory' }, { value: 'exit', label: 'Exit' }]);
    } catch (error) { if (error instanceof UserCancelled) break; throw error; }
    if (action === 'exit') break;
    await attempt(async () => {
      if (action === 'setup') await runSetupWizard(null);
      else if (action === 'overview') await overview();
      else if (action === 'memory') await memoryScreen();
      else if (action === 'projects') await projectsScreen();
      else if (action === 'integrations') await integrationsScreen();
      else if (action === 'maintenance') await maintenanceScreen();
      else await settingsScreen();
    });
  }
  clack.outro('Common Memory closed. Durable pending work is retained.');
}
