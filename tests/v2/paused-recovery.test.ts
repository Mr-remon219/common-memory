import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore } from '../../src/v2/runtime.js';
import { drainSessions } from '../../src/v2/session-drain.js';
import { nextForOutcome } from '../../src/v2/service-guidance.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive:true,force:true}); });
function store() { const root=mkdtempSync(join(tmpdir(),'cm-paused-'));roots.push(root);return new RuntimeStore(root); }
function queued(s:RuntimeStore) { s.enqueue({sessionId:'synthetic',entryId:'one',text:'Prefer concise replies.',scope:'global',source:'interactive',observedAt:'2026-09-01T00:00:00Z'});return s.claim()!; }

it('coordinates configuration recovery even when the only accepted task is paused', async () => {
  const s=store(), job=queued(s);s.configureTask(job,'old');s.fail(job,new Error('AUTHENTICATION'));
  const run=vi.fn(async () => {s.resumeConfiguration('new');const resumed=s.claim()!;expect(resumed.id).toBe(job.id);s.finish(resumed,{jobId:job.id,observationIds:job.observations.map(o=>o.id)});return {outcome:'ignored'};});
  try { expect(await drainSessions({store:s,run})).toBe(true);expect(run).toHaveBeenCalledOnce();expect(s.hasReceipt(job.id)).toBe(true); }
  finally {s.close();}
});

it.each(['AUTHENTICATION','PROXY_AUTHENTICATION','CONFIGURATION'])('migrates legacy dead %s in place into configuration recovery', code => {
  const s=store(),job=queued(s);s.configureTask(job,'old');s.fail(job,new Error(code));
  // v0.4.2 can encounter terminal jobs written before paused/configuration recovery existed.
  s.db.prepare("UPDATE jobs SET state='dead',attempts=3,retries=2 WHERE id=?").run(job.id);
  s.db.prepare("UPDATE observations SET state='dead' WHERE jobId=?").run(job.id);
  try {s.resumeConfiguration('new');const resumed=s.claim();expect(resumed?.id).toBe(job.id);expect(s.status().jobs[0]).toMatchObject({attempts:4,automaticRecoveries:3});expect(s.observationOutcome('synthetic','one')?.jobId).toBe(job.id);}
  finally {s.close();}
});

it.each(['CANCELLED','RECOVERY_CONFLICT','FORGOTTEN_SOURCE'])('never revives legacy %s as a configuration repair', code => {
  const s=store(),job=queued(s);s.fail(job,new Error(code));s.db.prepare("UPDATE jobs SET state='dead' WHERE id=?").run(job.id);s.db.prepare("UPDATE observations SET state='dead' WHERE jobId=?").run(job.id);
  try {s.resumeConfiguration('new');expect(s.claim()).toBeNull();expect(s.status().jobs[0]?.automaticRecoveries).toBe(0);}finally{s.close();}
});

it.each(['AUTHENTICATION','CANCELLED','AGENT_TURN_LIMIT','RECOVERY_BUDGET_EXHAUSTED'])('does not advise polling a paused %s task', code => {
  const s=store(),job=queued(s);s.fail(job,new Error(code));
  try {expect(nextForOutcome(s.observationOutcome('synthetic','one'),{submissionId:'one'},['global']).action).not.toBe('poll');}
  finally {s.close();}
});
