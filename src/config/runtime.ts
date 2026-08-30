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
