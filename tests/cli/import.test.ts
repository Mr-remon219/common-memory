import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { defaultConfig } from '../../src/config/config.js';
import { RuntimeStore } from '../../src/v2/runtime.js';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const entry = ['--import', pathToFileURL(resolve('tests/mcp/fixtures/source-loader.mjs')).href, resolve('src/cli/main.ts')];

function cli(args: string[], env: Record<string, string>, cwd?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [...entry, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.on('exit', code => done({ code, stdout, stderr }));
  });
}
function fixture(baseUrl: string, provenance: string[] = ['user_explicit', 'document_import'], turnThreshold = 6) {
  const home = mkdtempSync(join(tmpdir(), 'cm-import-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const config = defaultConfig({ COMMON_MEMORY_HOME: home });
  config.remote = { provider: 'openai-compatible', model: 'fake', baseUrl, apiKeyEnv: 'CM_TEST_KEY' };
  config.scheduler.turnThreshold = turnThreshold;
  config.disclosure.allowedProvenance = provenance as typeof config.disclosure.allowedProvenance;
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  const env = { ...process.env, COMMON_MEMORY_HOME: home, CM_TEST_KEY: 'synthetic-key' } as Record<string, string>;
  return { home, config, env };
}
/** Scripted maintainer: retains each document part as an attributed Section; optionally fails a chosen part once. */
async function provider(options: { failPart?: number } = {}) {
  const seen: { source_kind: string; part: number | undefined }[][] = []; let failed = false;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const projection = JSON.parse(JSON.parse(body).input[1].content[0].text);
    const observations = projection.observations as { ref: string; text: string; source_kind: string; import?: { file_name: string; declared_author: string; part: { index: number; count: number }; heading_path: string[] } }[];
    seen.push(observations.map(o => ({ source_kind: o.source_kind, part: o.import?.part.index })));
    // 400 is not retried by the adapter, so the Writer job itself fails once and enters retry.
    if (options.failPart !== undefined && !failed && observations.some(o => o.import?.part.index === options.failPart)) { failed = true; res.statusCode = 400; res.end('{}'); return; }
    const decisions = observations.filter(o => o.source_kind === 'document_import').map(o => ({ kind: 'retain', admission: 'remember', lifetime: 'until_changed', applicability: 'global', confidence: 0.6, evidence: [o.ref], reason: 'scripted',
      // Section bodies may not contain un-fenced H1/H2, so the scripted body quotes the part in a fence.
      operations: [{ op: 'put_section', target: 'profile', section: null, title: `Imported ${o.import!.file_name} part ${o.import!.part.index} (${o.text.length} chars)`, body: `Imported from ${o.import!.file_name} (${o.import!.declared_author}) on ${projection.now.slice(0, 10)}, under ${JSON.stringify(o.import!.heading_path)}:\n\n\`\`\`text\n${o.text.trim().slice(0, 80)}\n\`\`\`\n` }] }));
    const decision = { version: 'memory_maintenance_v2', request_id: projection.request_id, decisions: decisions.length ? decisions : [{ kind: 'ignore', applicability: 'uncertain', confidence: 1, evidence: [], reason: 'scripted' }] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'completed', incomplete_details: null, error: null, output: [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(decision), annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise<void>(r => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, seen };
}
const markdown = '# Notes\n\n## Pets\n\nKeeps a rescued tortoise named Basalt.\n\n> Only on weekends: Rust practice.\n\n```sh\n# not a heading\necho hi\n```\n';

it('imports a Markdown file through the unchanged Writer, reports retention, deduplicates by content and detects changes', async () => {
  const { url, seen } = await provider();
  const { env, config, home } = fixture(url);
  const file = join(home, 'notes.md'); writeFileSync(file, markdown);
  const first = await cli(['import', file, '--author', 'user'], env);
  expect(first.code, first.stderr).toBe(0);
  expect(first.stdout).toMatch(/accepted: queued as md-[a-f0-9]{64} \(1 part\)/);
  expect(first.stdout).toContain('"complete": true'); expect(first.stdout).toContain('complete: retained in profile');
  expect(first.stdout).not.toContain('Basalt'); // the CLI reports states, never bodies
  const profile = readFileSync(join(config.dataRoot, 'memory/profile.md'), 'utf8');
  expect(profile).toContain('Imported from notes.md (user)'); expect(profile).toContain('under []'); // one part: no ancestor headings
  expect(seen).toEqual([[{ source_kind: 'document_import', part: 1 }]]);
  // Same content under another name: duplicate, no second model call, still reported complete.
  const copy = join(home, 'renamed.md'); writeFileSync(copy, markdown);
  const again = await cli(['import', copy, '--author', 'user'], env);
  expect(again.code).toBe(0); expect(again.stdout).toContain('duplicate: this exact content was already imported'); expect(again.stdout).toContain('"complete": true');
  expect(seen).toHaveLength(1);
  // Changed content is a new import with a new id.
  writeFileSync(file, markdown + '\n## Update\n\nNow keeps two tortoises.\n');
  const changed = await cli(['import', file, '--author', 'user'], env);
  expect(changed.code, changed.stdout + changed.stderr).toBe(0); expect(changed.stdout).toContain('accepted: queued as md-'); expect(seen).toHaveLength(2);
  expect(readFileSync(join(config.dataRoot, 'memory/profile.md'), 'utf8')).toMatch(/Imported notes.md part 1[\s\S]*Imported notes.md part 1/);
  // Same content, different declared author: still the same material, reported as a duplicate, not re-processed.
  const relabelled = await cli(['import', file, '--author', 'agent', '--label', 'old notes'], env);
  expect(relabelled.code).toBe(0); expect(relabelled.stdout).toContain('duplicate:'); expect(seen).toHaveLength(2);
}, 30000);

it('rejects empty, oversized, non-Markdown, policy-violating and unauthorized imports without queuing anything', async () => {
  const { url } = await provider();
  const { env, config, home } = fixture(url);
  const cases: [string, string | Buffer, string[], string][] = [
    ['empty.md', '\n\n', [], 'EMPTY_DOCUMENT'],
    ['big.md', 'x'.repeat(262145), [], 'DOCUMENT_TOO_LARGE'],
    ['notes.txt', '# hi\n', [], 'UNSUPPORTED_FILE_TYPE'],
    ['secret.md', '# Env\n\npassword: hunter2hunter2\n', [], 'SENSITIVE_CONTENT_REJECTED part 1/1'],
    ['bad.md', Buffer.from([0xc3, 0x28]), [], 'INVALID_ENCODING'],
    ['ok.md', '# ok\n\nfine\n', ['--author', 'nobody'], '--author must be one of'],
    ['ok.md', '# ok\n\nfine\n', ['--workspace', '/definitely/not/registered'], 'UNREGISTERED_WORKSPACE'],
  ];
  for (const [name, content, extra, message] of cases) {
    const file = join(home, name); writeFileSync(file, content);
    const result = await cli(['import', file, ...extra], env);
    expect(result.code, name).toBe(1); expect(result.stderr, name).toContain(message);
  }
  expect((await cli(['import', join(home, 'missing.md')], env)).stderr).toContain('FILE_NOT_FOUND');
  expect(existsSync(join(config.dataRoot, 'runtime.sqlite'))).toBe(false);
  // Provenance not authorized: the Writer is never even created.
  const disabled = fixture(url, ['user_explicit']);
  writeFileSync(join(disabled.home, 'n.md'), markdown);
  const off = await cli(['import', join(disabled.home, 'n.md')], disabled.env);
  expect(off.code).toBe(1); expect(off.stderr).toContain('IMPORT_DISABLED'); expect(existsSync(join(disabled.config.dataRoot, 'runtime.sqlite'))).toBe(false);
}, 30000);

it('a multi-part import reports partial failure honestly and resumes on re-import; import-only configs need no user_explicit', async () => {
  const { url, seen } = await provider({ failPart: 2 });
  // One part per batch so that partial progress is observable; without user_explicit the Writer still runs.
  const { env, config, home } = fixture(url, ['document_import'], 1);
  const parts = Array.from({ length: 3 }, (_, i) => `## Section ${i + 1}\n\n${`Paragraph ${i + 1}. `.repeat(2000)}\n\n`).join('');
  const file = join(home, 'long.md'); writeFileSync(file, `# Long\n\n${parts}`);
  const first = await cli(['import', file], env);
  expect(first.code).toBe(1);
  expect(first.stdout).toContain('(3 parts)'); expect(first.stdout).toContain('"complete": false'); expect(first.stdout).toContain('incomplete: some parts were not processed');
  expect(first.stdout).toMatch(/"state": "processed"/); expect(first.stdout).toMatch(/"state": "(claimed|pending)"/);
  const before = readFileSync(join(config.dataRoot, 'memory/profile.md'), 'utf8');
  expect(before).toContain('part 1'); expect(before).not.toContain('part 2');
  // Retry backoff for the first failure is one second; re-importing the same file resumes the queue.
  await new Promise(r => setTimeout(r, 1200));
  const second = await cli(['import', file], env);
  expect(second.code, second.stderr).toBe(0);
  expect(second.stdout).toContain('duplicate:'); expect(second.stdout).toContain('"complete": true');
  const after = readFileSync(join(config.dataRoot, 'memory/profile.md'), 'utf8');
  for (const n of [1, 2, 3]) expect(after).toContain(`Imported long.md part ${n}`);
  // Every model call carried only document parts with their position in the whole material.
  for (const batch of seen) for (const o of batch) expect(o.source_kind).toBe('document_import');
  expect(seen.flat().map(o => o.part).sort()).toEqual([1, 2, 2, 3]);
  // --no-wait only queues.
  writeFileSync(join(home, 'later.md'), '# Later\n\nqueued only\n');
  const queued = await cli(['import', join(home, 'later.md'), '--no-wait'], env);
  expect(queued.code).toBe(0); expect(queued.stdout).toContain('queued: run common-memory flush');
  const store = new RuntimeStore(config.dataRoot); try { expect(store.pending()).toHaveLength(1); } finally { store.close(); }
}, 40000);

it('mcp-config pins node, CLI entry, configuration directory and dataRoot; --wsl bridges through wsl.exe into a fixed distribution and user', async () => {
  const { env, config, home } = fixture('http://127.0.0.1:1/v1');
  const native = await cli(['mcp-config'], env);
  expect(native.code, native.stderr).toBe(0);
  expect(native.stdout).toContain(`env = { COMMON_MEMORY_HOME = ${JSON.stringify(home)} }`);
  expect(native.stdout).toContain(`dataRoot (canonical Markdown under <dataRoot>/memory): ${config.dataRoot}`);
  expect(native.stdout).toContain('[mcp_servers.common_memory_init]'); expect(native.stdout).toContain('"--capability", "init", "--global"');
  expect(native.stdout).toContain('[mcp_servers.common_memory]'); expect(native.stdout).toContain('"--capability", "read", "--global"'); expect(native.stdout).toContain('enabled_tools = ["memory_read", "memory_status"]');
  expect(native.stdout).not.toContain('wsl.exe');
  const wsl = await cli(['mcp-config', '--wsl', '--user', 'tester'], { ...env, WSL_DISTRO_NAME: 'UbuntuTest' });
  expect(wsl.code, wsl.stderr).toBe(0);
  expect(wsl.stdout).toContain('command = "wsl.exe"');
  expect(wsl.stdout).toContain(`args = ["-d", "UbuntuTest", "-u", "tester", "-e", "/usr/bin/env", "COMMON_MEMORY_HOME=${home}", `);
  expect(wsl.stdout).toContain(resolve('src/cli/main.ts')); expect(wsl.stdout).toContain('WSL distribution: UbuntuTest; Linux user: tester');
  expect(wsl.stdout).toContain('Windows-native Pi is not covered');
  const noDistro = await cli(['mcp-config', '--wsl'], { ...env, WSL_DISTRO_NAME: '' });
  expect(noDistro.code).toBe(1); expect(noDistro.stderr).toContain('--wsl needs a distribution');
  // A registered project adds --workspace and warns when it is not an allowed disclosure scope.
  mkdirSync(join(home, 'proj'));
  const registered = await cli(['project', 'register', join(home, 'proj'), 'Proj'], env); expect(registered.code).toBe(0);
  const withProject = await cli(['mcp-config', '--workspace', join(home, 'proj')], env);
  expect(withProject.stdout).toContain(`"--workspace", ${JSON.stringify(join(home, 'proj'))}`); expect(withProject.stdout).toContain('not in disclosure.allowedScopes');
  expect((await cli(['mcp-config', '--workspace', join(home, 'nope')], env)).stderr).toContain('UNREGISTERED_WORKSPACE');
}, 30000);
