import { stringify } from "yaml";
import { validateRecord, type SchemaKind } from "../contracts/schema-registry.js";
import { normalizeSemantic } from "./normalize.js";

export function canonicalYamlBytes(kind: SchemaKind, value: unknown): Buffer {
  validateRecord(kind as never, value);
  const normalized = normalizeSemantic(value);
  const text = stringify(normalized, { indent: 2, lineWidth: 0, minContentWidth: 0, defaultStringType: "PLAIN", defaultKeyType: "PLAIN", sortMapEntries: true });
  return Buffer.from(text.replace(/\r\n?/g, "\n"), "utf8");
}
