import { BlockList, isIP } from 'node:net';
import { MemoryModelError } from '../contracts/errors.js';

export type ProxyConfig = { mode: 'direct' | 'env' } | { mode: 'custom'; urlEnv: string; noProxy?: string };
export type NetworkEnvironment = Readonly<Record<string, string | undefined>>;
export const PRIVATE_PROXY_KEY = 'COMMON_MEMORY_PROXY_URL';
export const PRIVATE_CA_KEY = 'COMMON_MEMORY_CA_FILE';
export const PRIVATE_NETWORK_KEYS = [PRIVATE_PROXY_KEY, PRIVATE_CA_KEY] as const;
export interface RouteDescription {
  mode: 'legacy' | ProxyConfig['mode'];
  route: 'host' | 'direct' | 'proxy';
  reason: 'legacy_host' | 'direct_mode' | 'no_proxy_configured' | 'no_proxy_match' | 'custom_proxy' | 'https_proxy' | 'http_proxy' | 'all_proxy';
  protocol?: 'http' | 'https' | 'socks5';
}
/** A private URL must never be included in status, errors or persisted diagnostics. */
export type ResolvedRoute = { description: RouteDescription; proxyUrl?: string };
export function networkConfigError(reason: 'proxy_config_invalid' | 'ca_config_invalid' | 'no_proxy_invalid' = 'proxy_config_invalid'): MemoryModelError {
  return new MemoryModelError('CONFIGURATION', reason === 'ca_config_invalid' ? 'Invalid local CA configuration' : reason === 'no_proxy_invalid' ? 'Invalid NO_PROXY list; use hosts, IP literals or IP CIDRs; arbitrary wildcards are unsupported' : 'Invalid proxy configuration', false, {stage:'network_config',reason,retryable:false});
}
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/u;
export function validateProxyConfig(value: unknown): ProxyConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw networkConfigError();
  const p = value as Record<string, unknown>;
  if (p.mode === 'direct' || p.mode === 'env') {
    if (Object.keys(p).some(k => k !== 'mode')) throw networkConfigError();
    return {mode:p.mode};
  }
  if (p.mode !== 'custom' || Object.keys(p).some(k => !['mode','urlEnv','noProxy'].includes(k)) || typeof p.urlEnv !== 'string' || !envName.test(p.urlEnv) || (p.noProxy !== undefined && typeof p.noProxy !== 'string')) throw networkConfigError();
  if (p.noProxy !== undefined) parseBypass(p.noProxy as string);
  return {mode:'custom',urlEnv:p.urlEnv,...(p.noProxy === undefined ? {} : {noProxy:p.noProxy as string})};
}
export function validateCaEnv(value: unknown): string {
  if (typeof value !== 'string' || !envName.test(value)) throw networkConfigError('ca_config_invalid');
  return value;
}
/** Other custom names are deliberately external-env-only: legacy loaders cannot export new private secrets. */
export function networkSecret(name: string, env: NetworkEnvironment, privateEnv: NetworkEnvironment): string | undefined {
  if (env[name] !== undefined) return env[name];
  return PRIVATE_NETWORK_KEYS.some(k => k === name) ? privateEnv[name] : undefined;
}
/** Source priority applies to the whole semantic group before spelling/case priority. */
function group(name: string, env: NetworkEnvironment, privateEnv: NetworkEnvironment): string {
  for (const source of [env, privateEnv]) {
    if (source[name] !== undefined) return source[name]!.trim();
    if (source[name.toUpperCase()] !== undefined) return source[name.toUpperCase()]!.trim();
  }
  return '';
}
export function resolveRoute(endpoint: string, proxy: ProxyConfig | undefined, env: NetworkEnvironment, privateEnv: NetworkEnvironment = {}): ResolvedRoute {
  const url = new URL(endpoint);
  if (!['http:','https:'].includes(url.protocol)) throw networkConfigError();
  if (!proxy) return {description:{mode:'legacy',route:'host',reason:'legacy_host'}};
  if (proxy.mode === 'direct') return {description:{mode:'direct',route:'direct',reason:'direct_mode'}};
  if (proxy.mode === 'custom') {
    const selected = proxyUri(networkSecret(proxy.urlEnv, env, privateEnv));
    if (bypasses(url, proxy.noProxy ?? '')) return {description:{mode:'custom',route:'direct',reason:'no_proxy_match'}};
    return {description:{mode:'custom',route:'proxy',reason:'custom_proxy',protocol:selected.protocol},proxyUrl:selected.url};
  }
  const candidates = url.protocol === 'https:' ? ['https_proxy','http_proxy','all_proxy'] as const : ['http_proxy','all_proxy'] as const;
  const selected = candidates.map(name => ({name,value:group(name, env, privateEnv)})).find(p => p.value);
  if (!selected) return {description:{mode:'env',route:'direct',reason:'no_proxy_configured'}};
  if (bypasses(url, group('no_proxy', env, privateEnv))) return {description:{mode:'env',route:'direct',reason:'no_proxy_match'}};
  const uri = proxyUri(selected.value);
  return {description:{mode:'env',route:'proxy',reason:selected.name,protocol:uri.protocol},proxyUrl:uri.url};
}
function proxyUri(value: string | undefined): {url:string;protocol:'http'|'https'|'socks5'} {
  if (!value?.trim() || /[\r\n\0]/u.test(value)) throw networkConfigError();
  let u: URL; try { u = new URL(value.trim()); } catch { throw networkConfigError(); }
  if (!['http:','https:','socks5:','socks:'].includes(u.protocol) || !u.hostname || u.search || u.hash || (u.pathname && u.pathname !== '/') || u.port === '0') throw networkConfigError();
  try { decodeURIComponent(u.username); decodeURIComponent(u.password); } catch { throw networkConfigError(); }
  return {url:u.href,protocol:u.protocol === 'http:' ? 'http' : u.protocol === 'https:' ? 'https' : 'socks5'};
}
type Bypass = { host: string; ip: boolean; port?: number; all?: boolean } | { subnet: BlockList; family: 4 | 6 };
function host(value: string): {host:string;ip:boolean} {
  let normalized: string;
  try {
    const literal = value.replace(/^\[|\]$/gu, '');
    const u = new URL(`http://${isIP(literal) === 6 ? `[${literal}]` : value}`);
    if (u.username || u.password || u.port || u.pathname !== '/' || u.search || u.hash) throw networkConfigError();
    normalized = u.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase();
  } catch { throw networkConfigError(); }
  if (!normalized || normalized === '.' || (!isIP(normalized) && !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/u.test(normalized))) throw networkConfigError();
  return {host:normalized,ip:isIP(normalized) !== 0};
}
function parseBypass(value: string): Bypass[] {
  try { return parseBypassRules(value); } catch { throw networkConfigError('no_proxy_invalid'); }
}
function parseBypassRules(value: string): Bypass[] {
  return value.split(/[,\s]+/u).filter(Boolean).map(token => {
    if (token === '*') return {host:'',ip:false,all:true};
    if (token.includes('/')) {
      const parts = /^([^/%]+)\/(\d+)$/u.exec(token);
      const family = parts ? isIP(parts[1]!) : 0;
      if (!parts || (family !== 4 && family !== 6)) throw networkConfigError();
      const prefix = Number(parts[2]);
      if (!Number.isSafeInteger(prefix) || prefix > (family === 4 ? 32 : 128)) throw networkConfigError();
      const subnet = new BlockList();
      subnet.addSubnet(parts[1]!, prefix, family === 4 ? 'ipv4' : 'ipv6');
      return {subnet, family};
    }
    if (/[@?#]/u.test(token)) throw networkConfigError();
    let name = token, port: number | undefined;
    const bracket = /^\[([^\]]+)\](?::(\d+))?$/u.exec(token);
    if (bracket) { name = bracket[1]!; if (isIP(name) !== 6) throw networkConfigError(); if (bracket[2] !== undefined) port = Number(bracket[2]); }
    else if (!isIP(token) && token.includes(':')) {
      const pair = /^([^:]+):(\d+)$/u.exec(token); if (!pair) throw networkConfigError(); name = pair[1]!; port = Number(pair[2]);
    }
    if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) throw networkConfigError();
    name = name.replace(/^\*?\./u, '');
    if (name.includes('*')) throw networkConfigError();
    return {...host(name),...(port === undefined ? {} : {port})};
  });
}
export function bypasses(endpoint: URL, value: string): boolean {
  const target = host(endpoint.hostname), port = Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80));
  return parseBypass(value).some(rule => 'subnet' in rule ? isIP(target.host) === rule.family && rule.subnet.check(target.host, rule.family === 4 ? 'ipv4' : 'ipv6') : rule.all || ((rule.port === undefined || rule.port === port) && (target.host === rule.host || (!target.ip && !rule.ip && target.host.endsWith(`.${rule.host}`)))));
}
