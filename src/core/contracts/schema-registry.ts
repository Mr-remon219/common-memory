import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { CoreError } from "./errors.js";
import type { Fact, Proposal, RepositoryMetadata, Review } from "./types.js";

export const SCHEMA_FILES = ["repository.v1.schema.json", "fact.v1.schema.json", "proposal.v1.schema.json", "review.v1.schema.json"] as const;
export type SchemaKind = "repository" | "fact" | "proposal" | "review";
const schemas = Object.fromEntries(SCHEMA_FILES.map((name) => [name, JSON.parse(readFileSync(new URL(`../../../schema/${name}`, import.meta.url), "utf8")) as object]));
const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
const addFormats = addFormatsModule as unknown as (instance: Ajv2020) => Ajv2020;
addFormats(ajv);
const validators: Record<SchemaKind, ValidateFunction> = {
  repository: ajv.compile(schemas["repository.v1.schema.json"]!),
  fact: ajv.compile(schemas["fact.v1.schema.json"]!),
  proposal: ajv.compile(schemas["proposal.v1.schema.json"]!),
  review: ajv.compile(schemas["review.v1.schema.json"]!)
};

function sanitizedErrors(errors: ErrorObject[] | null | undefined): object[] {
  return (errors ?? []).map(({ instancePath, keyword, schemaPath }) => ({ field_path: instancePath || "/", rule_id: `schema.${keyword}`, schema_path: schemaPath }));
}
function assertDateTimes(value: unknown, path = ""): void {
  if (Array.isArray(value)) { value.forEach((item, index) => assertDateTimes(item, `${path}/${index}`)); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}/${key}`;
    if ((key.endsWith("_at") || key === "valid_from") && child !== null) {
      if (typeof child !== "string" || Number.isNaN(Date.parse(child))) throw new CoreError("VALIDATION_FAILED", "Record validation failed", { violations: [{ field_path: childPath, rule_id: "schema.datetime" }] });
    }
    assertDateTimes(child, childPath);
  }
}
export function validateRecord(kind: "fact", value: unknown): asserts value is Fact;
export function validateRecord(kind: "proposal", value: unknown): asserts value is Proposal;
export function validateRecord(kind: "review", value: unknown): asserts value is Review;
export function validateRecord(kind: "repository", value: unknown): asserts value is RepositoryMetadata;
export function validateRecord(kind: SchemaKind, value: unknown): void {
  if (!validators[kind](value)) throw new CoreError("VALIDATION_FAILED", "Record validation failed", { violations: sanitizedErrors(validators[kind].errors) });
  assertDateTimes(value);
  if (kind === "fact") {
    const fact = value as Fact;
    if (fact.validity.expires_at !== null && Date.parse(fact.validity.expires_at) <= Date.parse(fact.validity.valid_from)) throw new CoreError("VALIDATION_FAILED", "Record validation failed", { violations: [{ field_path: "/validity/expires_at", rule_id: "schema.invalid_interval" }] });
  }
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const schemaBundleDigest = `sha256:${createHash("sha256").update(SCHEMA_FILES.map((name) => `${name}\0${stableJson(schemas[name])}\0`).join(""), "utf8").digest("hex")}` as const;
export function schemaBytes(name: typeof SCHEMA_FILES[number]): Buffer { return Buffer.from(`${stableJson(schemas[name])}\n`, "utf8"); }
