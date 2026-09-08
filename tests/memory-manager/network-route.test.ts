import { expect, it } from 'vitest';
import { bypasses, resolveRoute, validateProxyConfig, PRIVATE_PROXY_KEY } from '../../src/memory-manager/network/route.js';
const envMode = {mode:'env'} as const;
it.each([
  ['https://endpoint.test',{HTTPS_PROXY:'http://https.test',HTTP_PROXY:'http://http.test',ALL_PROXY:'http://all.test'},'https.test','https_proxy'],
  ['https://endpoint.test',{HTTP_PROXY:'http://http.test',ALL_PROXY:'http://all.test'},'http.test','http_proxy'],
  ['https://endpoint.test',{ALL_PROXY:'http://all.test'},'all.test','all_proxy'],
  ['http://endpoint.test',{HTTPS_PROXY:'http://https.test',HTTP_PROXY:'http://http.test',ALL_PROXY:'http://all.test'},'http.test','http_proxy'],
  ['http://endpoint.test',{HTTPS_PROXY:'http://https.test',ALL_PROXY:'http://all.test'},'all.test','all_proxy'],
  ['https://endpoint.test',{https_proxy:'http://lower.test',HTTPS_PROXY:'http://upper.test'},'lower.test','https_proxy'],
  ['https://endpoint.test',{https_proxy:'',HTTPS_PROXY:'http://upper.test',HTTP_PROXY:'http://fallback.test'},'fallback.test','http_proxy'],
])('selects a stable explicit route: %s %j', (endpoint,env,hostname,reason) => {
  const result = resolveRoute(endpoint,envMode,env);
  expect(new URL(result.proxyUrl!).hostname).toBe(hostname); expect(result.description.reason).toBe(reason);
});
it('chooses source before lowercase spelling, and treats empty as a cleared group', () => {
  expect(resolveRoute('http://endpoint.test',envMode,{HTTP_PROXY:'http://process.test'},{http_proxy:'http://private.test'}).proxyUrl).toBe('http://process.test/');
  expect(resolveRoute('http://endpoint.test',envMode,{HTTP_PROXY:''},{http_proxy:'http://private.test'}).description.route).toBe('direct');
  expect(resolveRoute('http://endpoint.test',envMode,{HTTP_PROXY:'http://p',NO_PROXY:''},{no_proxy:'*'}).description.route).toBe('proxy');
});
it.each([
  ['http://example.com','example.com',true],['http://a.example.com','.example.com',true],['http://example.com','.example.com',true],
  ['http://badexample.com','example.com',false],['http://example.com.evil','example.com',false],['http://a.b.example.com','*.example.com',true],
  ['https://EXAMPLE.com.','example.com',true],['http://example.com','EXAMPLE.COM.',true],['http://bücher.example','xn--bcher-kva.example',true],
  ['http://127.0.0.1','127.0.0.1',true],['http://127.0.0.2','127.0.0.1',false],['http://localhost','localhost',true],
  ['http://127.0.0.1','localhost',false],['http://localhost','127.0.0.1',false],['http://[::1]','::1',true],
  ['https://[::1]','[0:0:0:0:0:0:0:1]:443',true],['https://[::2]','[::1]',false],['http://[::1]','[::1]:443',false],
  ['https://example.com','example.com:443',true],['https://example.com:443','example.com:443',true],['https://example.com:444','example.com:443',false],
  ['http://example.com','example.com:80',true],['http://example.com:81','example.com:80',false],['http://example.com','*',true],
  ['https://example.com','localhost, * ',true],['http://example.com','foo.test\nexample.com\tbar.test',true],['http://example.com','',false],
])('NO_PROXY contract: %s / %s -> %s', (url,list,expected) => expect(bypasses(new URL(url),list)).toBe(expected));
it.each(['127.0.0.0/8','https://example.com','foo*bar','example.com:0','example.com:65536','[::1]:x','[localhost]','example.com/path','@example.com'])('rejects unsupported bypass syntax: %s', list => {
  expect(() => bypasses(new URL('https://example.com'),list)).toThrow('Invalid NO_PROXY list');
});
it('custom ignores host NO_PROXY and validates its own URI even for bypass', () => {
  const custom = {mode:'custom',urlEnv:PRIVATE_PROXY_KEY} as const;
  expect(resolveRoute('https://endpoint.test',custom,{[PRIVATE_PROXY_KEY]:'http://user:private@proxy.test',NO_PROXY:'*'}).description.route).toBe('proxy');
  expect(resolveRoute('https://endpoint.test',{...custom,noProxy:'endpoint.test'},{[PRIVATE_PROXY_KEY]:'http://proxy.test'}).description.route).toBe('direct');
  expect(() => resolveRoute('https://endpoint.test',{...custom,noProxy:'*'},{[PRIVATE_PROXY_KEY]:'bad-secret'})).toThrow('Invalid proxy configuration');
  expect(resolveRoute('https://endpoint.test',envMode,{HTTP_PROXY:'bad-secret',NO_PROXY:'*'}).description.route).toBe('direct');
});
it('direct ignores proxy settings and legacy describes uncertainty', () => {
  expect(resolveRoute('https://endpoint.test',{mode:'direct'},{HTTP_PROXY:'bad',NO_PROXY:'bad/8'}).description).toEqual({mode:'direct',route:'direct',reason:'direct_mode'});
  expect(resolveRoute('https://endpoint.test',undefined,{HTTP_PROXY:'http://p'}).description).toEqual({mode:'legacy',route:'host',reason:'legacy_host'});
});
it.each(['socks4://p','file:///secret','http://p/a','http://p?secret','http://p#secret','http://p:0','http://u:%zz@p'])('rejects proxy configuration without leaking %s', value => {
  try { resolveRoute('https://endpoint.test',envMode,{ALL_PROXY:value}); throw new Error('missing rejection'); }
  catch (error) { expect(error).toMatchObject({code:'CONFIGURATION',diagnostic:{reason:'proxy_config_invalid'}}); expect(JSON.stringify(error)).not.toContain(value); }
});
it('validates exact keys and supported protocol levels', () => {
  for (const value of [{mode:'direct',urlEnv:'X'},{mode:'env',noProxy:'*'},{mode:'custom',url:'secret'},{mode:'custom',urlEnv:'BAD-NAME'},{mode:'auto'}]) expect(() => validateProxyConfig(value)).toThrow();
  expect(resolveRoute('http://endpoint.test',envMode,{ALL_PROXY:'socks5://p:1080'}).description.protocol).toBe('socks5');
});
