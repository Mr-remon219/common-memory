import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CanonicalStore, digest } from '../../src/v2/canonical.js';
import { ProjectRegistry } from '../../src/v2/registry.js';
const directories: string[] = [];
function setup() { const root = mkdtempSync(join(tmpdir(), 'cm-v2-')); directories.push(root); return { root, store: new CanonicalStore(root) }; }
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('Markdown canonical', () => {
  it('preserves untouched bytes, commits receipts, and rejects stale full read sets', () => {
    const { root, store } = setup(); const original = '# Profile\n\n## Existing\n  exact bytes\n\n## State\nA\n'; writeFileSync(join(root, 'memory/profile.md'), original);
    const snapshot = store.snapshot(); const updates = store.apply(snapshot, [{ op: 'put_section', target: 'profile', section: 's2', title: 'State', body: 'B' }]);
    expect(updates.get('profile')).toBe('# Profile\n\n## Existing\n  exact bytes\n\n## State\nB\n'); store.commit(snapshot, updates, { id: 'batch1', decisions: ['retain'] });
    expect(store.receipts()).toEqual([{ id: 'batch1', decisions: ['retain'] }]); expect(() => store.commit(snapshot, updates, { id: 'batch2' })).toThrow('STALE_REVISION');
    const fresh = store.snapshot(); writeFileSync(join(root, 'memory/preferences.md'), '# Preferences\n\n## New\nmanual\n'); expect(() => store.commit(fresh, new Map(), { id: 'batch3' })).toThrow('STALE_REVISION');
  });
  it('rejects hidden structures, wrong references, duplicate titles, and oversized sections', () => {
    const { store } = setup(); const snapshot = store.snapshot();
    const put = (body: string) => store.apply(snapshot, [{ op: 'put_section', target: 'profile', section: null, title: 'State', body }]);
    expect(() => put('hello\n## Hidden\nvalue')).toThrow(); expect(() => put('# Hidden')).toThrow(); expect(() => put('x'.repeat(17000))).toThrow();
    expect(() => put('```\n## code\n```')).not.toThrow(); expect(() => store.apply(snapshot, [{ op: 'remove_section', target: 'profile', section: 'missing' }])).toThrow();
    expect(() => store.apply(snapshot, ['a', 'b'].map(body => ({ op: 'put_section' as const, target: 'profile', section: null, title: 'Same', body })))).toThrow();
  });
  it('rejects Setext heading markers and reads an EOF section as empty', () => {
    const { root, store } = setup();
    writeFileSync(join(root, 'memory/profile.md'), '# Profile\n\n## Empty');
    expect(store.snapshot()[0]!.sections[0]!.body).toBe('');
    for (const marker of ['---', '=', '--']) {
      expect(() => store.apply(store.snapshot(), [{ op: 'put_section', target: 'profile', section: 's1', title: 'Topic', body: `hidden\n${marker}` }])).toThrow('Setext');
    }
    expect(() => store.apply(store.snapshot(), [{ op: 'put_section', target: 'profile', section: 's1', title: 'Topic', body: '```\n---\n```' }])).not.toThrow();
  });
  it.each(['staged', 'commit-marker', 'target:memory/profile.md', 'target:runtime/receipts/fault.json', 'before-cleanup'])('recovers injected failure at %s', phase => {
    const { root } = setup();
    const store = new CanonicalStore(root, { checkpoint: current => { if (current === phase) throw new Error('injected'); } });
    const content = '# Profile\n\n## State\nB\n';
    expect(() => store.commit(store.snapshot(), new Map([['profile', content]]), { id: 'fault' })).toThrow('injected');
    const recovered = new CanonicalStore(root); recovered.recover();
    expect(recovered.snapshot()[0]!.content).toBe(phase === 'staged' ? '# Profile\n\n' : content);
    expect(recovered.receipts()).toEqual(phase === 'staged' ? [] : [{ id: 'fault' }]);
    expect(readdirSync(join(root, 'runtime/transactions'))).toEqual([]);
  });
  it.each(['commit-marker', 'target:memory/profile.md'])('does not overwrite external edits after fault at %s', phase => {
    const { root } = setup();
    const store = new CanonicalStore(root, { checkpoint: current => { if (current === phase) throw new Error('injected'); } });
    expect(() => store.commit(store.snapshot(), new Map([['profile', '# Profile\n\n## State\nB\n']]), { id: 'fault' })).toThrow('injected');
    const manual = '# Profile\n\n## Manual\npreserve\n'; writeFileSync(join(root, 'memory/profile.md'), manual);
    expect(() => new CanonicalStore(root).recover()).toThrow('Recovery conflict');
    expect(readFileSync(join(root, 'memory/profile.md'), 'utf8')).toBe(manual);
    expect(new CanonicalStore(root).receipts()).toEqual([]);
  });
  it.each(['staged', 'commit-marker', 'target:memory/profile.md', 'target:runtime/receipts/killed.json', 'before-cleanup'])('recovers after forced subprocess exit at %s', phase => {
    const { root } = setup();
    const moduleUrl = new URL('../../src/v2/canonical.ts', import.meta.url).href;
    const script = `import { CanonicalStore } from ${JSON.stringify(moduleUrl)};
      const store = new CanonicalStore(${JSON.stringify(root)}, { checkpoint: phase => { if (phase === ${JSON.stringify(phase)}) process.exit(73); } });
      store.commit(store.snapshot(), new Map([['profile', '# Profile\\n\\n## State\\nB\\n']]), { id: 'killed' });`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(73);
    const recovered = new CanonicalStore(root); recovered.recover();
    expect(recovered.receipts()).toEqual(phase === 'staged' ? [] : [{ id: 'killed' }]);
    expect(recovered.snapshot()[0]!.content).toBe(phase === 'staged' ? '# Profile\n\n' : '# Profile\n\n## State\nB\n');
  });
  it('rejects symlinks and path traversal without modifying external data', () => {
    const { root, store } = setup(); const external = join(root, 'external'); writeFileSync(external, 'private'); symlinkSync(external, join(root, 'memory/profile.md')); expect(() => store.snapshot()).toThrow('Unsafe file'); expect(readFileSync(external, 'utf8')).toBe('private');
    rmSync(join(root, 'memory/profile.md')); expect(() => store.snapshot(['../../escape'])).toThrow('Invalid target');
  });
  it('recovers committed files and permanent receipt, failing closed on external modification', () => {
    const { root, store } = setup(); const id = '11111111-1111-1111-1111-111111111111'; const directory = join(root, 'runtime/transactions', id); mkdirSync(directory);
    const content = '# Profile\n\n## State\nB\n'; const receipt = '{"id":"recovered"}\n';
    writeFileSync(join(directory, 'stage-0'), content); writeFileSync(join(directory, 'stage-1'), receipt);
    writeFileSync(join(directory, 'journal.json'), JSON.stringify({ id, files: [{ path: 'memory/profile.md', before: 'missing', after: digest(content), stage: 'stage-0' }, { path: 'runtime/receipts/recovered.json', before: 'missing', after: digest(receipt), stage: 'stage-1' }] })); writeFileSync(join(directory, 'COMMITTING'), 'v2\n');
    writeFileSync(join(root, 'memory/profile.md'), '# Profile\n\n## Manual\nnew\n'); expect(() => store.recover()).toThrow('Recovery conflict'); expect(store.receipts()).toEqual([]);
    writeFileSync(join(root, 'memory/profile.md'), content); store.recover(); expect(store.receipts()).toEqual([{ id: 'recovered' }]); expect(readdirSync(join(root, 'runtime/transactions'))).toEqual([]);
  });
});
describe('project registry', () => {
  it('uses canonical roots, longest ancestor and non-destructive removal', () => {
    const { root } = setup(); const project = join(root, 'project'); const nested = join(project, 'nested'); mkdirSync(nested, { recursive: true }); mkdirSync(join(root, 'project-other'));
    const registry = new ProjectRegistry(root); const parent = registry.register(project, 'Parent'); const child = registry.register(nested, 'Child');
    expect(registry.resolve(nested)?.id).toBe(child.id); expect(registry.resolve(join(root, 'project-other'))).toBeUndefined(); const alias = join(root, 'alias'); symlinkSync(project, alias); expect(() => registry.register(alias, 'Alias')).toThrow('already registered');
    writeFileSync(join(root, 'memory/projects', `${parent.id}.md`), '# Project\n'); expect(registry.remove(parent.id)).toBe(true); expect(readFileSync(join(root, 'memory/projects', `${parent.id}.md`), 'utf8')).toBe('# Project\n');
  });
});

it('supports a configurable hard budget without truncating canonical content',()=>{
 const root=mkdtempSync(join(tmpdir(),'cm-budget-'));directories.push(root);const store=new CanonicalStore(root,{hardLimitBytes:128});
 expect(()=>store.apply(store.snapshot(),[{op:'put_section',target:'profile',section:null,title:'State',body:'x'.repeat(128)}])).toThrow('hard limit');
 expect(()=>new CanonicalStore(root,{hardLimitBytes:0})).toThrow('Invalid document limit');
});

it('rechecks the read set and fencing immediately before publishing the commit marker',()=>{
 const {root}=setup();const store=new CanonicalStore(root,{checkpoint:phase=>{if(phase==='staged')writeFileSync(join(root,'memory/profile.md'),'# Profile\n\n## Manual\nPreserve\n');}});
 const snapshot=store.snapshot();const updates=store.apply(snapshot,[{op:'put_section',target:'profile',section:null,title:'State',body:'model'}]);
 expect(()=>store.commit(snapshot,updates,{id:'conflict'})).toThrow('STALE_REVISION');store.recover();expect(store.receipts()).toEqual([]);expect(store.snapshot()[0]!.content).toContain('Preserve');
 const current=store.snapshot();const normal=new CanonicalStore(root);expect(()=>normal.commit(current,new Map(),{id:'fenced'},()=>{throw new Error('STALE_LEASE');})).toThrow('STALE_LEASE');normal.recover();expect(normal.receipts()).toEqual([]);
});
