import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ProvenanceType } from "../core/contracts/types.js";
import type { RemoteDisclosurePolicy } from "../memory-manager/contracts/disclosure.js";
import { validateDisclosurePolicy } from "../memory-manager/contracts/disclosure.js";
import { normalizeOpenAICompatibleBaseUrl } from "../memory-manager/openai/openai-responses-adapter.js";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PROVENANCE = new Set<ProvenanceType>(["user_statement", "user_correction", "agent_observation", "imported_event", "project_evidence"]);

export interface CommonMemoryConfig {
  schemaVersion: 1;
  dataRoot: string;
  remote: {
    provider: "openai-compatible";
    baseUrl: string;
    model: string;
    apiKeyEnv: string;
  };
  disclosure: RemoteDisclosurePolicy;
}

export function configDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.COMMON_MEMORY_HOME?.trim() || join(homedir(), ".common-memory"));
}

export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDirectory(env), "config.json");
}

export function envFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDirectory(env), ".env");
}

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): CommonMemoryConfig {
  const directory = configDirectory(env);
  return {
    schemaVersion: 1,
    dataRoot: join(directory, "data"),
    remote: {
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "",
      apiKeyEnv: "OPENAI_API_KEY",
    },
    disclosure: {
      enabled: true,
      allowedScopes: ["global"],
      allowedProvenance: ["user_statement", "user_correction"],
      maxExcerptBytes: 8_000,
      maxCandidateBytes: 4_000,
      maxTotalBytes: 64_000,
    },
  };
}

export function loadConfig(path = configFilePath()): CommonMemoryConfig | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new TypeError(`Invalid Common Memory config: ${path}`); }
  return validateConfig(parsed);
}

export function saveConfig(config: CommonMemoryConfig, path = configFilePath()): void {
  const validated = validateConfig(config);
  writePrivateFile(path, `${JSON.stringify(validated, null, 2)}\n`);
}

export function saveApiKeyToEnvFile(apiKeyEnv: string, apiKey: string, path = envFilePath()): void {
  const name = apiKeyEnv.trim(); const value = apiKey.trim();
  if (!ENV_NAME.test(name)) throw new TypeError("apiKeyEnv must be an environment variable name");
  if (!value || /[\r\n\0]/u.test(value)) throw new TypeError("API key must be a non-empty single line");
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/u) : [];
  const assignment = `${name}=${JSON.stringify(value)}`; const matcher = new RegExp(`^\\s*${escapeRegExp(name)}\\s*=`, "u");
  let replaced = false;
  const next = lines.filter((line, index) => index < lines.length - 1 || line !== "").map((line) => { if (!matcher.test(line)) return line; if (replaced) return null; replaced = true; return assignment; }).filter((line): line is string => line !== null);
  if (!replaced) next.push(assignment);
  writePrivateFile(path, `${next.join("\n")}\n`);
}

export function loadLocalEnv(path = envFilePath()): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function resolveApiKey(config: CommonMemoryConfig, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[config.remote.apiKeyEnv]?.trim();
  if (!value) throw new TypeError(`API key environment variable ${config.remote.apiKeyEnv} is not set`);
  return value;
}

export function validateConfig(value: unknown): CommonMemoryConfig {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "dataRoot", "remote", "disclosure"]) || value.schemaVersion !== 1) throw new TypeError("Unsupported Common Memory config");
  if (typeof value.dataRoot !== "string" || !isAbsolute(value.dataRoot)) throw new TypeError("dataRoot must be an absolute path");
  if (!isRecord(value.remote) || !hasExactKeys(value.remote, ["provider", "baseUrl", "model", "apiKeyEnv"]) || value.remote.provider !== "openai-compatible") throw new TypeError("Invalid remote provider config");
  const baseUrl = typeof value.remote.baseUrl === "string" ? normalizeOpenAICompatibleBaseUrl(value.remote.baseUrl) : "";
  const model = typeof value.remote.model === "string" ? value.remote.model.trim() : "";
  const apiKeyEnv = typeof value.remote.apiKeyEnv === "string" ? value.remote.apiKeyEnv.trim() : "";
  if (!model) throw new TypeError("remote.model is required");
  if (!ENV_NAME.test(apiKeyEnv)) throw new TypeError("remote.apiKeyEnv must be an environment variable name");
  if (!isRecord(value.disclosure) || !hasExactKeys(value.disclosure, ["enabled", "allowedScopes", "allowedProvenance", "maxExcerptBytes", "maxCandidateBytes", "maxTotalBytes"])) throw new TypeError("Invalid disclosure config");
  const disclosure = value.disclosure as unknown as RemoteDisclosurePolicy;
  validateDisclosurePolicy(disclosure);
  if (disclosure.allowedScopes.length === 0 || disclosure.allowedScopes.some((scope) => typeof scope !== "string" || !scope.trim())) throw new TypeError("At least one disclosure scope is required");
  if (disclosure.allowedProvenance.length === 0 || disclosure.allowedProvenance.some((item) => !PROVENANCE.has(item))) throw new TypeError("Invalid disclosure provenance");
  return {
    schemaVersion: 1,
    dataRoot: resolve(value.dataRoot),
    remote: { provider: "openai-compatible", baseUrl, model, apiKeyEnv },
    disclosure: {
      enabled: true,
      allowedScopes: [...disclosure.allowedScopes],
      allowedProvenance: [...disclosure.allowedProvenance],
      maxExcerptBytes: disclosure.maxExcerptBytes,
      maxCandidateBytes: disclosure.maxCandidateBytes,
      maxTotalBytes: disclosure.maxTotalBytes,
    },
  };
}

function writePrivateFile(path: string, content: string): void {
  const directory = dirname(path); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.private.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const fd = openSync(temporary, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    try { chmodSync(path, 0o600); } catch { /* Windows ACLs are managed by the OS. */ }
  } finally { try { rmSync(temporary, { force: true }); } catch { /* best effort */ } }
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
