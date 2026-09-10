import * as clack from '@clack/prompts';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export class UserCancelled extends Error {
  constructor() { super('Cancelled'); this.name = 'UserCancelled'; }
}
export function unwrap<T>(value: T | symbol): T {
  if (clack.isCancel(value)) throw new UserCancelled();
  return value as T;
}
export function requireInteractive(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive terminal required. Use common-memory --help for non-interactive commands; configuration can be supplied in config.json.');
}
export function expandPath(value: string): string {
  return resolve(value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value);
}
/** Terminal controls in memory, file names or diagnostic text are data, not display commands. */
export function terminalText(value: string): string {
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
export const note = (body: string, title: string): void => clack.note(terminalText(body), terminalText(title));
export const log = (body: string): void => clack.log.info(terminalText(body));
export async function confirm(message: string): Promise<boolean> {
  return unwrap(await clack.confirm({ message: terminalText(message), initialValue: false }));
}
export async function text(message: string, initialValue = '', optional = false): Promise<string> {
  return unwrap(await clack.text({ message, initialValue, ...(optional ? { defaultValue: '' } : {}), validate: value => optional || value?.trim() ? undefined : 'A value is required' })).trim();
}
export async function menu(message: string, options: { value: string; label: string; hint?: string }[]): Promise<string> {
  return unwrap(await clack.select({ message, options: options.map(o => ({ ...o, label: terminalText(o.label), ...(o.hint ? { hint: terminalText(o.hint) } : {}) })), maxItems: 10 }));
}

/** Local pagination only, not retrieval. Every line of the selected document remains available. */
export async function viewText(title: string, body: string): Promise<void> {
  const lines = terminalText(body).split('\n');
  let start = 0;
  for (;;) {
    const size = Math.max(5, Math.min(30, (process.stdout.rows || 24) - 12));
    const end = Math.min(lines.length, start + size);
    note(lines.slice(start, end).join('\n') || '(empty)', `${title} · lines ${start + 1}–${end}/${lines.length}`);
    const action = await menu('Viewer', [
      ...(end < lines.length ? [{ value: 'next', label: 'Next page' }] : []),
      ...(start ? [{ value: 'previous', label: 'Previous page' }] : []),
      { value: 'back', label: 'Back' },
    ]);
    if (action === 'back') return;
    start = action === 'next' ? end : Math.max(0, start - size);
  }
}

/** Cancel/error stays inside the current area; a cancelled home menu exits the application. */
export async function attempt(action: () => Promise<unknown>): Promise<void> {
  try { await action(); }
  catch (error) {
    if (error instanceof UserCancelled) clack.log.info('Cancelled; no further action.');
    else clack.log.error(terminalText(error instanceof Error ? error.message : 'Operation failed'));
  }
}
