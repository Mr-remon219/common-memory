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
  return unwrap(await clack.confirm({ message: terminalText(message), active: '确认', inactive: '暂不', initialValue: false }));
}
export async function text(message: string, initialValue = '', optional = false): Promise<string> {
  return unwrap(await clack.text({ message: terminalText(message), initialValue, ...(optional ? { defaultValue: '' } : {}), validate: value => optional || value?.trim() ? undefined : '请填写内容' })).trim();
}
export async function menu(message: string, options: { value: string; label: string; hint?: string }[], initialValue?: string): Promise<string> {
  return unwrap(await clack.select({ message: terminalText(message), options: options.map(o => ({ ...o, label: terminalText(o.label), ...(o.hint ? { hint: terminalText(o.hint) } : {}) })), maxItems: 10, ...(initialValue === undefined ? {} : { initialValue }) }));
}

/** One numeric field at a time; final configuration still uses the shared validator. */
export async function numberInput(message: string, initialValue: number | undefined, min = 1, max = Number.MAX_SAFE_INTEGER, optional = false): Promise<number | undefined> {
  const raw = unwrap(await clack.text({ message, initialValue: initialValue === undefined ? '' : String(initialValue), ...(optional ? { defaultValue: '' } : {}), validate: value => {
    if (optional && !value?.trim()) return;
    const n = Number(value);
    return value?.trim() && Number.isSafeInteger(n) && n >= min && n <= max ? undefined : `请输入 ${min}–${max} 之间的整数`;
  } })).trim();
  return raw ? Number(raw) : undefined;
}

/** Local pagination only, not retrieval. Every line of the selected document remains available. */
export async function viewText(title: string, body: string): Promise<void> {
  const lines = terminalText(body).split('\n');
  let start = 0;
  for (;;) {
    const size = Math.max(5, Math.min(30, (process.stdout.rows || 24) - 12));
    const end = Math.min(lines.length, start + size);
    note(lines.slice(start, end).join('\n') || '（暂无内容）', `${title} · 第 ${start + 1}–${end} 行，共 ${lines.length} 行`);
    const action = await menu('阅读', [
      ...(end < lines.length ? [{ value: 'next', label: '下一页' }] : []),
      ...(start ? [{ value: 'previous', label: '上一页' }] : []),
      { value: 'back', label: '返回' },
    ]);
    if (action === 'back') return;
    start = action === 'next' ? end : Math.max(0, start - size);
  }
}

/** Cancel/error stays inside the current area; a cancelled home menu exits the application. */
export async function attempt(action: () => Promise<unknown>): Promise<void> {
  try { await action(); }
  catch (error) {
    if (error instanceof UserCancelled) clack.log.info('已取消这一步，返回菜单。');
    else clack.log.error(terminalText(error instanceof Error ? error.message : '操作未完成，请检查后重试。'));
  }
}
