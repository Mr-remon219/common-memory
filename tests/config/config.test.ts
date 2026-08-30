import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, saveApiKeyToEnvFile, saveConfig } from "../../src/config/config.js";

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
});
