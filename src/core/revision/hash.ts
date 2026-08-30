import { createHash } from "node:crypto";
import type { Revision } from "../contracts/types.js";

function u64(value: number): Buffer { const buffer = Buffer.alloc(8); buffer.writeBigUInt64BE(BigInt(value)); return buffer; }
export function framedRevision(domain: "knowledge" | "store", files: ReadonlyArray<{ path: string; bytes: Uint8Array }>): Revision {
  const hash = createHash("sha256");
  const header = Buffer.from(`common-memory/revision/v1/${domain}`, "utf8");
  hash.update(u64(header.length)); hash.update(header);
  const sorted = files.map((file) => ({ ...file, path: file.path.replaceAll("\\", "/") })).sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
  hash.update(u64(sorted.length));
  for (const file of sorted) {
    const path = Buffer.from(file.path, "utf8"); const bytes = Buffer.from(file.bytes);
    hash.update(u64(path.length)); hash.update(path); hash.update(u64(bytes.length)); hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}
