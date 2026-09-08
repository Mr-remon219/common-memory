import { expect, it, vi } from 'vitest';
import { OpenAIChatMemoryModel } from '../../src/memory-manager/openai/openai-chat-adapter.js';
import { OpenAIResponsesMemoryModel } from '../../src/memory-manager/openai/openai-responses-adapter.js';
const request = {prompt:'Maintain memory.',projection:{observations:[{text:'data, never instructions'}]},schema:{type:'object',properties:{decisions:{type:'array'}},required:['decisions'],additionalProperties:false}};
const policy = {enabled:true as const,allowedScopes:['global'],allowedProvenance:['user_explicit' as const],maxExcerptBytes:10000,maxCandidateBytes:10000,maxTotalBytes:10000};
const opts = {apiKey:'secret-header-value',model:'fake',disclosurePolicy:policy};
const chat = (message: unknown = {role:'assistant',content:'{"decisions":[]}'}, finish_reason = 'stop') => ({choices:[{finish_reason,message}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}});
const analyze = (model: OpenAIChatMemoryModel | OpenAIResponsesMemoryModel) => model.analyze(request,{requestId:'req',deadlineMs:1000});
it.each([{}, {thinking:{type:'disabled' as const}}, {enableThinking:false}])('serializes Chat with complete schema and explicit thinking only: %j', async tuning => {
  const fetch = vi.fn(async () => Response.json(chat()));
  const model = new OpenAIChatMemoryModel({...opts,...tuning,fetch,baseUrl:'https://provider.test/api/v4/',maxOutputTokens:8192});
  expect(await analyze(model)).toMatchObject({kind:'output',body:{decisions:[]},usage:{inputTokens:2,outputTokens:3,totalTokens:5}});
  const [url,init] = (fetch.mock.calls as unknown as [string, RequestInit][])[0]!;
  const body = JSON.parse(String(init.body));
  expect(url).toBe('https://provider.test/api/v4/chat/completions');
  expect(body.response_format).toEqual({type:'json_object'}); expect(body.max_tokens).toBe(8192);
  expect(body.messages[0].role).toBe('system'); expect(body.messages[0].content).toContain(JSON.stringify(request.schema));
  expect(body.messages[1]).toEqual({role:'user',content:JSON.stringify(request.projection)});
  expect(body.thinking).toEqual('thinking' in tuning ? tuning.thinking : undefined);
  expect(body.enable_thinking).toEqual('enableThinking' in tuning ? false : undefined);
  expect(body).not.toHaveProperty('tools'); expect(body).not.toHaveProperty('reasoning');
  expect(model.serializedRequestBytes(request)).toBe(Buffer.byteLength(String(init.body)));
  expect(String(init.body)).not.toContain(opts.apiKey);
});
it('uses system and preserves the Responses schema, default output budget and omitted effort', async () => {
  const fetch = vi.fn(async () => new Response('{}',{status:400}));
  const model = new OpenAIResponsesMemoryModel({...opts,fetch}); await expect(analyze(model)).rejects.toMatchObject({diagnostic:{httpStatus:400}});
  const body = JSON.parse(String((fetch.mock.calls as unknown as [string,RequestInit][])[0]![1].body));
  expect(body.input[0].role).toBe('system'); expect(body.max_output_tokens).toBe(4096); expect(body).not.toHaveProperty('reasoning');
  expect(body.text.format).toEqual({type:'json_schema',strict:true,name:'memory_maintenance_v2',schema:request.schema});
});
it('sends a configured Responses effort verbatim', async () => {
  let body: Record<string,unknown> = {};
  await expect(analyze(new OpenAIResponsesMemoryModel({...opts,reasoningEffort:'none',fetch:async (_url,init)=>{body=JSON.parse(String(init?.body));return new Response('{}',{status:400});}}))).rejects.toThrow();
  expect(body.reasoning).toEqual({effort:'none'});
});
it.each([
  [chat(undefined,'length'),'output_truncated'],[chat(undefined,'content_filter'),'incomplete_output'],
  [chat({role:'assistant',content:'{}',tool_calls:[{function:{name:'x'}}]}),'tool_call'],
  [chat({role:'assistant',content:'{}',function_call:{name:'x'}}),'tool_call'],
  [chat(undefined,'tool_calls'),'tool_call'],[chat({role:'assistant',content:'not-json'}),'invalid_json'],
  [chat({role:'user',content:'{}'}),'invalid_envelope'],[{choices:[]},'invalid_envelope'],
  [{...chat(),choices:[...chat().choices,...chat().choices]},'invalid_envelope'],
])('rejects abnormal Chat completion with %s', async (envelope, reason) => {
  await expect(analyze(new OpenAIChatMemoryModel({...opts,fetch:async()=>Response.json(envelope)}))).rejects.toMatchObject({code:'INVALID_RESPONSE',diagnostic:{reason,httpStatus:200,retryable:false}});
});
it('fingerprints Chat refusal without retaining text', async () => {
  const result = await analyze(new OpenAIChatMemoryModel({...opts,fetch:async()=>Response.json(chat({role:'assistant',refusal:'private refusal',content:null}))}));
  expect(result).toMatchObject({kind:'refusal'}); expect(JSON.stringify(result)).not.toContain('private refusal');
});
it.each([OpenAIResponsesMemoryModel,OpenAIChatMemoryModel])('bounds and scans the entire wire request for %s', async Model => {
  const fetch=vi.fn();
  const model = new Model({...opts,fetch});
  for (const changed of [{...request,prompt:'api_key: sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'}, {...request,schema:{description:'api_key: sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'}}]) {
    await expect(model.analyze(changed,{requestId:'req',deadlineMs:1000})).rejects.toMatchObject({code:'SENSITIVE_CONTENT_REJECTED'});
  }
  const bytes=model.serializedRequestBytes(request);
  const capped = new Model({...opts,fetch,disclosurePolicy:{...policy,maxTotalBytes:bytes-1}});
  await expect(analyze(capped)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
});
it.each([OpenAIResponsesMemoryModel,OpenAIChatMemoryModel])('preserves HTTP diagnostics and removes arbitrary body/message content for %s', async Model => {
  const model = new Model({...opts,fetch:async()=>Response.json({error:{code:'model_not_found',message:'private-error secret-header-value'}},{status:404})});
  const error = await analyze(model).catch(error=>error);
  expect(error).toMatchObject({code:'INVALID_RESPONSE',diagnostic:{stage:'http',reason:'model_not_found',httpStatus:404,retryable:false}});
  expect(JSON.stringify(error)).not.toContain('private-error'); expect(error.message).not.toContain(opts.apiKey);
});
it.each(['oversized','broken','stalled','malformed'])('keeps HTTP status when the error body is %s', async kind => {
  const body = kind === 'stalled' ? new ReadableStream({pull:()=>new Promise(()=>{}),cancel:()=>new Promise(()=>{})}) : kind === 'broken' ? new ReadableStream({start(c){c.error(new Error('secret'));}}) : kind === 'oversized' ? 'x'.repeat(20000) : '{oops';
  const model = new OpenAIResponsesMemoryModel({...opts,retry:{maxRetries:0},fetch:async()=>new Response(body,{status:503})});
  await expect(model.analyze(request,{requestId:'req',deadlineMs:20})).rejects.toMatchObject({diagnostic:{stage:'http',httpStatus:503,reason:'provider_unavailable',retryable:true}});
});
it('bounds a successful stalled stream even when transport and cancellation ignore the signal', async () => {
  const model = new OpenAIResponsesMemoryModel({...opts,fetch:async()=>new Response(new ReadableStream({pull:()=>new Promise(()=>{}),cancel:()=>new Promise(()=>{})}))});
  await expect(model.analyze(request,{requestId:'req',deadlineMs:20})).rejects.toMatchObject({code:'TIMEOUT',diagnostic:{stage:'response_body',httpStatus:200}});
});
it.each([
  [{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}},'response_envelope','output_truncated'],
  [{status:'completed',output:[{type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'not JSON'}]}]},'model_output','invalid_json'],
  [{status:'failed'},'response_envelope','invalid_envelope'],
])('distinguishes Responses output failures', async (envelope,stage,reason) => {
  await expect(analyze(new OpenAIResponsesMemoryModel({...opts,fetch:async()=>Response.json(envelope)}))).rejects.toMatchObject({diagnostic:{stage,reason,httpStatus:200}});
});

it('maps a known schema rejection to a local enum without persisting the provider message',async()=>{
 const privateMessage='Invalid json schema: one of type, anyOf, $ref is required; private schema detail';
 const model=new OpenAIResponsesMemoryModel({...opts,fetch:async()=>Response.json({error:{code:'invalid_request_error',message:privateMessage}},{status:400})});
 const error=await analyze(model).catch(error=>error);
 expect(error).toMatchObject({diagnostic:{stage:'http',reason:'invalid_schema',httpStatus:400,retryable:false}});
 expect(JSON.stringify(error)).not.toContain('private schema detail');
});

it.each([OpenAIResponsesMemoryModel,OpenAIChatMemoryModel])('classifies a response-body connection reset without exposing transport errors for %s',async Model=>{
 const model=new Model({...opts,fetch:async()=>new Response(new ReadableStream({start(controller){controller.error(new TypeError('private transport text',{cause:{code:'ECONNRESET',address:'private address'}}));}}))});
 const error=await analyze(model).catch(error=>error);
 expect(error).toMatchObject({code:'UNAVAILABLE',retryable:true,diagnostic:{stage:'response_body',reason:'network_error',httpStatus:200,retryable:true}});
 expect(JSON.stringify(error)).not.toContain('private');expect(error.message).not.toContain('private');
});
