import * as clack from "@clack/prompts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RemoteDisclosurePolicy } from "../memory-manager/contracts/disclosure.js";
type ProvenanceType = RemoteDisclosurePolicy["allowedProvenance"][number];
import { configFilePath, defaultConfig, envFilePath, loadConfig, loadLocalEnv, saveApiKeyToEnvFile, saveConfig, type CommonMemoryConfig } from "../config/config.js";
import { normalizeOpenAICompatibleBaseUrl } from "../memory-manager/openai/openai-responses-adapter.js";

const PROVENANCE_OPTIONS: Array<{ value: ProvenanceType; label: string; hint: string }> = [
  { value: "user_explicit", label: "Delivered user expressions", hint: "Includes corrections and forget requests" },
  { value: "agent_observation", label: "Assistant context", hint: "Context only, not independent evidence" },
];

export async function runTui(): Promise<void> {
  clack.intro("Common Memory");
  let config = loadConfig();
  if (!config) {
    clack.note("Configure the remote OpenAI-compatible API before Common Memory can run.", "First-time setup");
    config = await runSetupWizard(null);
  }
  let running = true;
  while (running) {
    const action = unwrap(await clack.select({
      message: "What do you want to do?",
      options: [
        { value: "status", label: "Status" },
        { value: "configure", label: "Configure remote API" },
        { value: "exit", label: "Exit" },
      ],
    }));
    if (action === "configure") config = await runSetupWizard(config);
    else if (action === "status") showStatus(config);
    else running = false;
  }
  clack.outro("Done.");
}

export async function runSetupWizard(existing: CommonMemoryConfig | null = loadConfig()): Promise<CommonMemoryConfig> {
  const current = existing ?? defaultConfig();
  const baseUrl = unwrap(await clack.text({
    message: "OpenAI-compatible Base URL",
    initialValue: current.remote.baseUrl,
    placeholder: "https://api.openai.com/v1",
    validate: (value) => { try { normalizeOpenAICompatibleBaseUrl(value ?? ""); } catch (error) { return error instanceof Error ? error.message : "Invalid Base URL"; } },
  }));
  const model = unwrap(await clack.text({
    message: "Model name",
    initialValue: current.remote.model,
    placeholder: "gpt-5.6",
    validate: (value) => value?.trim() ? undefined : "Model is required",
  }));
  const apiKeyEnv = unwrap(await clack.text({
    message: "API key environment variable",
    initialValue: current.remote.apiKeyEnv,
    placeholder: "OPENAI_API_KEY",
    validate: (value) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value?.trim() ?? "") ? undefined : "Use a valid environment variable name",
  }));
  const apiKey = unwrap(await clack.password({
    message: `API key (stored only in ${envFilePath()})`,
    validate: (value) => value?.trim() ? undefined : "API key is required",
  }));
  const dataRoot = unwrap(await clack.text({
    message: "Local memory data directory",
    initialValue: current.dataRoot,
    validate: (value) => value?.trim() ? undefined : "Data directory is required",
  }));
  const scopesText = unwrap(await clack.text({
    message: "Scopes allowed to be sent remotely (comma-separated)",
    initialValue: current.disclosure.allowedScopes.join(", "),
    validate: (value) => parseScopes(value ?? "").length ? undefined : "At least one scope is required",
  }));
  const allowedProvenance = unwrap(await clack.multiselect<ProvenanceType>({
    message: "Evidence types allowed to be sent remotely",
    options: PROVENANCE_OPTIONS,
    initialValues: [...current.disclosure.allowedProvenance],
    required: true,
  }));
  const config: CommonMemoryConfig = {
    schemaVersion: 2,
    writableScopes: [...current.writableScopes],
    scheduler: {...current.scheduler},
    dataRoot: expandPath(dataRoot.trim()),
    remote: {
      provider: "openai-compatible",
      baseUrl: normalizeOpenAICompatibleBaseUrl(baseUrl),
      model: model.trim(),
      apiKeyEnv: apiKeyEnv.trim(),
    },
    disclosure: {
      ...current.disclosure,
      allowedScopes: parseScopes(scopesText),
      allowedProvenance,
    },
  };
  const confirmed = unwrap(await clack.confirm({ message: "Save this configuration?", initialValue: true }));
  if (!confirmed) throw new UserCancelled();
  saveConfig(config);
  saveApiKeyToEnvFile(config.remote.apiKeyEnv, apiKey);
  clack.log.success(`Configuration saved to ${configFilePath()}`);
  clack.log.success(`API key stored locally in ${envFilePath()}`);
  showStatus(config);
  return config;
}

export function showStatus(config: CommonMemoryConfig): void {
  loadLocalEnv();
  const keyConfigured = Boolean(process.env[config.remote.apiKeyEnv]?.trim());
  clack.note([
    `Base URL: ${config.remote.baseUrl}`,
    `Responses endpoint: ${config.remote.baseUrl}/responses`,
    `Model: ${config.remote.model}`,
    `API key: ${keyConfigured ? `configured in ${envFilePath()}` : `missing (${config.remote.apiKeyEnv})`}`,
    `Data: ${config.dataRoot}`,
    `Remote scopes: ${config.disclosure.allowedScopes.join(", ")}`,
  ].join("\n"), "Common Memory status");
}

export function printStatus(): void {
  const config = loadConfig();
  if (!config) { console.log(`Common Memory is not configured. Run: common-memory`); return; }
  loadLocalEnv();
  console.log(`Base URL: ${config.remote.baseUrl}`);
  console.log(`Model: ${config.remote.model}`);
  console.log(`API key: ${process.env[config.remote.apiKeyEnv]?.trim() ? "configured" : "missing"}`);
  console.log(`Data: ${config.dataRoot}`);
}

function parseScopes(value: string): string[] { return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))]; }
function expandPath(value: string): string { const expanded = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value; return resolve(expanded); }
function unwrap<T>(value: T | symbol): T { if (clack.isCancel(value)) { clack.cancel("Cancelled."); throw new UserCancelled(); } return value as T; }
export class UserCancelled extends Error { constructor() { super("Cancelled"); this.name = "UserCancelled"; } }
