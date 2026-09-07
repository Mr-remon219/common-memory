import { OpenAIResponsesMemoryModel, type OpenAIResponsesMemoryModelOptions } from "../memory-manager/openai/openai-responses-adapter.js";
import { loadLocalEnv, resolveApiKey, type CommonMemoryConfig } from "./config.js";

export type ConfiguredModelOverrides = Omit<OpenAIResponsesMemoryModelOptions, "apiKey" | "model" | "baseUrl" | "disclosurePolicy">;

export function createConfiguredMemoryModel(
  config: CommonMemoryConfig,
  env: NodeJS.ProcessEnv = process.env,
  overrides: ConfiguredModelOverrides = {},
): OpenAIResponsesMemoryModel {
  if (env === process.env) loadLocalEnv();
  return new OpenAIResponsesMemoryModel({
    ...overrides,
    apiKey: resolveApiKey(config, env),
    model: config.remote.model,
    baseUrl: config.remote.baseUrl,
    disclosurePolicy: config.disclosure,
  });
}

import { Writer } from "../v2/writer.js";
/**
 * The Writer itself is provenance-neutral: each batch is checked against `disclosure.allowedProvenance`
 * before any network call, so an init-only or import-only configuration processes what it authorizes
 * and quarantines the rest locally. Hosts that only capture user turns check `user_explicit` themselves.
 */
export function createConfiguredWriter(config: CommonMemoryConfig): Writer {
  return new Writer({ modelVersion: config.remote.model, maxRequestBytes: config.disclosure.maxTotalBytes, dataRoot: config.dataRoot, model: createConfiguredMemoryModel(config), allowedScopes: config.disclosure.allowedScopes, writableScopes: config.writableScopes, allowedProvenance: config.disclosure.allowedProvenance, scheduler: config.scheduler });
}
