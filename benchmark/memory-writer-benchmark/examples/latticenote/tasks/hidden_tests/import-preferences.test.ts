// Hidden test bundle for task.coding.import_conflicts (reference world; published only because the world is public).
// The reader never sees this file. Test names are referenced from the task spec.
import { describe, expect, it } from "vitest";
import { importPreferenceRecords, type PreferenceRecord } from "../../src/backup/import-preferences";

const rec = (id: string, key: string, value: string, recordedAt: number): PreferenceRecord => ({ id, key, value, recordedAt });

describe("importPreferenceRecords", () => {
  it("newer incoming record supersedes existing", () => {
    const existing = [rec("e1", "theme", "dark", 100)];
    const incoming = [rec("i1", "theme", "light", 200)];
    const out = importPreferenceRecords(existing, incoming);
    const e1 = out.find((r) => r.id === "e1");
    const i1 = out.find((r) => r.id === "i1");
    expect(e1?.superseded_by).toBe("i1");
    expect(i1?.superseded_by).toBeUndefined();
  });

  it("older incoming record is kept but superseded", () => {
    const existing = [rec("e1", "theme", "dark", 300)];
    const incoming = [rec("i1", "theme", "light", 200)];
    const out = importPreferenceRecords(existing, incoming);
    const e1 = out.find((r) => r.id === "e1");
    const i1 = out.find((r) => r.id === "i1");
    expect(i1?.superseded_by).toBe("e1");
    expect(e1?.superseded_by).toBeUndefined();
  });

  it("all records are retained", () => {
    const existing = [rec("e1", "theme", "dark", 100), rec("e2", "lang", "en", 100)];
    const incoming = [rec("i1", "theme", "light", 200), rec("i2", "font", "mono", 200)];
    const out = importPreferenceRecords(existing, incoming);
    expect(out).toHaveLength(4);
    expect(new Set(out.map((r) => r.id))).toEqual(new Set(["e1", "e2", "i1", "i2"]));
  });
});
