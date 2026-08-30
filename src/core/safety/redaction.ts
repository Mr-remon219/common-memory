import { createHmac, randomBytes } from "node:crypto";
const key = randomBytes(32);
export function irreversibleFingerprint(value: string): string { return createHmac("sha256", key).update(value, "utf8").digest("hex").slice(0, 16); }
