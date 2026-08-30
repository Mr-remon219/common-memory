import { readFileSync } from "node:fs";
const parsed = JSON.parse(readFileSync(new URL("../../../schema/memory-analysis.v1.schema.json", import.meta.url), "utf8")) as Record<string, unknown>;
export const memoryAnalysisSchema: Readonly<Record<string, unknown>> = deepFreeze(parsed);
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
