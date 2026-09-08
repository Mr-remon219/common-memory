import { openSync, constants, fstatSync, readSync, closeSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { getCACertificates } from 'node:tls';
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { MemoryModelError } from '../contracts/errors.js';
import type { DiagnosticReason, FailureDiagnostic } from '../contracts/diagnostic.js';
import { networkConfigError, type ResolvedRoute } from './route.js';

/** One fixed origin and route, owned by one model client. No global dispatcher mutation. */
export class NetworkClient {
  readonly #borrowedFetch: typeof fetch | undefined;
  readonly #dispatcher: Dispatcher | undefined;
  readonly #origin: string;
  readonly #route: ResolvedRoute['description'];
  #closing: Promise<void> | undefined;
  constructor(endpoint: string, route: ResolvedRoute, caFile?: string) {
    this.#origin = new URL(endpoint).origin;
    this.#route = Object.freeze({...route.description});
    if (route.description.mode === 'legacy') { this.#borrowedFetch = globalThis.fetch; return; }
    const tls = {rejectUnauthorized:true, ...(caFile === undefined ? {} : {ca:readCertificates(caFile)})};
    try {
      this.#dispatcher = route.proxyUrl
        ? new ProxyAgent({uri:route.proxyUrl, requestTls:tls, ...(route.description.protocol === "https" ? {proxyTls:tls} : {})})
        : new Agent({connect:tls});
    } catch { throw networkConfigError(); }
  }
  get route(): ResolvedRoute['description'] { return {...this.#route}; }
  readonly fetch: typeof fetch = async (input, init) => {
    if (this.#closing) throw new MemoryModelError('CANCELLED','Network client is closed');
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== this.#origin) throw networkConfigError();
    // Legacy deliberately borrows the host route, including its historic redirect behavior.
    if (!this.#dispatcher) return this.#borrowedFetch!(input, init);
    try {
      return await undiciFetch(url, {...init, redirect:'error', dispatcher:this.#dispatcher} as Parameters<typeof undiciFetch>[1]) as unknown as Response;
    } catch (error) {
      if (init?.signal?.aborted) throw error;
      throw networkFailure(error, this.#route.route === 'proxy');
    }
  };
  close(): Promise<void> {
    // destroy aborts active connections and releases idle sockets; never touches borrowed resources.
    return this.#closing ??= this.#dispatcher?.destroy() ?? Promise.resolve();
  }
}

function readCertificates(path: string): string[] {
  let fd: number | undefined;
  try {
    if (!path.trim()) throw new Error();
    fd = openSync(path,constants.O_RDONLY | constants.O_NONBLOCK); const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 1_048_576) throw new Error();
    const buffer = Buffer.alloc(1_048_577);
    let size = 0, count: number;
    while (size < buffer.length && (count = readSync(fd,buffer,size,buffer.length-size,null)) > 0) size += count;
    if (size > 1_048_576) throw new Error();
    const pem = buffer.subarray(0,size).toString('utf8');
    const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu);
    if (!certs?.length || pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu,'').trim()) throw new Error();
    for (const cert of certs) new X509Certificate(cert);
    return [...getCACertificates('default'),...certs];
  } catch { throw networkConfigError('ca_config_invalid'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Inspect only bounded, allowlisted transport codes; never persist exception text or URLs. */
export function networkFailure(error: unknown, proxied: boolean): MemoryModelError {
  const chain: Array<{code?:unknown;message?:unknown}> = [];
  for (let item = error, depth = 0; item && typeof item === 'object' && depth < 8; depth++) {
    chain.push(item); item = (item as {cause?:unknown}).cause;
  }
  let proxyStatus: number | undefined;
  if (proxied) for (const item of chain) {
    if (item.code === 'UND_ERR_INVALID_ARG' && item.message === 'Proxy Authentication Required (407)') proxyStatus = 407;
    if (item.code === 'UND_ERR_ABORTED' && typeof item.message === 'string') {
      const match = /^Proxy response \((\d{3})\) !== 200 when HTTP Tunneling$/u.exec(item.message);
      if (match) proxyStatus = Number(match[1]);
    }
  }
  const has = (...codes: string[]) => chain.some(item => typeof item.code === 'string' && codes.includes(item.code));
  let reason: DiagnosticReason = 'network_error';
  if (proxyStatus === 407 || has('UND_ERR_SOCKS5_AUTH_FAILED','UND_ERR_SOCKS5_AUTH_REJECTED')) reason = 'proxy_authentication';
  else if (has('ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','CERT_SIGNATURE_FAILURE','UND_ERR_PRX_TLS')) reason = 'tls_verification_failed';
  else if (proxyStatus !== undefined) reason = 'proxy_http_error';
  else if (has('ENOTFOUND','EAI_AGAIN')) reason = proxied ? 'proxy_dns_error' : 'dns_error';
  else if (proxied && has('ECONNREFUSED','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','UND_ERR_CONNECT_TIMEOUT','UND_ERR_PRX_CONN')) reason = 'proxy_unavailable';
  else if (has('ECONNREFUSED')) reason = 'connection_refused';
  const retryable = !['proxy_authentication','tls_verification_failed'].includes(reason) && (proxyStatus === undefined || proxyStatus >= 500);
  const diagnostic: FailureDiagnostic = {stage:'network',reason,retryable,...(proxyStatus === undefined ? {} : {proxyStatus})};
  return new MemoryModelError(reason === 'proxy_authentication' ? 'PROXY_AUTHENTICATION' : 'UNAVAILABLE',`Network failure: ${reason}`,retryable,diagnostic);
}
