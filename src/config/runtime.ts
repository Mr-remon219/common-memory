import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { withRepositoryLock } from '../v2/lock.js';
import { inputLimits } from '../core/safety/external-preflight.js';
import { ProviderMemoryAgent, type ProviderOptions } from '../memory-agent-runtime/provider.js';
import { NetworkClient } from '../memory-agent-runtime/network/client.js';
import { resolveRoute, networkSecret, networkConfigError, type RouteDescription } from '../memory-agent-runtime/network/route.js';
import { readPrivateEnv, localApiKey } from './private-env.js';
import { validateConfig, loadConfig, configDirectory, configFilePath, envFilePath, type CommonMemoryConfig } from './config.js';
import { Writer } from '../v2/writer.js';

export type ConfiguredAgentOverrides = Pick<ProviderOptions, 'maxRetries'> & { fetch?: typeof fetch };
/** Composition owns frozen credentials, lazy transport, and teardown; Core borrows only a neutral port. */
export function createConfiguredMemoryAgent(config: CommonMemoryConfig, env: NodeJS.ProcessEnv = process.env, overrides: ConfiguredAgentOverrides = {}) {
  return configuredMemoryAgent(validateConfig(config), env, overrides, readPrivateEnv(envFilePath(env)));
}
function configuredMemoryAgent(config: CommonMemoryConfig, env: NodeJS.ProcessEnv, overrides: ConfiguredAgentOverrides, privateEnv: Record<string, string | undefined>) {
  const frozenEnv = { ...env };
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
    configurationVersion: createHash('sha256').update(JSON.stringify([config, privateEnv])).digest('hex'),
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
  let agent: ReturnType<typeof createConfiguredMemoryAgent>;
  try { agent = createConfiguredMemoryAgent(config); }
  catch { agent = {configurationVersion:'unavailable',decide:async()=>{throw new Error('CONFIGURATION');},close:async()=>{}}; }
  try { return new ConfiguredWriter(config, agent); }
  catch (error) { void agent.close(); throw error; }
}
class ConfiguredWriter extends Writer {
  readonly #abort = new AbortController();
  readonly #runs = new Set<Promise<{outcome:string;reason?:string}>>();
  #closing: Promise<void> | undefined;
  readonly #home = configDirectory();
  readonly #env = { ...process.env };
  #saved = existsSync(configFilePath());
  #config: CommonMemoryConfig;
  constructor(config: CommonMemoryConfig, public agent: ReturnType<typeof createConfiguredMemoryAgent>) {
    super({ maxSourceBytes:inputLimits(config.disclosure).maxSourceBytes ?? undefined, modelVersion: config.remote.model, ...(config.disclosure.maxTotalBytes == null ? {} : {maxRequestBytes: config.disclosure.maxTotalBytes}), dataRoot: config.dataRoot, agent, allowedScopes: config.disclosure.allowedScopes, writableScopes: config.writableScopes, allowedProvenance: config.disclosure.allowedProvenance, scheduler: config.scheduler, ...(config.sessionCache ? {sessionCache:config.sessionCache} : {}) });
    this.#config = config;
  }
  override run(options: {force?:boolean;signal?:AbortSignal} = {}) {
    if (this.#abort.signal.aborted) return Promise.reject(new Error('CANCELLED'));
    if (this.#runs.size) return Promise.resolve({outcome:'idle',reason:'ACTIVE_TASK'});
    const run = this.#run(options);
    this.#runs.add(run); void run.then(() => this.#runs.delete(run), () => this.#runs.delete(run)); return run;
  }
  async #run(options: {force?:boolean;signal?:AbortSignal}) {
    // The installer uses this same lock for config + private credentials. Never observe
    // half of a saved transaction, or silently retain old settings after a broken save.
    try {
      const snapshot = withRepositoryLock(join(this.#home, '.installation'), () => {
        if (existsSync(join(this.#home, '.installation/transaction.json'))) throw new Error('CONFIGURATION_TRANSACTION_PENDING');
        const saved=existsSync(join(this.#home,'config.json'));
        const config = saved || this.#saved ? loadConfig(join(this.#home, 'config.json')) : this.#config;
        if(saved)this.#saved=true;
        if (!config || config.dataRoot !== this.#config.dataRoot) throw new Error('CONFIGURATION_DATA_ROOT_CHANGED');
        const privateEnv = readPrivateEnv(join(this.#home, '.env'));
        return {config, privateEnv};
      });
      const version = createHash('sha256').update(JSON.stringify([snapshot.config, snapshot.privateEnv])).digest('hex');
      if (version !== this.agent.configurationVersion) {
        const next = configuredMemoryAgent(snapshot.config, {...this.#env,COMMON_MEMORY_HOME:this.#home}, {}, snapshot.privateEnv);
        await this.agent.close();
        this.agent = next;
      }
      this.#config = snapshot.config;
      this.store.configureScheduler(snapshot.config.scheduler);
      this.configure({agent:this.agent,modelVersion:snapshot.config.remote.model,
        configurationVersion:this.agent.configurationVersion,maxAgentTurns:snapshot.config.remote.maxAgentTurns ?? 64,
        maxSourceBytes:inputLimits(snapshot.config.disclosure).maxSourceBytes ?? undefined,
        maxRequestBytes:snapshot.config.disclosure.maxTotalBytes ?? undefined,
        allowedScopes:snapshot.config.disclosure.enabled ? snapshot.config.disclosure.allowedScopes : [],
        writableScopes:snapshot.config.writableScopes,allowedProvenance:snapshot.config.disclosure.allowedProvenance,
        sessionCache:snapshot.config.sessionCache,scheduler:snapshot.config.scheduler});
      this.store.resumeConfiguration(this.agent.configurationVersion);
      const blocked=this.store.blockedConfiguration(this.agent.configurationVersion);
      this.store.setSystemPause(blocked);
      if(blocked)return {outcome:'paused',reason:blocked};
    } catch {
      // Work remains in the durable queue. Configuration is an external condition,
      // not a reason to leak the underlying error or fall back to stale credentials.
      this.store.setSystemPause('CONFIGURATION');
      return {outcome:'paused',reason:'CONFIGURATION'};
    }
    return super.run({...options,signal:AbortSignal.any([this.#abort.signal,...(options.signal ? [options.signal] : [])])});
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
