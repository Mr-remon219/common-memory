import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const forbidden = ["@modelcontextprotocol", "embedding", "pgvector", "better-sqlite3"];
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
  for (const term of forbidden) if (text.toLowerCase().includes(term.toLowerCase())) violations.push(`${displayPath} contains forbidden term ${term}`);
  if (projectPath.includes("/service/") && /from ["']\.\.\/repository\/loader/.test(text)) violations.push(`${displayPath} bypasses LockedRepositorySession`);
  if (projectPath.includes("/src/core/") && text.includes("memory-manager/")) violations.push(`${displayPath} makes Core depend on the remote manager`);
  if (projectPath.includes("/src/core/") && (text.includes("pi-extension/") || text.includes("@earendil-works/pi-"))) violations.push(`${displayPath} makes Core depend on Pi`);
  if (projectPath.includes("/memory-manager/openai/") && /core\/(?:repository|transaction|governance)/.test(text)) violations.push(`${displayPath} makes provider code depend on Core internals`);
  if (projectPath.includes("/src/pi-extension/") && /core\/(?:repository|transaction|governance)/.test(text)) violations.push(`${displayPath} makes the Pi adapter depend on Core internals`);
  if (projectPath.includes("/src/recall/") && /(?:governanceAuthority|automatedGovernanceAuthority|trustedContributor)/.test(text)) violations.push(`${displayPath} grants recall write authority`);
  if (!projectPath.includes("/src/cli/") && text.includes("@clack/prompts")) violations.push(`${displayPath} imports TUI dependencies outside the CLI`);
  if (!projectPath.endsWith("/src/memory-manager/openai/openai-responses-adapter.ts") && text.includes("https://api.openai.com/v1/responses")) violations.push(`${displayPath} constructs the provider endpoint outside the adapter`);
}
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (Object.keys(pkg.exports ?? {}).some((key) => key !== ".")) violations.push("package exports a deep path");
if ([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].some((name) => name === "openai" || name.startsWith("@openai/"))) violations.push("package depends on an OpenAI SDK");
if (violations.length) { console.error(violations.join("\n")); process.exit(1); }
console.log(`boundary check passed (${files.length} source files)`);
