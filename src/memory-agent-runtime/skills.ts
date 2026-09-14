import { readFileSync } from 'node:fs';

export const MEMORY_SKILL_NAMES = ['memory-maintenance', 'memory-recovery'] as const;
export type MemorySkillName = typeof MEMORY_SKILL_NAMES[number];
export interface MemorySkillDescriptor { name: MemorySkillName; description: string }

const assets: Readonly<Record<MemorySkillName, { description: string; url: URL }>> = {
  'memory-maintenance': {
    description: 'Evaluate authorized source material and propose conservative, evidence-backed memory maintenance while preserving qualifiers and provenance.',
    url: new URL('./skills/memory-maintenance/SKILL.md', import.meta.url),
  },
  'memory-recovery': {
    description: 'Recover safely after a rejected proposal, tool error, or interrupted model stream without inventing coverage, evidence, or authority.',
    url: new URL('./skills/memory-recovery/SKILL.md', import.meta.url),
  },
};

/** Built-ins only: no user, project, package, ancestor, or environment discovery. */
export function discoverMemorySkills(): MemorySkillDescriptor[] {
  return MEMORY_SKILL_NAMES.map(name => ({name, description: assets[name].description}));
}

/** Exact-name asset read only. No path input, script execution, shell, or recursive loading. */
export function loadMemorySkill(name: string): {name: MemorySkillName; description: string; content: string} {
  if (!MEMORY_SKILL_NAMES.includes(name as MemorySkillName)) throw new Error('UNKNOWN_MEMORY_SKILL');
  const skill = assets[name as MemorySkillName];
  const content = readFileSync(skill.url, 'utf8');
  assertFrontmatter(content, name as MemorySkillName, skill.description);
  return {name:name as MemorySkillName,description:skill.description,content};
}

export function formatMemorySkillsForPrompt(): string {
  return ['<available_memory_skills>', ...discoverMemorySkills().flatMap(skill => [
    '  <skill>', `    <name>${skill.name}</name>`, `    <description>${escapeXml(skill.description)}</description>`, '  </skill>',
  ]), '</available_memory_skills>'].join('\n');
}

function assertFrontmatter(content: string, name: MemorySkillName, description: string): void {
  const match = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---(?:\n|$)/u.exec(content);
  if (!match || match[1] !== name || match[2] !== description) throw new Error('INVALID_BUILTIN_MEMORY_SKILL');
}
function escapeXml(value: string): string { return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;'); }
