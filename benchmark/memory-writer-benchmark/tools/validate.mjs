#!/usr/bin/env node
// MWB v0.1 world validator.
//   node tools/validate.mjs examples/latticenote            # schema + cross-reference checks
//   node tools/validate.mjs examples/latticenote --oracle task.coding.import_conflicts
//   node tools/validate.mjs examples/latticenote --variant variant.cf_explanation_style > /tmp/events.yaml
//   node tools/validate.mjs examples/latticenote --writer-card templates/writer-card.example.yaml
// Dependencies (ajv, ajv-formats, yaml) are resolved from the enclosing repository's node_modules.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import YAML from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, "..", "schema");
const [worldDirArg, ...flags] = process.argv.slice(2);
if (!worldDirArg) {
  console.error("usage: validate.mjs <world-dir> [--oracle <task_id>] [--variant <variant_id>] [--writer-card <file>]");
  process.exit(2);
}
const worldDir = resolve(worldDirArg);
const loadYaml = (rel) => YAML.parse(readFileSync(join(worldDir, rel), "utf8"));
const loadSchema = (name) => JSON.parse(readFileSync(join(schemaDir, name), "utf8"));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validators = {
  world: ajv.compile(loadSchema("world-spec.v1.schema.json")),
  state: ajv.compile(loadSchema("state-atom.v1.schema.json")),
  events: ajv.compile(loadSchema("history-event.v1.schema.json")),
  labels: ajv.compile(loadSchema("history-labels.v1.schema.json")),
  task: ajv.compile(loadSchema("task-spec.v1.schema.json"))
};

const errors = [];
const warnings = [];
const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);
const schemaCheck = (kind, data, label) => {
  if (!validators[kind](data)) {
    for (const e of validators[kind].errors) fail(`${label}: schema ${e.instancePath || "/"} ${e.message}`);
    return false;
  }
  return true;
};

// ---------------------------------------------------------------- load
const world = loadYaml("world.yaml");
schemaCheck("world", world, "world.yaml");
const statesDoc = loadYaml(world.files.states);
const events = loadYaml(world.files.events);
const labels = loadYaml(world.files.labels);
schemaCheck("events", events, world.files.events);
schemaCheck("labels", labels, world.files.labels);
const states = new Map();
for (const s of statesDoc.states ?? []) {
  if (schemaCheck("state", s, `${world.files.states}#${s.id ?? "?"}`)) {
    if (states.has(s.id)) fail(`duplicate state id ${s.id}`);
    states.set(s.id, s);
  }
}
const tasks = [];
for (const rel of world.tasks) {
  if (!existsSync(join(worldDir, rel))) { fail(`task file missing: ${rel}`); continue; }
  const t = loadYaml(rel);
  if (schemaCheck("task", t, rel)) tasks.push({ rel, t });
}

// ---------------------------------------------------------------- helpers
const dayNum = (d) => Number(d.replace("day-", ""));
const stateExists = (id, ctx) => { if (!states.has(id)) fail(`${ctx}: unknown state ${id}`); };
const eventIds = new Set(events.events.map((e) => e.id));
const eventById = new Map(events.events.map((e) => [e.id, e]));
const normalize = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
const historyText = normalize(events.events.map((e) => e.content).join("\n"));

// ---------------------------------------------------------------- world-level checks
if (world.world_id !== events.world_id) fail("events.world_id != world.world_id");
if (world.world_id !== labels.world_id) fail("labels.world_id != world.world_id");
if (world.world_id !== statesDoc.world_id) fail("states.world_id != world.world_id");
if (dayNum(world.virtual_time.task_cutoff) <= dayNum(world.virtual_time.history_end)) fail("task_cutoff must be after history_end");
{
  const seen = new Set();
  let lastDay = 0;
  const seqBySession = new Map();
  for (const e of events.events) {
    if (seen.has(e.id)) fail(`duplicate event id ${e.id}`);
    seen.add(e.id);
    const d = dayNum(e.day);
    if (d < lastDay) fail(`${e.id}: events must be chronological (day ${d} < ${lastDay})`);
    lastDay = d;
    if (d > dayNum(world.virtual_time.history_end)) fail(`${e.id}: day after history_end`);
    const prev = seqBySession.get(e.session_id) ?? 0;
    if (e.seq !== prev + 1) fail(`${e.id}: seq must increase by 1 within session (${e.session_id}: got ${e.seq}, expected ${prev + 1})`);
    seqBySession.set(e.session_id, e.seq);
    if (e.role === "system_note" && /(?:^|\W)(must|always|never|write|remember)\b/i.test(e.content)) warn(`${e.id}: system_note contains instruction-like wording`);
  }
}

// ---------------------------------------------------------------- state checks
const rendered = new Map([...states.keys()].map((k) => [k, 0]));
for (const [evId, ids] of Object.entries(labels.renders)) {
  if (!eventIds.has(evId)) fail(`labels: unknown event ${evId}`);
  for (const id of ids) { stateExists(id, `labels[${evId}]`); rendered.set(id, (rendered.get(id) ?? 0) + 1); }
}
for (const evId of Object.keys(labels.rendering_kind ?? {})) if (!labels.renders[evId]) fail(`labels.rendering_kind has ${evId} without renders entry`);
for (const [id, s] of states) {
  if ((rendered.get(id) ?? 0) === 0) fail(`state ${id} is never rendered by any event`);
  for (const sup of s.supersedes ?? []) stateExists(sup, `${id}.supersedes`);
  if (s.superseded_by) {
    stateExists(s.superseded_by, `${id}.superseded_by`);
    const newer = states.get(s.superseded_by);
    if (newer && !(newer.supersedes ?? []).includes(id)) fail(`${id} superseded_by ${s.superseded_by} but the newer state does not list it in supersedes`);
  }
  if (s.valid_to && dayNum(s.valid_to) < dayNum(s.valid_from)) fail(`${id}: valid_to before valid_from`);
  if (s.status === "current" && s.valid_to && s.class !== "noise_or_untrusted") fail(`${id}: status current but valid_to set`);
  if (s.class === "ephemeral" && s.status === "current") warn(`${id}: ephemeral state still current at cutoff — make sure a task treats it as expired`);
}

// ---------------------------------------------------------------- variants
const variantIds = new Set();
for (const v of world.variants ?? []) {
  variantIds.add(v.variant_id);
  if (!existsSync(join(worldDir, v.overrides_file))) { fail(`variant ${v.variant_id}: overrides_file missing`); continue; }
  const ov = loadYaml(v.overrides_file);
  if (ov.variant_id !== v.variant_id) fail(`variant ${v.variant_id}: overrides file declares ${ov.variant_id}`);
  for (const o of ov.overrides ?? []) if (!eventIds.has(o.event_id)) fail(`variant ${v.variant_id}: unknown event ${o.event_id}`);
  if (v.kind === "counterfactual") {
    stateExists(v.pivot_state_id, `variant ${v.variant_id}`);
    const pivot = states.get(v.pivot_state_id);
    if (pivot && !pivot.decision_field) fail(`variant ${v.variant_id}: pivot ${v.pivot_state_id} has no decision_field`);
    const renderingEvents = Object.entries(labels.renders).filter(([, ids]) => ids.includes(v.pivot_state_id)).map(([e]) => e);
    const overridden = new Set((ov.overrides ?? []).map((o) => o.event_id));
    for (const e of renderingEvents) if (!overridden.has(e)) fail(`variant ${v.variant_id}: event ${e} renders the pivot state but is not overridden`);
    if (ov.replacement_content !== v.replacement_content) fail(`variant ${v.variant_id}: replacement_content differs between world.yaml and overrides file`);
  }
  if (v.kind === "noise") {
    for (const o of ov.overrides ?? []) {
      const ids = labels.renders[o.event_id] ?? [];
      const nonNoise = ids.filter((id) => states.get(id)?.class !== "noise_or_untrusted");
      if (nonNoise.length) fail(`variant ${v.variant_id}: noise override touches event ${o.event_id} which renders non-noise states ${nonNoise.join(",")}`);
    }
  }
}

// ---------------------------------------------------------------- task checks
const taskIds = new Set(tasks.map(({ t }) => t.task_id));
const mixCount = { same_domain: 0, positive_cross_domain: 0, negative_transfer_null: 0, temporal_or_counterfactual: 0, isolation: 0 };
const autoWeights = [];
for (const { rel, t } of tasks) {
  const ctx = t.task_id;
  if (t.world_id !== world.world_id) fail(`${ctx}: world_id mismatch`);
  const kindKey = t.task_kind === "temporal_update" || t.task_kind === "counterfactual_twin" ? "temporal_or_counterfactual" : t.task_kind;
  mixCount[kindKey] += 1;

  const req = new Set(t.required_state_ids), forb = new Set(t.forbidden_active_state_ids), irr = new Set(t.irrelevant_state_ids);
  for (const id of [...req, ...forb, ...irr, ...(t.shared_latent_state_ids ?? [])]) stateExists(id, ctx);
  for (const id of req) { if (forb.has(id)) fail(`${ctx}: ${id} both required and forbidden`); if (irr.has(id)) fail(`${ctx}: ${id} both required and irrelevant`); }
  for (const id of forb) if (irr.has(id)) fail(`${ctx}: ${id} both forbidden and irrelevant`);
  for (const id of req) {
    const s = states.get(id);
    if (s && s.class === "obsolete") fail(`${ctx}: required state ${id} is obsolete`);
    if (s && s.class === "noise_or_untrusted") fail(`${ctx}: required state ${id} is noise/untrusted`);
  }
  for (const id of t.shared_latent_state_ids ?? []) {
    if (!req.has(id)) fail(`${ctx}: shared_latent ${id} must also be required`);
    const s = states.get(id);
    if (s && !s.transferability[t.target_domain]) fail(`${ctx}: shared_latent ${id} not declared transferable to ${t.target_domain}`);
    if (t.task_kind === "positive_cross_domain" && s && !t.source_domains.some((d) => s.transferability[d])) fail(`${ctx}: shared_latent ${id} not transferable from any source domain`);
  }
  if (t.task_kind === "positive_cross_domain" && t.source_domains.every((d) => d === t.target_domain)) fail(`${ctx}: positive_cross_domain requires a source domain different from target`);
  if (t.task_kind === "isolation" && forb.size === 0) fail(`${ctx}: isolation task must forbid at least one state`);
  if (t.task_kind === "negative_transfer_null" && t.memory_dependence.certification_kind !== "null_task") fail(`${ctx}: null task needs certification_kind null_task`);

  // scorer weights
  const pos = t.scorer.checks.filter((c) => c.kind === "positive");
  const posSum = pos.reduce((a, c) => a + c.weight, 0);
  if (Math.abs(posSum - 1) > 1e-6) fail(`${ctx}: positive check weights sum to ${posSum.toFixed(4)}, must be 1.0`);
  const judgeW = pos.filter((c) => c.type === "blinded_llm_judge").reduce((a, c) => a + c.weight, 0);
  if (judgeW > 0.3 + 1e-9) fail(`${ctx}: blinded_llm_judge weight ${judgeW} exceeds 0.30 cap`);
  autoWeights.push(pos.filter((c) => c.type === "hidden_tests" || c.type === "deterministic_validator").reduce((a, c) => a + c.weight, 0));
  const ids = new Set();
  for (const c of t.scorer.checks) {
    if (ids.has(c.id)) fail(`${ctx}: duplicate check id ${c.id}`);
    ids.add(c.id);
    for (const id of c.evidence_state_ids ?? []) stateExists(id, `${ctx}/${c.id}`);
    if (c.type === "hidden_tests") {
      const bundle = c.spec?.bundle;
      if (!bundle || !existsSync(join(worldDir, dirname(rel), bundle))) fail(`${ctx}/${c.id}: hidden test bundle not found (${bundle})`);
      else {
        const src = readFileSync(join(worldDir, dirname(rel), bundle), "utf8");
        for (const name of c.spec.test_names ?? []) if (!src.includes(`"${name}"`)) fail(`${ctx}/${c.id}: test "${name}" not in bundle`);
      }
    }
    if (c.spec?.validator === "regex_present" && c.spec.target === "output_text") {
      for (const p of c.spec.patterns ?? []) {
        const re = new RegExp(p.replace(/^\(\?i\)/, ""), "i");
        if (re.test(t.prompt.user_message)) fail(`${ctx}/${c.id}: pattern /${p}/ self-triggers on the task prompt`);
      }
    }
    if (c.spec?.field) {
      const df = (t.decision_fields ?? []).find((d) => d.name === c.spec.field);
      if (!df) fail(`${ctx}/${c.id}: references undeclared decision field ${c.spec.field}`);
      else {
        const vals = c.spec.values ?? (c.spec.value !== undefined ? [c.spec.value] : []);
        for (const v of vals) if (!df.values.includes(v)) fail(`${ctx}/${c.id}: value ${v} not in decision field ${df.name}`);
      }
    }
  }
  for (const term of t.leakage_guard.forbidden_surface_terms) if (t.prompt.user_message.toLowerCase().includes(term.toLowerCase())) fail(`${ctx}: forbidden surface term "${term}" appears in the task prompt`);

  // anti answer-cache: no long history sentence reused verbatim
  const sentences = t.prompt.user_message.split(/(?<=[.!?])\s+|\n/).map(normalize).filter((s) => s.split(" ").length >= 8);
  for (const s of sentences) if (historyText.includes(s)) fail(`${ctx}: prompt sentence appears verbatim in history: "${s.slice(0, 60)}..."`);

  if (t.variant_binding) {
    if (!variantIds.has(t.variant_binding.variant_id)) fail(`${ctx}: unknown variant ${t.variant_binding.variant_id}`);
    if (!taskIds.has(t.variant_binding.twin_of_task_id)) fail(`${ctx}: twin_of ${t.variant_binding.twin_of_task_id} not in world`);
    const df = (t.decision_fields ?? []).find((d) => d.name === t.variant_binding.decision_field);
    if (!df) fail(`${ctx}: variant decision_field not declared`);
    else for (const v of [t.variant_binding.expected_value_base, t.variant_binding.expected_value_variant]) if (!df.values.includes(v)) fail(`${ctx}: expected value ${v} not in decision field values`);
    const twin = tasks.find((x) => x.t.task_id === t.variant_binding.twin_of_task_id)?.t;
    if (twin && twin.prompt.user_message !== t.prompt.user_message) fail(`${ctx}: twin prompt must be byte-identical to base task prompt`);
  }
}
for (const [k, n] of Object.entries(world.task_mix)) if (mixCount[k] !== n) fail(`task_mix.${k}=${n} but ${mixCount[k]} task(s) of that kind found`);
{
  const covered = new Set();
  for (const { t } of tasks) for (const id of [...t.required_state_ids, ...t.forbidden_active_state_ids]) covered.add(id);
  for (const [id, s] of states) if (!covered.has(id) && s.class !== "noise_or_untrusted") warn(`state ${id} is neither required nor forbidden by any task (only irrelevant)`);
  const autoMean = autoWeights.reduce((a, b) => a + b, 0) / Math.max(1, autoWeights.length);
  console.error(`INFO  fully automatic (hidden_tests + deterministic) share of positive weight, world mean: ${(autoMean * 100).toFixed(0)}% — open-ended LLM judge is capped at 30% per task`);
}

// ---------------------------------------------------------------- optional renderers
const flag = (name) => { const i = flags.indexOf(name); return i >= 0 ? flags[i + 1] : undefined; };
const oracleTask = flag("--oracle");
if (oracleTask) {
  const t = tasks.find((x) => x.t.task_id === oracleTask)?.t;
  if (!t) fail(`--oracle: unknown task ${oracleTask}`);
  else {
    // Oracle Minimal Sufficient Memory: required states rendered in id order, with status label.
    const lines = [...t.required_state_ids].sort().map((id) => { const s = states.get(id); return `- [${s.scope}] [${s.status}] ${s.content}`; });
    process.stdout.write((lines.length ? lines.join("\n") : "(empty)") + "\n");
  }
}
const variantId = flag("--variant");
if (variantId) {
  const v = (world.variants ?? []).find((x) => x.variant_id === variantId);
  if (!v) fail(`--variant: unknown ${variantId}`);
  else {
    const ov = loadYaml(v.overrides_file);
    const patched = structuredClone(events);
    for (const o of ov.overrides) patched.events.find((e) => e.id === o.event_id).content = o.content;
    process.stdout.write(YAML.stringify(patched));
  }
}

const writerCardPath = flag("--writer-card");
if (writerCardPath) {
  const card = YAML.parse(readFileSync(resolve(writerCardPath), "utf8"));
  const v = ajv.compile(loadSchema("writer-card.v1.schema.json"));
  if (!v(card)) for (const e of v.errors) fail(`${writerCardPath}: schema ${e.instancePath || "/"} ${e.message}`);
  else console.error(`INFO  writer card ${card.writer_id} valid`);
}

// ---------------------------------------------------------------- report
for (const w of warnings) console.error(`WARN  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);
console.error(`${world.world_id}: ${states.size} states, ${events.events.length} events, ${tasks.length} tasks, ${variantIds.size} variants — ${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
