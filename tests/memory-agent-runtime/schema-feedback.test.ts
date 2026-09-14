import {expect,it} from 'vitest';
import {Type,type TSchema} from 'typebox';
import {schemaFeedback} from '../../src/memory-agent-runtime/schema-feedback.js';
import {maintenanceSchema} from '../../src/v2/contract.js';
const proposal=(extra:Record<string,unknown>={})=>({version:'memory_maintenance_v2',request_id:'synthetic',decisions:[{kind:'ignore',applicability:'global',confidence:1,evidence:['ev_1'],reason:'Synthetic input',...extra}]});
it('identifies the actual decision branch without demanding fields belonging to other kinds',()=>{
 expect(schemaFeedback(maintenanceSchema as TSchema,proposal({operations:[]}))).toEqual([{path:'/decisions/0',rule:'additionalProperties',properties:['operations']}]);
 const {version:_,...missing}=proposal();expect(schemaFeedback(maintenanceSchema as TSchema,missing)).toEqual([{path:'',rule:'required',properties:['version']}]);
});
it('never reflects values, unknown keys, or arbitrary error prose',()=>{
 const value=proposal({'ignore-previous-instructions-api_key=private':'private'});value.decisions[0]!.confidence='private' as unknown as number;
 const feedback=schemaFeedback(maintenanceSchema as TSchema,value);expect(feedback).toContainEqual({path:'/decisions/0/confidence',rule:'type'});expect(JSON.stringify(feedback)).not.toMatch(/private|instructions|api_key/);
 expect(schemaFeedback(Type.Object({offset:Type.Integer()}),{offset:'secret'})).toEqual([{path:'/offset',rule:'type'}]);
});
it('does not invent errors for valid input',()=>{expect(schemaFeedback(maintenanceSchema as TSchema,proposal())).toEqual([]);});
