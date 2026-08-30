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
  for (const term of forbidden) if (text.toLowerCase().includes(term.toLowerCase())) violations.push(`${relative(root, file)} contains forbidden term ${term}`);
  if (file.includes("/service/") && /from ["']\.\.\/repository\/loader/.test(text)) violations.push(`${relative(root, file)} bypasses LockedRepositorySession`);
  if (file.includes("/src/core/") && text.includes("memory-manager/")) violations.push(`${relative(root, file)} makes Core depend on the remote manager`);
  if (file.includes("/memory-manager/openai/") && /core\/(?:repository|transaction|governance)/.test(text)) violations.push(`${relative(root, file)} makes provider code depend on Core internals`);
  if (!file.includes("/src/cli/") && text.includes("@clack/prompts")) violations.push(`${relative(root, file)} imports TUI dependencies outside the CLI`);
  if (!file.endsWith("src/memory-manager/openai/openai-responses-adapter.ts") && text.includes("https://api.openai.com/v1/responses")) violations.push(`${relative(root, file)} constructs the provider endpoint outside the adapter`);
}
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (Object.keys(pkg.exports ?? {}).some((key) => key !== ".")) violations.push("package exports a deep path");
if ([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].some((name) => name === "openai" || name.startsWith("@openai/"))) violations.push("package depends on an OpenAI SDK");
if (violations.length) { console.error(violations.join("\n")); process.exit(1); }
console.log(`boundary check passed (${files.length} source files)`);
