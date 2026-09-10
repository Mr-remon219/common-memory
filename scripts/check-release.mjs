#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Publishing rights are an owner decision, not something the build chooses. */
export function releaseIssues(manifest, root) {
  const issues = [];
  if (manifest.private === true) issues.push('package.json is private; remove private only after the owner approves public distribution.');
  if (typeof manifest.license !== 'string' || !manifest.license.trim() || manifest.license === 'UNLICENSED') {
    issues.push('The owner must choose a distribution license and set package.json license.');
  }
  try {
    if (!readFileSync(join(root, 'LICENSE'), 'utf8').trim()) issues.push('LICENSE must contain the owner-approved license text.');
  } catch { issues.push('LICENSE is missing; do not invent a license on behalf of the owner.'); }
  for (const field of ['description', 'homepage']) {
    if (typeof manifest[field] !== 'string' || !manifest[field].trim()) issues.push(`package.json ${field} is missing.`);
  }
  if (!manifest.repository?.url || !manifest.bugs?.url) issues.push('Repository and issue-tracker URLs are required.');
  if (manifest.publishConfig?.access !== 'public' || manifest.publishConfig?.registry !== 'https://registry.npmjs.org/') {
    issues.push('Public npm publishing must target the explicitly configured registry.');
  }
  return issues;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const issues = releaseIssues(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')), root);
  if (issues.length) {
    console.error('[release] blocked:\n' + issues.map(issue => `- ${issue}`).join('\n'));
    process.exitCode = 1;
  } else console.log('[release] metadata and license files present; review rights and follow docs/releasing.md before publishing.');
}
