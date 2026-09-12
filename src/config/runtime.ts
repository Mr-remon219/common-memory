import { OpenAIResponsesMemoryModel } from "../memory-manager/openai/openai-responses-adapter.js";
import { OpenAIChatMemoryModel } from "../memory-manager/openai/openai-chat-adapter.js";
import type { RemoteHttpOptions } from "../memory-manager/openai/remote-http.js";
import type { RemoteTuning } from "../memory-manager/openai/options.js";
import { NetworkClient } from "../memory-manager/network/client.js";
import { resolveRoute, networkSecret, networkConfigError, type RouteDescription } from "../memory-manager/network/route.js";
import { readPrivateEnv, localApiKey } from "./private-env.js";
import { loadLocalEnv, validateConfig, envFilePath, type CommonMemoryConfig } from "./config.js";

export type ConfiguredModelOverrides = Omit<RemoteHttpOptions, "apiKey" | "model" | "baseUrl" | "disclosurePolicy" | "network"> & RemoteTuning;

export function createConfiguredMemoryModel(
  config: CommonMemoryConfig,
  env: NodeJS.ProcessEnv = process.env,
  overrides: ConfiguredModelOverrides = {},
): OpenAIResponsesMemoryModel | OpenAIChatMemoryModel {
  config = validateConfig(config);
  if (!config.remote.proxy && !config.remote.apiKeySource && env === process.env) loadLocalEnv();
  const privateEnv = env === process.env || env.COMMON_MEMORY_HOME ? readPrivateEnv(envFilePath(env)) : {};
  const apiKey = localApiKey(config.remote.apiKeyEnv, config.remote.apiKeySource === 'private-env' ? {} : env, privateEnv);
  const route = resolveRoute(config.remote.baseUrl,config.remote.proxy,env,privateEnv);
  const caFile = config.remote.caFileEnv === undefined ? undefined : networkSecret(config.remote.caFileEnv,env,privateEnv);
  if (config.remote.caFileEnv !== undefined && !caFile?.trim()) throw networkConfigError("ca_config_invalid");
  const network = overrides.fetch ? undefined : new NetworkClient(config.remote.baseUrl,route,caFile);
  const Model = config.remote.api === "chat_completions" ? OpenAIChatMemoryModel : OpenAIResponsesMemoryModel;
  try { return new Model({
    ...config.remote,
    ...overrides,
    ...(network ? {network} : {}),
    apiKey,
    model: config.remote.model,
    baseUrl: config.remote.baseUrl,
    disclosurePolicy: config.disclosure,
  }); } catch (error) { void network?.close().catch(() => {}); throw error; }
}

import { Writer, type WriterOptions } from "../v2/writer.js";
/**
 * The Writer itself is provenance-neutral: each batch is checked against `disclosure.allowedProvenance`
 * before any network call, so an init-only or import-only configuration processes what it authorizes
 * and quarantines the rest locally. Hosts that only capture user turns check `user_explicit` themselves.
 */
export function createConfiguredWriter(config: CommonMemoryConfig): ConfiguredWriter {
  config = validateConfig(config);
  if (!config.remote.proxy && !config.remote.apiKeySource) loadLocalEnv();
  // Capture owns SQLite before route/CA/dispatcher setup. Freeze all routing inputs now;
  // one lazy client (or controlled admission failure) is reused for every request.
  const env = {...process.env}, privateEnv = readPrivateEnv(envFilePath(env));
  const apiKey = localApiKey(config.remote.apiKeyEnv, config.remote.apiKeySource === 'private-env' ? {} : env, privateEnv);
  const legacyFetch = config.remote.proxy ? undefined : globalThis.fetch;
  let network: NetworkClient | undefined, initializationError: unknown, attempted = false;
  const deferredFetch: typeof fetch = async (input, init) => {
    if (legacyFetch) return legacyFetch(input, init);
    if (!attempted) {
      attempted = true;
      try {
        const route = resolveRoute(config.remote.baseUrl, config.remote.proxy, env, privateEnv);
        const ca = config.remote.caFileEnv === undefined ? undefined : networkSecret(config.remote.caFileEnv, env, privateEnv);
        if (config.remote.caFileEnv !== undefined && !ca?.trim()) throw networkConfigError('ca_config_invalid');
        network = new NetworkClient(config.remote.baseUrl, route, ca);
      } catch (error) { initializationError = error; }
    }
    if (initializationError) throw initializationError;
    return network!.fetch(input, init);
  };
  const Model = config.remote.api === 'chat_completions' ? OpenAIChatMemoryModel : OpenAIResponsesMemoryModel;
  const model = new Model({...config.remote, apiKey, disclosurePolicy:config.disclosure, fetch:deferredFetch});
  const closeTransport = async () => { await network?.close(); };
  try { return new ConfiguredWriter({ modelVersion: config.remote.model, maxRequestBytes: config.disclosure.maxTotalBytes, dataRoot: config.dataRoot, model, allowedScopes: config.disclosure.allowedScopes, writableScopes: config.writableScopes, allowedProvenance: config.disclosure.allowedProvenance, scheduler: config.scheduler, ...(config.sessionCache ? {sessionCache:config.sessionCache} : {}) }, model, closeTransport); }
  catch (error) { void model.close().catch(() => {}); throw error; }
}

/** Ownership belongs to the configured host composition, not to the borrowed MemoryModelPort. */
class ConfiguredWriter extends Writer {
  readonly #model: OpenAIResponsesMemoryModel | OpenAIChatMemoryModel;
  readonly #closeTransport: () => Promise<void>;
  readonly #abort = new AbortController();
  readonly #runs = new Set<Promise<{outcome:string;reason?:string}>>();
  #closing: Promise<void> | undefined;
  constructor(options: WriterOptions, model: OpenAIResponsesMemoryModel | OpenAIChatMemoryModel, closeTransport: () => Promise<void>) { super(options); this.#model = model; this.#closeTransport = closeTransport; }
  override run(options: {force?:boolean;signal?:AbortSignal} = {}): Promise<{outcome:string;reason?:string}> {
    if (this.#abort.signal.aborted) return Promise.reject(new Error('CANCELLED'));
    const run = super.run({...options,signal:AbortSignal.any([this.#abort.signal,...(options.signal ? [options.signal] : [])])});
    this.#runs.add(run);
    void run.then(() => this.#runs.delete(run), () => this.#runs.delete(run));
    return run;
  }
  override close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#abort.abort();
    return this.#closing = Promise.allSettled([...this.#runs]).then(async () => {
      try { super.close(); } finally { try { await this.#model.close(); } finally { await this.#closeTransport(); } }
    });
  }
}
/** No sockets, database, environment mutation or directory creation. This describes configuration only. */
export function describeConfiguredNetwork(config: CommonMemoryConfig, env: NodeJS.ProcessEnv = process.env): RouteDescription {
  const privateEnv = env === process.env || env.COMMON_MEMORY_HOME ? readPrivateEnv(envFilePath(env)) : {};
  return resolveRoute(config.remote.baseUrl,config.remote.proxy,env,privateEnv).description;
}
