import { expect, it, vi } from 'vitest';
import { ProviderMemoryAgent, modelCapability, providerModel } from '../../src/memory-agent-runtime/provider.js';
import { probeMemoryAgent } from '../../src/v2/connection-probe.js';
import { toolProvider, sendTools } from '../helpers/tool-provider.js';
import { validateRemoteTuning } from '../../src/memory-agent-runtime/options.js';
import { defaultConfig, validateConfig } from '../../src/config/config.js';

it.each(['responses','chat_completions'] as const)('executes real Pi HTTP tool loop with %s and omits every Unlimited output parameter',async api=>{
  const explore=toolProvider(),wires:Record<string,unknown>[]=[];
  const fake:typeof fetch=async(_input,init)=>{
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-key');
    const wire=JSON.parse(String(init?.body));wires.push(wire);let response='';
    const res={setHeader:()=>{},end:(data:unknown)=>{response=String(data);return undefined;}};
    const projection=explore(wire,res as never);
    if(projection)sendTools(res as never,wire,[{name:'submit_memory_decision',args:{version:'memory_maintenance_v2',request_id:projection.request_id,decisions:[{kind:'ignore',confidence:1,applicability:'uncertain',evidence:[],reason:'synthetic'}]}}]);
    return new Response(response,{headers:{'content-type':'text/event-stream'}});
  };
  const agent=new ProviderMemoryAgent({api,baseUrl:'https://provider.test/prefix/v1',apiKey:'synthetic-key',model:'fake',fetch:fake});
  expect(await probeMemoryAgent(agent,new AbortController().signal)).toBe(true);expect(wires.length).toBeGreaterThan(2);
  for(const wire of wires){for(const key of ['max_tokens','max_completion_tokens','max_output_tokens'])expect(wire).not.toHaveProperty(key);expect(wire.stream).toBe(true);expect(wire).not.toHaveProperty('response_format');}
  expect(JSON.stringify(wires[0])).not.toContain('No user facts');expect(JSON.stringify(wires)).toContain('No user facts');
});
it.each([
  ['responses',{reasoningEffort:'none',maxOutputTokens:1},{reasoning:{effort:'none'},max_output_tokens:1,store:false}],
  ['chat_completions',{thinking:{type:'disabled'},maxOutputTokens:32000},{thinking:{type:'disabled'},max_completion_tokens:32000}],
  ['chat_completions',{enableThinking:true},{enable_thinking:true}],
] as const)('preserves explicit output and reasoning wire controls (%s)',async(api,tuning,expected)=>{
  let wire:unknown;
  const agent=new ProviderMemoryAgent({api,...tuning,baseUrl:'https://provider.test/v1',model:'fake',apiKey:'synthetic',fetch:async(_url,init)=>{wire=JSON.parse(String(init?.body));return new Response('{}',{status:400});}});
  await expect(probeMemoryAgent(agent,new AbortController().signal)).rejects.toMatchObject({code:'INVALID_RESPONSE'});expect(wire).toMatchObject(expected);
});
it.each([401,403,404,407,429,503])('preserves HTTP status and bounded diagnostics without raw provider secrets (%s)',async status=>{
  const agent=new ProviderMemoryAgent({baseUrl:'https://provider.test/v1',model:'fake',apiKey:'synthetic',maxRetries:0,fetch:async()=>Response.json({error:{code:'model_not_found',message:'PRIVATE_PROVIDER_BODY'}},{status})});
  const error=await probeMemoryAgent(agent,new AbortController().signal).catch(e=>e);
  expect(error.diagnostic).toMatchObject({httpStatus:status,reason:'model_not_found',retryable:status===429||status>=500});expect(JSON.stringify(error)).not.toContain('PRIVATE_PROVIDER_BODY');expect(error.message).not.toContain('PRIVATE_PROVIDER_BODY');
});
it.each(['oversized','malformed','broken','stalled'])('keeps status on a %s HTTP error body',async kind=>{
  const controller=new AbortController();
  const body=kind==='stalled'?new ReadableStream({pull:()=>new Promise(()=>{}),cancel:()=>new Promise(()=>{})}):kind==='broken'?new ReadableStream({start(c){c.error(new Error('PRIVATE'));}}):kind==='oversized'?'x'.repeat(20000):'{bad';
  const agent=new ProviderMemoryAgent({baseUrl:'https://provider.test',model:'fake',apiKey:'synthetic',maxRetries:0,fetch:async()=>new Response(body,{status:503})});
  const error=await probeMemoryAgent(agent,controller.signal).catch(e=>e);expect(error.diagnostic).toMatchObject({httpStatus:503,retryable:true,reason:'provider_unavailable'});
});
it('delegates exactly two 429 retries to Pi and never retries authentication',async()=>{
  for(const status of [429,401]){
    const fetch=vi.fn(async()=>new Response('{}',{status,headers:{'retry-after':'0'}}));
    const agent=new ProviderMemoryAgent({baseUrl:'https://provider.test',model:'fake',apiKey:'synthetic',fetch});
    await expect(probeMemoryAgent(agent,new AbortController().signal)).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(status===429?3:1);
  }
});
it('cancels retry waits without another request',async()=>{
  const controller=new AbortController();const fetch=vi.fn(async()=>{setTimeout(()=>controller.abort(new Error('CANCELLED')),10);return new Response('{}',{status:429,headers:{'retry-after':'1'}});});
  const agent=new ProviderMemoryAgent({baseUrl:'https://provider.test',model:'fake',apiKey:'synthetic',fetch});
  await expect(probeMemoryAgent(agent,controller.signal)).rejects.toThrow('CANCELLED');expect(fetch).toHaveBeenCalledOnce();
});
it('fences a fetch that ignores cancellation, without accepting a late response',async()=>{
  const controller=new AbortController();const fetch=vi.fn(()=>new Promise<Response>(()=>{}));
  const agent=new ProviderMemoryAgent({baseUrl:'https://provider.test',model:'fake',apiKey:'synthetic',fetch});
  setTimeout(()=>controller.abort(new Error('CANCELLED')),10);
  await expect(probeMemoryAgent(agent,controller.signal)).rejects.toThrow('CANCELLED');expect(fetch).toHaveBeenCalledOnce();
});
it('honors explicit wire caps before fetch and validates configuration without old 16K clamp',async()=>{
  const fetch=vi.fn();const agent=new ProviderMemoryAgent({baseUrl:'https://provider.test',model:'fake',apiKey:'synthetic',fetch,maxInputBytes:10});
  await expect(probeMemoryAgent(agent,new AbortController().signal)).rejects.toMatchObject({code:'SENSITIVE_CONTENT_REJECTED'});expect(fetch).not.toHaveBeenCalled();
  expect(validateRemoteTuning({maxOutputTokens:32000},'responses')).toEqual({maxOutputTokens:32000});
  for(const maxOutputTokens of [0,1.5,-1,Infinity])expect(()=>validateRemoteTuning({maxOutputTokens},'responses')).toThrow();
  const config=defaultConfig();config.remote.model='fake';expect(validateConfig(config).disclosure.maxTotalBytes).toBeNull();
  expect(validateConfig({...config,disclosure:{enabled:true,allowedScopes:['global'],allowedProvenance:['user_explicit']}}).disclosure.maxTotalBytes).toBeNull();
});
it('catalog capabilities require exact official endpoint/model, unknown does not become a one-token cap',()=>{
  const unknown={baseUrl:'https://gateway.test',model:'gpt-5'};
  expect(modelCapability(unknown)).toMatchObject({source:'unknown/custom',contextWindow:null});expect(providerModel(unknown).maxTokens).toBe(0);
  const known=modelCapability({baseUrl:'https://api.openai.com/v1',model:'gpt-5'});expect(known.source).toBe('official-catalog');expect(known.contextWindow).toBeGreaterThan(0);
  expect(modelCapability({baseUrl:'https://api.openai.com/v1',model:'does-not-exist'}).source).toBe('unknown/custom');
  expect(modelCapability({baseUrl:'https://api.openai.com/v1',model:'gpt-5',api:'chat_completions'}).source).toBe('unknown/custom');
});
it('selection-time capability records cannot promote a custom endpoint to an official window',()=>{
 const config=defaultConfig();config.remote.model='gpt-5';config.remote.baseUrl='https://custom.test';
 config.remote.capability={source:'official-catalog',version:'pi-ai 0.85.1',digest:'a'.repeat(64),contextWindow:999999,maxOutput:888888};
 expect(modelCapability(validateConfig(config).remote).source).toBe('unknown/custom');
 expect(()=>validateConfig({...config,remote:{...config.remote,capability:{...config.remote.capability,digest:'invalid'}}})).toThrow('capability');
});
