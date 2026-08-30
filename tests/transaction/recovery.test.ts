import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { CoreService } from "../../src/core/service/core-service.js";
import { LockedRepositorySession } from "../../src/core/repository/locked-session.js";
import { RepositoryLayout } from "../../src/core/repository/layout.js";
import { noFaults } from "../../src/core/contracts/ports.js";
import { canonicalYamlBytes } from "../../src/core/serialization/canonical-yaml.js";
import type { Proposal } from "../../src/core/contracts/types.js";
import type { FaultInjector, FaultPoint } from "../../src/core/contracts/ports.js";
import { TestClock, TestIds, contributor, evidence, suggested, tempRoot } from "../helpers.js";
const cleanups: Array<() => void> = []; afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
class OnceFault implements FaultInjector { fired = false; constructor(readonly target: FaultPoint) {} checkpoint(point: FaultPoint): void { if (point === this.target && !this.fired) { this.fired = true; throw new Error("simulated abrupt stop"); } } }
const points: FaultPoint[] = ["journal-write", "journal-fsync", "commit-marker", "target-write", "target-fsync", "target-rename", "directory-fsync", "post-check", "cleanup-publish", "cleanup"];
it.each(points)("recovers a transaction interrupted at %s to a complete old or new state", (point) => {
  const root = tempRoot(); cleanups.push(root.cleanup); const ids = new TestIds(); const first = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids, faults: new OnceFault(point) }); expect(first.initialize().ok).toBe(true);
  const failed = first.propose({ operation: "add_fact", target_fact_ids: [], suggested_fact: suggested, evidence, reasoning: "长期偏好", confidence: "high" }, contributor); expect(failed.ok).toBe(false);
  const restarted = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids }); const diag = restarted.diagnose(); expect(diag.ok).toBe(true); if (diag.ok) expect(diag.data.pending_proposals).toBe(point === "journal-write" || point === "journal-fsync" ? 0 : 1);
});

it.each([
  ["authority escape", [{ relative_path: ".git/config", staging_name: "staging-0", temp_name: ".transaction.99999999.0.tmp" }]],
  ["duplicate target", [{ relative_path: "memory/proposals/proposal.99999999.yaml", staging_name: "staging-0", temp_name: ".transaction.99999999.0.tmp" }, { relative_path: "memory/proposals/proposal.99999999.yaml", staging_name: "staging-1", temp_name: ".transaction.99999999.1.tmp" }]],
  ["staging traversal", [{ relative_path: "memory/proposals/proposal.99999999.yaml", staging_name: "../outside", temp_name: ".transaction.99999999.0.tmp" }]],
  ["temp traversal", [{ relative_path: "memory/proposals/proposal.99999999.yaml", staging_name: "staging-0", temp_name: "../../outside" }]]
] as const)("rejects malicious journal %s", (_name, entries) => {
  const root = tempRoot(); cleanups.push(root.cleanup); const service = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds() }); const initialized = service.initialize(); if (!initialized.ok) throw new Error(); const id = "transaction.99999999"; const directory = join(root.path, "state", "transactions", id); mkdirSync(directory);
  const targets = entries.map((entry) => ({ ...entry, before: { exists: false, sha256: "", length: 0 }, after: { sha256: "0".repeat(64), length: 1 } })); writeFileSync(join(directory, "journal.json"), JSON.stringify({ version: 1, transaction_id: id, phase: "PREPARED", expected_knowledge_revision: initialized.knowledge_revision, expected_store_revision: initialized.store_revision, targets }));
  const result = service.diagnose(); expect(!result.ok && result.error.code).toBe("STORE_UNAVAILABLE");
});

it.each(["journal", "staging"])("rejects oversized sparse %s files", (kind) => { const root = tempRoot(); cleanups.push(root.cleanup); const service = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds() }); const initialized = service.initialize(); if (!initialized.ok) throw new Error(); const id = "transaction.88888888"; const directory = join(root.path, "state", "transactions", id); mkdirSync(directory); if (kind === "journal") { writeFileSync(join(directory, "journal.json"), Buffer.alloc(1_100_000)); } else { const target = { relative_path: "memory/proposals/proposal.88888888.yaml", staging_name: "staging-0", temp_name: `.${id}.0.tmp`, before: { exists: false, sha256: "", length: 0 }, after: { sha256: "0".repeat(64), length: 1 } }; writeFileSync(join(directory, "journal.json"), JSON.stringify({ version: 1, transaction_id: id, phase: "PREPARED", expected_knowledge_revision: initialized.knowledge_revision, expected_store_revision: initialized.store_revision, targets: [target] })); writeFileSync(join(directory, "staging-0"), Buffer.alloc(1_100_000)); } const result = service.diagnose(); expect(!result.ok && result.error.code).toBe("STORE_UNAVAILABLE"); });

it("prevalidates the candidate image before creating a transaction", () => { const root = tempRoot(); cleanups.push(root.cleanup); const ids = new TestIds(); const service = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids }); service.initialize(); const layout = new RepositoryLayout(root.path); const session = new LockedRepositorySession(layout, ids, noFaults); const proposal: Proposal = { schema_version: 1, id: "proposal.99999999", operation: "add_fact", target_fact_ids: [], suggested_fact: suggested, evidence, reasoning: "candidate", confidence: "high", source: { client: "local_user", received_at: "2026-01-01T00:00:00.000Z" }, created_at: "2026-01-01T00:00:00.000Z" }; expect(() => session.apply([{ path: layout.proposalPath(proposal.id), bytes: canonicalYamlBytes("proposal", proposal) }], { knowledge: session.snapshot.knowledge_revision, store: session.snapshot.store_revision })).toThrow(); session.close(); const diagnosed = service.diagnose(); expect(diagnosed.ok && diagnosed.data.pending_proposals).toBe(0); });

it("recovers after an actual child process exits at the commit marker", () => {
  const root = tempRoot(); cleanups.push(root.cleanup); const parent = new CoreService({ dataRoot: root.path, clock: new TestClock(), ids: new TestIds() }); expect(parent.initialize().ok).toBe(true);
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { cwd: process.cwd(), stdio: "ignore" });
  const serviceUrl = pathToFileURL(join(process.cwd(), "dist", "core", "service", "core-service.js")).href;
  const portsUrl = pathToFileURL(join(process.cwd(), "dist", "core", "contracts", "ports.js")).href;
  const script = `import { CoreService } from ${JSON.stringify(serviceUrl)}; import { trustedContributor } from ${JSON.stringify(portsUrl)}; const service = new CoreService({ dataRoot: process.env.ROOT, faults: { checkpoint(point) { if (point === 'commit-marker') process.exit(77); } } }); service.propose({ operation: 'add_fact', target_fact_ids: [], suggested_fact: ${JSON.stringify(suggested)}, evidence: ${JSON.stringify(evidence)}, reasoning: '长期偏好', confidence: 'high' }, trustedContributor('local_user', 'session-1')); process.exit(1);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { env: { ...process.env, ROOT: root.path }, encoding: "utf8", timeout: 20_000 }); expect(child.status).toBe(77);
  const recovered = parent.diagnose(); expect(recovered.ok).toBe(true); if (recovered.ok) expect(recovered.data.pending_proposals).toBe(1);
});
