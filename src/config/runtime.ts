import { ProviderMemoryAgent, type ProviderOptions } from '../memory-agent-runtime/provider.js';
import { NetworkClient } from '../memory-agent-runtime/network/client.js';
import { resolveRoute, networkSecret, networkConfigError, type RouteDescription } from '../memory-agent-runtime/network/route.js';
import { readPrivateEnv, localApiKey } from './private-env.js';
import { validateConfig, envFilePath, type CommonMemoryConfig } from './config.js';
import { Writer } from '../v2/writer.js';

export type ConfiguredAgentOverrides = Pick<ProviderOptions, 'maxRetries'> & { fetch?: typeof fetch };
/** Composition owns frozen credentials, lazy transport, and teardown; Core borrows only a neutral port. */
export function createConfiguredMemoryAgent(config: CommonMemoryConfig, env: NodeJS.ProcessEnv = process.env, overrides: ConfiguredAgentOverrides = {}) {
  config = validateConfig(config);
  const frozenEnv = { ...env }, privateEnv = readPrivateEnv(envFilePath(env));
  const apiKey = localApiKey(config.remote.apiKeyEnv, privateEnv);
  const legacyFetch = config.remote.proxy ? undefined : globalThis.fetch;
  let network: NetworkClient | undefined, initializationError: unknown, attempted = false;
  const deferredFetch: typeof fetch = async (input, init) => {
    if (overrides.fetch) return overrides.fetch(input, init);
    if (legacyFetch) return legacyFetch(input, init);
    if (!attempted) {
      attempted = true;
      try {
        const route = resolveRoute(config.remote.baseUrl, config.remote.proxy, frozenEnv, privateEnv);
        const ca = config.remote.caFileEnv === undefined ? undefined : networkSecret(config.remote.caFileEnv, frozenEnv, privateEnv);
        if (config.remote.caFileEnv !== undefined && !ca?.trim()) throw networkConfigError('ca_config_invalid');
        network = new NetworkClient(config.remote.baseUrl, route, ca);
      } catch (error) { initializationError = error; }
    }
    if (initializationError) throw initializationError;
    return network!.fetch(input, init);
  };
  const agent = new ProviderMemoryAgent({ ...config.remote, apiKey, fetch: deferredFetch, maxInputBytes: config.disclosure.maxTotalBytes ?? null, ...(overrides.maxRetries === undefined ? {} : {maxRetries: overrides.maxRetries}) });
  const abort = new AbortController();
  const runs = new Set<ReturnType<typeof agent.decide>>();
  let closing: Promise<void> | undefined;
  return {
    decide: (...args: Parameters<typeof agent.decide>) => {
      if (abort.signal.aborted) return Promise.reject(new Error('CANCELLED'));
      const [task, reads, options] = args;
      const run = agent.decide(task, reads, {...options, signal: AbortSignal.any([abort.signal, options.signal])});
      runs.add(run); void run.then(() => runs.delete(run), () => runs.delete(run)); return run;
    },
    close: () => {
      if (closing) return closing;
      abort.abort(new Error('CANCELLED'));
      return closing = Promise.allSettled([...runs]).then(async () => { await network?.close(); });
    },
  };
}
export function createConfiguredWriter(config: CommonMemoryConfig): ConfiguredWriter {
  config = validateConfig(config);
  const agent = createConfiguredMemoryAgent(config);
  try { return new ConfiguredWriter(config, agent); }
  catch (error) { void agent.close(); throw error; }
}
class ConfiguredWriter extends Writer {
  readonly #abort = new AbortController();
  readonly #runs = new Set<Promise<{outcome:string;reason?:string}>>();
  #closing: Promise<void> | undefined;
  constructor(config: CommonMemoryConfig, readonly agent: ReturnType<typeof createConfiguredMemoryAgent>) {
    super({ modelVersion: config.remote.model, ...(config.disclosure.maxTotalBytes == null ? {} : {maxRequestBytes: config.disclosure.maxTotalBytes}), dataRoot: config.dataRoot, agent, allowedScopes: config.disclosure.allowedScopes, writableScopes: config.writableScopes, allowedProvenance: config.disclosure.allowedProvenance, scheduler: config.scheduler, ...(config.sessionCache ? {sessionCache:config.sessionCache} : {}) });
  }
  override run(options: {force?:boolean;signal?:AbortSignal} = {}) {
    if (this.#abort.signal.aborted) return Promise.reject(new Error('CANCELLED'));
    const run = super.run({...options,signal:AbortSignal.any([this.#abort.signal,...(options.signal ? [options.signal] : [])])});
    this.#runs.add(run); void run.then(() => this.#runs.delete(run), () => this.#runs.delete(run)); return run;
  }
  override close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#abort.abort();
    return this.#closing = Promise.allSettled([...this.#runs]).then(async () => { try { super.close(); } finally { await this.agent.close(); } });
  }
}
/** No sockets, database, environment mutation or directory creation. This describes configuration only. */
export function describeConfiguredNetwork(config: CommonMemoryConfig, env: NodeJS.ProcessEnv = process.env): RouteDescription {
  const privateEnv = env === process.env || env.COMMON_MEMORY_HOME ? readPrivateEnv(envFilePath(env)) : {};
  return resolveRoute(config.remote.baseUrl,config.remote.proxy,env,privateEnv).description;
}
