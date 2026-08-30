import { parseDocument, isMap, isSeq, isAlias, isScalar, isNode, type Node } from "yaml";
import { CoreError } from "../contracts/errors.js";
import { normalizeSemantic } from "./normalize.js";
import { validateRecord, type SchemaKind } from "../contracts/schema-registry.js";

const MAX_FILE_BYTES = 1_048_576;
const MAX_NODES = 50_000;
const MAX_STRING = 100_000;

export function parseYamlStrict(bytes: Uint8Array, kind: SchemaKind): unknown {
  if (bytes.byteLength > MAX_FILE_BYTES) throw invalid("yaml.file_too_large");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw invalid("yaml.invalid_utf8"); }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const document = parseDocument(text, { uniqueKeys: true, customTags: [] });
  if (document.errors.length) throw invalid("yaml.parse_failed");
  let nodes = 0;
  function inspect(node: Node | null | undefined): void {
    if (!node || ++nodes > MAX_NODES) { if (nodes > MAX_NODES) throw invalid("yaml.too_many_nodes"); return; }
    if (isAlias(node) || ("tag" in node && typeof node.tag === "string" && !node.tag.startsWith("tag:yaml.org,2002:"))) throw invalid("yaml.unsupported_tag_or_alias");
    if (isMap(node)) for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") throw invalid("yaml.non_string_key");
      inspect(pair.key); inspect(isNode(pair.value) ? pair.value : null);
    }
    else if (isSeq(node)) for (const item of node.items) inspect(item as Node | null);
    else if ("value" in node && typeof node.value === "string" && Buffer.byteLength(node.value, "utf8") > MAX_STRING) throw invalid("yaml.string_too_large");
  }
  inspect(document.contents);
  const value: unknown = document.toJS({ maxAliasCount: 0, mapAsMap: false });
  if (kind === "fact") validateRecord("fact", value);
  else if (kind === "proposal") validateRecord("proposal", value);
  else if (kind === "review") validateRecord("review", value);
  else validateRecord("repository", value);
  const normalized = normalizeSemantic(value);
  if (kind === "fact") validateRecord("fact", normalized);
  else if (kind === "proposal") validateRecord("proposal", normalized);
  else if (kind === "review") validateRecord("review", normalized);
  else validateRecord("repository", normalized);
  return normalized;
}
function invalid(rule: string): CoreError { return new CoreError("VALIDATION_FAILED", "YAML validation failed", { violations: [{ field_path: "/", rule_id: rule }] }); }
