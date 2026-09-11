import { expect, it } from 'vitest';
import { validateDecision } from '../../src/v2/contract.js';
import type { DocumentSnapshot } from '../../src/v2/canonical.js';

const documents = ['profile', 'preferences', 'project:a', 'project:b'].map(target => ({
  target, sections: [{ref:'s1',title:'Existing',body:'State'}],
})) as DocumentSnapshot[];
const evidence = new Map([['ev_1','project:a']]);
function response(kind = 'retain', applicability: unknown = 'global', target = 'preferences', refs = ['ev_1']) {
  return {version:'memory_maintenance_v2',request_id:'request',decisions:[{
    kind, applicability, confidence:1, evidence:refs, reason:'Scripted decision',
    ...(kind === 'retain' ? {admission:'update',lifetime:'until_changed'} : {}),
    ...(kind === 'ignore' ? {} : {operations:[{op:'put_section',target,section:'s1',title:'Existing',body:'State'}]}),
  }]};
}
it.each(['retain','maintain','forget','ignore'])('requires valid applicability on %s', kind => {
  for (const applicability of [undefined, null, 'other']) {
    expect(() => validateDecision(response(kind,applicability === undefined ? null : applicability),'request',documents,evidence)).toThrow('INVALID_DECISION');
  }
  const old = response(kind); delete (old.decisions[0] as {applicability?:unknown}).applicability;
  expect(() => validateDecision(old,'request',documents,evidence)).toThrow('INVALID_DECISION');
});
it.each(['retain','maintain','forget'])('rejects uncertain and mismatched %s writes', kind => {
  for (const [applicability,target] of [['uncertain','preferences'],['project','profile'],['global','project:a']]) {
    expect(() => validateDecision(response(kind,applicability,target),'request',documents,evidence)).toThrow('UNAUTHORIZED_SCOPE');
  }
});
it('allows uncertain only as ignore; classification fields remain forbidden', () => {
  expect(() => validateDecision(response('ignore','uncertain'),'request',documents,evidence)).not.toThrow();
  for (const field of ['domain','memory_type']) {
    const body = response(); Object.assign(body.decisions[0]!, {[field]:'communication'});
    expect(() => validateDecision(body,'request',documents,evidence)).toThrow('INVALID_DECISION');
  }
});
it('permits promotion and empty-evidence global maintenance, but never A to B', () => {
  for (const kind of ['retain','maintain','forget']) {
    expect(() => validateDecision(response(kind),'request',documents,evidence)).not.toThrow();
    expect(() => validateDecision(response(kind,'project','project:a'),'request',documents,evidence)).not.toThrow();
    expect(() => validateDecision(response(kind,'project','project:b',kind === 'maintain' ? [] : ['ev_1']),'request',documents,evidence)).toThrow('UNAUTHORIZED_SCOPE');
  }
  expect(() => validateDecision(response('maintain','global','profile',[]),'request',documents,evidence)).not.toThrow();
});
it.each(['retain','forget'])('%s requires current evidence', kind => {
  expect(() => validateDecision(response(kind,'global','profile',[]),'request',documents,evidence)).toThrow('MISSING_EVIDENCE');
});
it.each(['retain','forget','maintain','ignore'])('%s rejects fabricated and context-only evidence', kind => {
  for (const ref of ['ev_999','context_1']) expect(() => validateDecision(response(kind,'global','profile',[ref]),'request',documents,evidence)).toThrow('INVALID_EVIDENCE_REFERENCE');
});
it('requires authorized document and section handles', () => {
  expect(() => validateDecision(response(),'request',documents.filter(d=>d.target.startsWith('project:')),evidence)).toThrow('INVALID_TARGET_REFERENCE');
  const body = response(); body.decisions[0]!.operations![0]!.section='s999';
  expect(() => validateDecision(body,'request',documents,evidence)).toThrow('INVALID_TARGET_REFERENCE');
});

it('rejects invalid admission and lifetime instead of silently normalizing model output',()=>{
 for(const field of ['admission','lifetime']) for(const value of [null,0,true,{},[],'unsupported']) {
  const invalid=response();Object.assign(invalid.decisions[0]!,{[field]:value});
  expect(()=>validateDecision(invalid,'request',documents,evidence),`${field}=${JSON.stringify(value)}`).toThrow('INVALID_DECISION');
 }
});
