import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeRange } from './node-support.mjs';

const root = fileURLToPath(new URL("../", import.meta.url));
const forbidden = ["memory_analysis_v1", "interface Fact", "class Recall", "embedding", "pgvector", "better-sqlite3"];
const sourceRoot = join(root, "src");
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
}
await walk(sourceRoot);
const violations = [];
for (const file of files) {
  const text = await readFile(file, "utf8");
  const displayPath = relative(root, file).replaceAll("\\", "/");
  const projectPath = `/${displayPath}`;
  if (displayPath !== 'src/cli/prompt-runtime.ts' && text.includes('@clack/prompts')) violations.push(`${displayPath} bypasses the CLI prompt warning barrier`);
  if (displayPath !== 'src/v2/sqlite.ts' && /(?:from\s*["']node:sqlite["']|(?:import|require)\(["']node:sqlite["']\))/.test(text.replace(/import type[^;]+;/g, ''))) violations.push(`${displayPath} bypasses lazy SQLite loading`);
  if (!projectPath.startsWith('/src/mcp/') && text.includes('@modelcontextprotocol')) violations.push(`${displayPath} imports MCP outside its adapter`);
  for (const term of forbidden) if (text.toLowerCase().includes(term.toLowerCase())) violations.push(`${displayPath} contains forbidden term ${term}`);
  if (projectPath.includes("/service/") && /from ["']\.\.\/repository\/loader/.test(text)) violations.push(`${displayPath} bypasses LockedRepositorySession`);
  const core = projectPath.includes('/src/core/') || projectPath.includes('/src/v2/');
  if (core && /memory-agent-runtime\/|memory-manager\/|@earendil-works\/pi-/.test(text)) violations.push(`${displayPath} makes Core depend on the agent implementation`);
  if (projectPath.includes('/src/memory-agent-runtime/') && /(?:from|import\()\s*["'][^"']*(?:v2\/|core\/(?:repository|transaction))/.test(text)) violations.push(`${displayPath} grants the agent Core storage authority`);
  if (/\/src\/(?:cli|mcp|pi-extension)\//.test(projectPath) && /memory-agent-runtime\/(?:agent|provider)\.js|\.decide\(/.test(text)) violations.push(`${displayPath} directly invokes Memory Agent intelligence`);
  if (projectPath.includes("/src/core/") && (text.includes("pi-extension/") || text.includes("@earendil-works/pi-"))) violations.push(`${displayPath} makes Core depend on Pi`);
  if (projectPath.includes("/src/pi-extension/") && /core\/(?:repository|transaction|governance)/.test(text)) violations.push(`${displayPath} makes the Pi adapter depend on Core internals`);
  if (projectPath.includes("/src/recall/") && /(?:governanceAuthority|automatedGovernanceAuthority|trustedContributor)/.test(text)) violations.push(`${displayPath} grants recall write authority`);
  if (!projectPath.includes("/src/cli/") && text.includes("@clack/prompts")) violations.push(`${displayPath} imports TUI dependencies outside the CLI`);

}
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (pkg.engines?.node !== nodeRange) violations.push('package engines and verification runtime policy disagree');
if (Object.keys(pkg.exports ?? {}).some((key) => key !== ".")) violations.push("package exports a deep path");
if ([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].some((name) => name === "openai" || name.startsWith("@openai/"))) violations.push("package depends on an OpenAI SDK");
if (violations.length) { console.error(violations.join("\n")); process.exit(1); }
console.log(`boundary check passed (${files.length} source files)`);
