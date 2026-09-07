import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, saveApiKeyToEnvFile, saveConfig } from "../../src/config/config.js";
import { createConfiguredWriter } from "../../src/config/runtime.js";
import { createCommonMemoryPiExtension } from "../../src/pi-extension/index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("local configuration", () => {
  it("stores provider settings separately from the private .env API key", () => {
    const root = mkdtempSync(join(tmpdir(), "common-memory-config-")); temporary.push(root);
    const configPath = join(root, "config.json"); const envPath = join(root, ".env");
    const config = defaultConfig({ COMMON_MEMORY_HOME: root }); config.remote.baseUrl = "https://llm.example.test/openai/v1/"; config.remote.model = "compatible-model";
    saveConfig(config, configPath); saveApiKeyToEnvFile(config.remote.apiKeyEnv, "sk-local-secret", envPath);
    const loaded = loadConfig(configPath);
    expect(loaded?.remote).toMatchObject({ baseUrl: "https://llm.example.test/openai/v1", model: "compatible-model", apiKeyEnv: "OPENAI_API_KEY" });
    expect(readFileSync(configPath, "utf8")).not.toContain("sk-local-secret");
    expect(readFileSync(envPath, "utf8")).toContain('OPENAI_API_KEY="sk-local-secret"');
    if (process.platform !== "win32") expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("updates only the configured key and preserves other local env entries", () => {
    const root = mkdtempSync(join(tmpdir(), "common-memory-env-")); temporary.push(root); const envPath = join(root, ".env");
    writeFileSync(envPath, "# local\nOTHER=value\nOPENAI_API_KEY=old\n");
    saveApiKeyToEnvFile("OPENAI_API_KEY", "new-secret", envPath);
    expect(readFileSync(envPath, "utf8")).toBe('# local\nOTHER=value\nOPENAI_API_KEY="new-secret"\n');
  });

  it("an init-only or import-only configuration creates a Writer; Pi capture alone still needs user_explicit", () => {
    const root = mkdtempSync(join(tmpdir(), "common-memory-prov-")); temporary.push(root);
    const config = defaultConfig({ COMMON_MEMORY_HOME: root }); config.remote.model = "m"; config.remote.apiKeyEnv = "CM_PROV_TEST_KEY";
    config.disclosure.allowedProvenance = ["agent_observation", "document_import"];
    process.env.CM_PROV_TEST_KEY = "synthetic-key";
    try { const writer = createConfiguredWriter(config); writer.close(); } // previously threw: Delivered user evidence is not authorized for disclosure
    finally { delete process.env.CM_PROV_TEST_KEY; }
    // The Pi extension refuses to start capture, so no user turn is even staged, and reading is unaffected.
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const pi = { on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, fn); }, registerCommand: () => {} } as unknown as ExtensionAPI;
    createCommonMemoryPiExtension({ configFactory: () => config })(pi);
    const errors: string[] = []; const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try { handlers.get("input")!({ text: "private user words", source: "interactive" }, { cwd: root, hasPendingMessages: () => false, sessionManager: { getSessionId: () => "s", getLeafId: () => null, getBranch: () => [] } }); }
    finally { process.stderr.write = write; }
    expect(errors.join("")).toContain("capture unavailable");
    expect(handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, { cwd: root })).toMatchObject({ systemPrompt: expect.stringContaining("## Common Memory") });
  });
});
