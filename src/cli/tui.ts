import { MemoryModelError } from "../memory-manager/contracts/errors.js";
import { describeConfiguredNetwork } from "../config/runtime.js";
import { localApiKey, readPrivateEnv } from "../config/private-env.js";
import { PRIVATE_PROXY_KEY, PRIVATE_CA_KEY, resolveRoute, type ProxyConfig } from "../memory-manager/network/route.js";
import * as clack from "@clack/prompts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RemoteDisclosurePolicy } from "../memory-manager/contracts/disclosure.js";
type ProvenanceType = RemoteDisclosurePolicy["allowedProvenance"][number];
import { configFilePath, defaultConfig, envFilePath, loadConfig, saveNetworkSecret, saveApiKeyToEnvFile, saveConfig, type CommonMemoryConfig } from "../config/config.js";
import { normalizeOpenAICompatibleBaseUrl } from "../memory-manager/openai/openai-responses-adapter.js";

import { storagePathLines } from "./storage-paths.js";

const PROVENANCE_OPTIONS: Array<{ value: ProvenanceType; label: string; hint: string }> = [
  { value: "user_explicit", label: "Delivered user expressions", hint: "Includes corrections and forget requests" },
  { value: "agent_observation", label: "Agent-reported understanding", hint: "Required for Init imports from other agents; stored as attributed, not as user statements" },
  { value: "document_import", label: "Imported Markdown documents", hint: "Required for common-memory import <file.md>; stored as attributed material, never as user statements" },
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
        { value: "network", label: "Configure model network" },
        { value: "exit", label: "Exit" },
      ],
    }));
    if (action === "configure") config = await runSetupWizard(config);
    else if (action === "network") config = await runNetworkWizard(config);
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
      ...current.remote,
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
  const keyConfigured = hasApiKey(config);
  clack.note([
    `Base URL: ${config.remote.baseUrl}`,
    `API: ${config.remote.api ?? "responses"}`,
    `Endpoint: ${config.remote.baseUrl}/${config.remote.api === "chat_completions" ? "chat/completions" : "responses"}`,
    `Model: ${config.remote.model}`,
    `API key: ${keyConfigured ? "configured" : `missing (${config.remote.apiKeyEnv})`}`,
    networkStatus(config),
    ...storagePathLines(config),
    `Remote scopes: ${config.disclosure.allowedScopes.join(", ")}`,
  ].join("\n"), "Common Memory status");
}

export function printStatus(): void {
  const config = loadConfig();
  if (!config) { console.log(`Common Memory is not configured. Run: common-memory`); return; }
  console.log(`Base URL: ${config.remote.baseUrl}`);
  console.log(`Model: ${config.remote.model}`);
  console.log(`API key: ${hasApiKey(config) ? "configured" : "missing"}`);
  console.log(`API: ${config.remote.api ?? "responses"}`);
  console.log(storagePathLines(config).join("\n"));
  console.log(networkStatus(config));
}

function parseScopes(value: string): string[] { return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))]; }
function expandPath(value: string): string { const expanded = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value; return resolve(expanded); }
function unwrap<T>(value: T | symbol): T { if (clack.isCancel(value)) { clack.cancel("Cancelled."); throw new UserCancelled(); } return value as T; }
export class UserCancelled extends Error { constructor() { super("Cancelled"); this.name = "UserCancelled"; } }

function hasApiKey(config: CommonMemoryConfig): boolean {
  try { return Boolean(localApiKey(config.remote.apiKeyEnv,process.env,readPrivateEnv(envFilePath()))); } catch { return false; }
}
function networkStatus(config: CommonMemoryConfig): string {
  try { const route = describeConfiguredNetwork(config); return `Network: ${route.mode} → ${route.route} (${route.reason}${route.protocol ? `, ${route.protocol}` : ''}); connection not tested`; }
  catch (error) { return `Network: ${error instanceof MemoryModelError ? error.message : 'invalid local configuration'}; connection not tested`; }
}
export async function runNetworkWizard(existing: CommonMemoryConfig | null = loadConfig()): Promise<CommonMemoryConfig> {
  if (!existing) throw new Error('Configure the remote API first');
  const mode = unwrap(await clack.select({message:'Model network route',initialValue:existing.remote.proxy?.mode ?? 'env',options:[
    {value:'env' as const,label:'Environment proxy',hint:'HTTPS_PROXY / HTTP_PROXY / ALL_PROXY and NO_PROXY'},
    {value:'direct' as const,label:'Direct',hint:'Independent connections; OS VPN/TUN routing still applies'},
    {value:'custom' as const,label:'Custom proxy',hint:'HTTP/HTTPS; SOCKS5 experimental'},
  ]}));
  let proxy: ProxyConfig = {mode:mode === "custom" ? "env" : mode};
  let secret: string | undefined;
  if (mode === 'custom') {
    secret = unwrap(await clack.password({message:'Proxy URL (credentials allowed; stored privately)',validate:value => {
      try { resolveRoute(existing.remote.baseUrl,{mode:'custom',urlEnv:PRIVATE_PROXY_KEY},{[PRIVATE_PROXY_KEY]:value}); } catch { return 'Use a valid HTTP, HTTPS or SOCKS5 proxy URL'; }
    }}));
    const noProxy = unwrap(await clack.text({message:'Custom bypass hosts (optional; ignores host NO_PROXY)',defaultValue:'',initialValue:existing.remote.proxy?.mode === 'custom' ? existing.remote.proxy.noProxy ?? '' : '',validate:value => {
      try { resolveRoute(existing.remote.baseUrl,{mode:'custom',urlEnv:PRIVATE_PROXY_KEY,noProxy:value ?? ''},{[PRIVATE_PROXY_KEY]:secret}); } catch { return 'Invalid bypass list'; }
    }}));
    proxy = {mode:'custom',urlEnv:PRIVATE_PROXY_KEY,...(noProxy.trim() ? {noProxy:noProxy.trim()} : {})};
  }
  const ca = unwrap(await clack.text({message:'Additional CA PEM file (optional; blank uses Node default trust)',defaultValue:''}));
  const {caFileEnv:_oldCa, ...remote} = existing.remote;
  const next: CommonMemoryConfig = {...existing,remote:{...remote,proxy,...(ca.trim() ? {caFileEnv:PRIVATE_CA_KEY} : {})}};
  if (secret !== undefined) saveNetworkSecret(PRIVATE_PROXY_KEY,secret);
  if (ca.trim()) saveNetworkSecret(PRIVATE_CA_KEY,expandPath(ca.trim()));
  saveConfig(next);
  clack.log.success('Network settings saved. Restart active MCP/Pi clients to apply.');
  showStatus(next);
  return next;
}
