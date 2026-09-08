import { Ajv2020 } from 'ajv/dist/2020.js';
import type { DocumentSnapshot } from './canonical.js';
export interface SectionOperation { op: 'put_section' | 'remove_section'; target: string; section: string | null; title?: string; body?: string }
interface CommonDecision { applicability: 'global' | 'project' | 'uncertain'; confidence: number; evidence: string[]; reason: string }
export type Decision = CommonDecision & (
  | { kind: 'retain'; admission: 'remember' | 'update' | 'correct'; lifetime: 'stable' | 'until_changed'; operations: SectionOperation[] }
  | { kind: 'forget' | 'maintain'; operations: SectionOperation[] }
  | { kind: 'ignore' }
);
export interface MaintenanceDecision { version: 'memory_maintenance_v2'; request_id: string; decisions: Decision[] }
// Explicit types on string const/enum fields preserve their value domain and satisfy strict remote schema parsers.
const string = { type: 'string' };
const operationSchema = { anyOf: [
  { type: 'object', additionalProperties: false, required: ['op','target','section','title','body'], properties: { op: { type: 'string', const: 'put_section' }, target: string, section: { type: ['string','null'] }, title: string, body: string } },
  { type: 'object', additionalProperties: false, required: ['op','target','section'], properties: { op: { type: 'string', const: 'remove_section' }, target: string, section: string } },
] };
const common = { applicability: { type: 'string', enum: ['global','project','uncertain'] }, confidence: { type: 'number', minimum: 0, maximum: 1 }, evidence: { type: 'array', items: string, maxItems: 128 }, reason: { type: 'string', maxLength: 4000 } };
export const maintenanceSchema: Readonly<Record<string, unknown>> = {
  type: 'object', additionalProperties: false, required: ['version','request_id','decisions'], properties: {
    version: { type: 'string', const: 'memory_maintenance_v2' }, request_id: string,
    decisions: { type: 'array', minItems: 1, maxItems: 64, items: { anyOf: [
      { type: 'object', additionalProperties: false, required: ['kind','applicability','confidence','evidence','reason','admission','lifetime','operations'], properties: { ...common, kind: { type: 'string', const: 'retain' }, admission: { type: 'string', enum: ['remember','update','correct'] }, lifetime: { type: 'string', enum: ['stable','until_changed'] }, operations: { type: 'array', minItems: 1, maxItems: 32, items: operationSchema } } },
      ...['forget','maintain'].map(kind => ({ type: 'object', additionalProperties: false, required: ['kind','applicability','confidence','evidence','reason','operations'], properties: { ...common, kind: { type: 'string', const: kind }, operations: { type: 'array', minItems: 1, maxItems: 32, items: operationSchema } } })),
      { type: 'object', additionalProperties: false, required: ['kind','applicability','confidence','evidence','reason'], properties: { ...common, kind: { type: 'string', const: 'ignore' } } },
    ] } },
  },
};
const validate = new Ajv2020({ strict: false, allErrors: true }).compile(maintenanceSchema);
export function validateDecision(body: unknown, requestId: string, documents: DocumentSnapshot[], evidenceScopes: Map<string,string>): MaintenanceDecision {
  if (!validate(body)) throw new Error('INVALID_DECISION');
  const result = body as MaintenanceDecision;
  if (result.request_id !== requestId) throw new Error('INVALID_REQUEST_REFERENCE');
  const touched = new Set<string>();
  for (const decision of result.decisions) {
    if (decision.evidence.some(ref => !evidenceScopes.has(ref))) throw new Error('INVALID_EVIDENCE_REFERENCE');
    if ((decision.kind === 'retain' || decision.kind === 'forget') && !decision.evidence.length) throw new Error('MISSING_EVIDENCE');
    if (decision.kind === 'ignore') continue;
    for (const op of decision.operations) {
      const doc = documents.find(doc => doc.target === op.target);
      if (!doc || op.section !== null && !doc.sections.some(s => s.ref === op.section)) throw new Error('INVALID_TARGET_REFERENCE');
      // Applicability describes the destination; evidence scopes describe origin only.
      const projectTarget = op.target.startsWith('project:');
      if (decision.applicability !== (projectTarget ? 'project' : 'global')) throw new Error('UNAUTHORIZED_SCOPE');
      // Check the whole batch, including maintain decisions with no evidence.
      if (projectTarget && (!evidenceScopes.size || [...evidenceScopes.values()].some(scope => scope !== op.target))) throw new Error('UNAUTHORIZED_SCOPE');
      const key = `${op.target}\0${op.section ?? op.title}`;
      if (touched.has(key)) throw new Error('DUPLICATE_SECTION_OPERATION');
      touched.add(key);
    }
  }
  return result;
}
