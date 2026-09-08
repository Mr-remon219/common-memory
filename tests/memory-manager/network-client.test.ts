import { fileURLToPath } from "node:url";
import { createServer as httpServer, type Server } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { createServer as tcpServer, connect, type Socket } from 'node:net';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { getGlobalDispatcher, setGlobalDispatcher, MockAgent } from 'undici';
import { NetworkClient, networkFailure } from '../../src/memory-manager/network/client.js';
import { resolveRoute } from '../../src/memory-manager/network/route.js';
import { OpenAIResponsesMemoryModel } from '../../src/memory-manager/openai/openai-responses-adapter.js';

const certPath = new URL('./fixtures/network-test-cert.pem',import.meta.url);
const tls = {key:readFileSync(new URL('./fixtures/network-test-key.pem',import.meta.url)),cert:readFileSync(certPath)};
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function listen(server: Server | ReturnType<typeof tcpServer>): Promise<number> {
  const sockets = new Set<Socket>(); server.on('connection', socket => { sockets.add(socket); socket.on('error',()=>{}); socket.on('close',()=>sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  cleanup.push(() => new Promise<void>(resolve => { for (const s of sockets) s.destroy(); server.close(()=>resolve()); }));
  return (server.address() as {port:number}).port;
}
function client(endpoint: string, proxy?: string, ca?: string): NetworkClient {
  const route = resolveRoute(endpoint,proxy ? {mode:'custom',urlEnv:'P'} : {mode:'direct'},{P:proxy});
  const result = new NetworkClient(endpoint,route,ca); cleanup.push(()=>result.close()); return result;
}
const request = {prompt:'Maintain memory.',projection:{observations:[{text:'Synthetic data'}]},schema:{type:'object',properties:{decisions:{type:'array'}},required:['decisions'],additionalProperties:false}};
const policy = {enabled:true as const,allowedScopes:['global'],allowedProvenance:['user_explicit' as const],maxExcerptBytes:10000,maxCandidateBytes:10000,maxTotalBytes:10000};
const envelope = {status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'{"decisions":[]}'}]}]};
function model(baseUrl: string, network: NetworkClient, sleeper?: (ms:number)=>Promise<void>): OpenAIResponsesMemoryModel {
  const result = new OpenAIResponsesMemoryModel({baseUrl,apiKey:'synthetic-key',model:'fake',disclosurePolicy:policy,network,...(sleeper ? {sleeper,retry:{maxRetries:1}} : {retry:{maxRetries:0}})});
  cleanup.push(()=>result.close());return result;
}
const analyze = (value: OpenAIResponsesMemoryModel) => value.analyze(request,{requestId:'r',deadlineMs:2000});

it('isolates direct, two proxy instances and the host global dispatcher, including close', async () => {
  const origin = await listen(httpServer((_q,r)=>r.end('direct')));
  const first = await listen(httpServer((_q,r)=>r.end('first'))), second = await listen(httpServer((_q,r)=>r.end('second')));
  const endpoint = `http://127.0.0.1:${origin}`;
  const previous = getGlobalDispatcher(), host = new MockAgent(); host.disableNetConnect(); setGlobalDispatcher(host);
  cleanup.push(async()=>{setGlobalDispatcher(previous);await host.close();});
  host.get(endpoint).intercept({path:'/'}).reply(200,'host').times(2);
  const direct = client(endpoint), a = client(endpoint,`http://127.0.0.1:${first}`), b = client(endpoint,`http://127.0.0.1:${second}`);
  expect(await (await direct.fetch(endpoint)).text()).toBe('direct');
  expect(await (await a.fetch(endpoint)).text()).toBe('first'); expect(await (await b.fetch(endpoint)).text()).toBe('second');
  expect(await (await fetch(endpoint)).text()).toBe('host');
  await a.close(); await direct.close();
  expect(await (await b.fetch(endpoint)).text()).toBe('second'); expect(await (await fetch(endpoint)).text()).toBe('host');
  await expect(a.fetch(endpoint)).rejects.toMatchObject({code:'CANCELLED'});
});
it.each(['http','https'] as const)('distinguishes %s proxy 407 from provider 401 without leaking credentials', async protocol => {
  const proxy = httpServer((_q,r)=>{r.writeHead(407);r.end('secret proxy text');});
  proxy.on('connect',(_req,socket)=>socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'));
  const port = await listen(proxy), endpoint = `${protocol}://endpoint.invalid`;
  const error = await analyze(model(endpoint,client(endpoint,`http://user:wrong-password@127.0.0.1:${port}`))).catch(e=>e);
  expect(error).toMatchObject({code:'PROXY_AUTHENTICATION',diagnostic:{stage:'network',reason:'proxy_authentication',proxyStatus:407,retryable:false}});
  expect(error.diagnostic).not.toHaveProperty('httpStatus'); expect(JSON.stringify(error)).not.toMatch(/wrong-password|user|secret proxy/);
  const provider = await listen(httpServer((_q,r)=>{r.writeHead(401);r.end('{"error":{"code":"invalid_api_key","message":"secret-key"}}');}));
  const url = `http://127.0.0.1:${provider}`;
  await expect(analyze(model(url,client(url)))).rejects.toMatchObject({code:'AUTHENTICATION',diagnostic:{stage:'http',reason:'authentication',httpStatus:401}});
});
it.each([['http','http'],['http','https'],['https','http'],['https','https']] as const)('supports %s endpoint through %s proxy with verified local CA and separated credentials', async (originProtocol,proxyProtocol) => {
  let originCalls = 0, proxyCalls = 0;
  const origin = (originProtocol === 'https' ? httpsServer.bind(null,tls) : httpServer)((req,res)=>{originCalls++; expect(req.headers['proxy-authorization']).toBeUndefined(); expect(req.headers.authorization).toBe('Bearer origin-key');res.end('origin');});
  const originPort = await listen(origin);
  const proxy = proxyProtocol === 'https' ? httpsServer(tls) : httpServer();
  const auth = `Basic ${Buffer.from('name:pass').toString('base64')}`;
  proxy.on('request',(req,res)=>{
    proxyCalls++;expect(req.headers['proxy-authorization']).toBe(auth);expect(req.headers.authorization).toBe('Bearer origin-key');
    // The HTTP forwarding path is observable independently of the HTTPS CONNECT path.
    expect(req.url).toBe(`http://127.0.0.1:${originPort}/`);res.end('forwarded');
  });
  proxy.on('connect',(req,socket,head)=>{
    proxyCalls++;expect(req.headers['proxy-authorization']).toBe(auth);expect(req.headers.authorization).toBeUndefined();
    const upstream = connect(originPort,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});
    socket.on('close',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());
  });
  const proxyPort = await listen(proxy), endpoint = `${originProtocol}://127.0.0.1:${originPort}`;
  const network = client(endpoint,`${proxyProtocol}://name:pass@127.0.0.1:${proxyPort}`,fileURLToPath(certPath));
  expect(await (await network.fetch(endpoint,{headers:{authorization:'Bearer origin-key'}})).text()).toBe(originProtocol === 'https' ? 'origin' : 'forwarded');
  expect(proxyCalls).toBe(1);expect(originCalls).toBe(originProtocol === 'https' ? 1 : 0);
});
it('keeps TLS verification enabled, validates local CA and refuses invalid certificates', async () => {
  const port = await listen(httpsServer(tls,(_q,r)=>r.end('trusted'))), endpoint = `https://127.0.0.1:${port}`;
  await expect(client(endpoint).fetch(endpoint)).rejects.toMatchObject({diagnostic:{reason:'tls_verification_failed'}});
  expect(await (await client(endpoint,undefined,fileURLToPath(certPath)).fetch(endpoint)).text()).toBe('trusted');
  const root = mkdtempSync(join(tmpdir(),'cm-ca-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const invalid = join(root,'invalid.pem');writeFileSync(invalid,'PRIVATE CA CONTENT');
  for (const path of [invalid,root,join(root,'missing'),'']) expect(()=>client(endpoint,undefined,path)).toThrow('Invalid local CA configuration');
});
it('checks endpoint hostnames with a trusted CA', async () => {
  const originPort = await listen(httpsServer(tls,(_q,r)=>r.end('unexpected')));
  const proxy = httpServer();proxy.on('connect',(_q,socket)=>{
    const upstream = connect(originPort,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 OK\r\n\r\n');socket.pipe(upstream);upstream.pipe(socket);});
    socket.on('close',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());
  });
  const port = await listen(proxy), endpoint = 'https://wrong-host.invalid';
  await expect(client(endpoint,`http://127.0.0.1:${port}`,fileURLToPath(certPath)).fetch(endpoint)).rejects.toMatchObject({diagnostic:{reason:'tls_verification_failed'}});
});
it('rejects redirects and cross-origin reuse without following to another host', async () => {
  let escaped = 0;const other = await listen(httpServer((_q,r)=>{escaped++;r.end('bad');}));
  const port = await listen(httpServer((_q,r)=>{r.writeHead(302,{location:`http://127.0.0.1:${other}`});r.end();}));
  const endpoint = `http://127.0.0.1:${port}`, network = client(endpoint);
  await expect(network.fetch(endpoint)).rejects.toMatchObject({diagnostic:{reason:'network_error'}});
  await expect(network.fetch(`http://127.0.0.1:${other}`)).rejects.toMatchObject({code:'CONFIGURATION'});expect(escaped).toBe(0);
});
it('keeps the route and dispatcher across retries even when environment changes', async () => {
  let attempts = 0, otherCalls = 0;
  const first = await listen(httpServer((_q,r)=>{attempts++;r.writeHead(attempts === 1 ? 503 : 200,{'content-type':'application/json'});r.end(attempts === 1 ? '{}' : JSON.stringify(envelope));}));
  const second = await listen(httpServer((_q,r)=>{otherCalls++;r.end('{}');}));
  const endpoint = 'http://endpoint.invalid', env = {HTTP_PROXY:`http://127.0.0.1:${first}`};
  const network = new NetworkClient(endpoint,resolveRoute(endpoint,{mode:'env'},env));cleanup.push(()=>network.close());
  const value = model(endpoint,network,async()=>{env.HTTP_PROXY=`http://127.0.0.1:${second}`;});
  expect(await analyze(value)).toMatchObject({kind:'output'});expect(attempts).toBe(2);expect(otherCalls).toBe(0);
});
it('close aborts active requests, is idempotent, blocks new work and never closes borrowed fetch', async () => {
  const reached = Promise.withResolvers<void>();
  const port = await listen(httpServer(()=>reached.resolve())), endpoint = `http://127.0.0.1:${port}`;
  const value = model(endpoint,client(endpoint)); const active = analyze(value).catch(e=>e);await reached.promise;
  const close = value.close();expect(value.close()).toBe(close);await close;
  expect(await active).toMatchObject({code:'CANCELLED'});await expect(analyze(value)).rejects.toMatchObject({code:'CANCELLED'});
  const borrowed = vi.fn(async()=>Response.json(envelope));
  const caller = new OpenAIResponsesMemoryModel({apiKey:'fake',model:'fake',disclosurePolicy:policy,fetch:borrowed});
  await caller.close();expect((await borrowed()).status).toBe(200);
});
it('does not silently fallback after proxy failure; preserves bounded DNS and CONNECT diagnostics', async () => {
  let directCalls = 0;const origin = await listen(httpServer((_q,r)=>{directCalls++;r.end('bad');}));
  const proxy = httpServer();proxy.on('connect',(_q,s)=>s.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'));
  const port = await listen(proxy), endpoint = `https://127.0.0.1:${origin}`;
  await expect(client(endpoint,`http://127.0.0.1:${port}`).fetch(endpoint)).rejects.toMatchObject({diagnostic:{reason:'proxy_http_error',proxyStatus:502,retryable:true}});expect(directCalls).toBe(0);
  await expect(client('http://cm-missing.invalid').fetch('http://cm-missing.invalid')).rejects.toMatchObject({diagnostic:{reason:'dns_error'}});
  expect(networkFailure({cause:{code:'ECONNREFUSED',message:'secret'}},true)).toMatchObject({diagnostic:{reason:'proxy_unavailable'}});
  expect(networkFailure({cause:{code:'ECONNRESET',message:'secret'}},true)).toMatchObject({diagnostic:{reason:'network_error'}});
});
it('experimental SOCKS5 uses remote DNS and separates authentication errors', async () => {
  let target = '';
  const server = tcpServer(socket=>{
    let stage = 0, buffer = Buffer.alloc(0);
    socket.on('data',chunk=>{
      buffer=Buffer.concat([buffer,chunk]);
      if(stage===0 && buffer.length>=3){buffer=buffer.subarray(2+buffer[1]!);socket.write(Buffer.from([5,0]));stage=1;}
      if(stage===1 && buffer.length>=5){
        const size=buffer[4]!;if(buffer.length<7+size)return;expect(buffer[3]).toBe(3);target=buffer.subarray(5,5+size).toString();
        buffer=buffer.subarray(7+size);socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,80]));stage=2;
      }
      if(stage===2 && buffer.includes('\r\n\r\n')){socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');stage=3;}
    });
  });
  const port=await listen(server), endpoint='http://remote-dns.invalid';
  expect(await (await client(endpoint,`socks5://127.0.0.1:${port}`).fetch(endpoint)).text()).toBe('ok');expect(target).toBe('remote-dns.invalid');
  const reject = tcpServer(socket=>socket.once('data',()=>socket.end(Buffer.from([5,255]))));const rejectedPort=await listen(reject);
  await expect(client(endpoint,`socks5://user:wrong@127.0.0.1:${rejectedPort}`).fetch(endpoint)).rejects.toMatchObject({code:'PROXY_AUTHENTICATION',diagnostic:{reason:'proxy_authentication'}});
});

it('legacy captures borrowed host fetch at construction just like the old model', async () => {
  const endpoint='https://legacy.test';vi.stubGlobal('fetch',async()=>new Response('original'));
  const network=new NetworkClient(endpoint,resolveRoute(endpoint,undefined,{}));cleanup.push(()=>network.close());
  vi.stubGlobal('fetch',async()=>new Response('replacement'));
  expect(await (await network.fetch(endpoint)).text()).toBe('original');await network.close();
  expect(await (await fetch(endpoint)).text()).toBe('replacement');
});
it('does not blame the proxy when the TLS endpoint resets an established tunnel', async () => {
  let reached=false;
  const origin=await listen(httpsServer(tls,(req)=>{reached=true;req.socket.destroy();}));
  const proxy=httpServer();proxy.on('connect',(_q,socket)=>{
    const upstream=connect(origin,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 OK\r\n\r\n');socket.pipe(upstream);upstream.pipe(socket);});
    socket.on('close',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());
  });
  const port=await listen(proxy),endpoint=`https://127.0.0.1:${origin}`;
  await expect(client(endpoint,`http://127.0.0.1:${port}`,fileURLToPath(certPath)).fetch(endpoint)).rejects.toMatchObject({diagnostic:{reason:'network_error'}});
  expect(reached).toBe(true);
});

it('verifies the HTTPS proxy hostname independently of the endpoint hostname', async () => {
  const wrongCert=new URL('./fixtures/network-hostname-cert.pem',import.meta.url);
  const port=await listen(httpsServer({key:tls.key,cert:readFileSync(wrongCert)},(_q,r)=>r.end('unexpected')));
  const endpoint='http://endpoint.invalid';
  await expect(client(endpoint,`https://127.0.0.1:${port}`,fileURLToPath(wrongCert)).fetch(endpoint)).rejects.toMatchObject({diagnostic:{reason:'tls_verification_failed'}});
});
