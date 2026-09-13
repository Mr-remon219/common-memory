import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { networkConfigError, type NetworkEnvironment } from '../memory-manager/network/route.js';

export function readPrivateEnv(path: string): Record<string,string | undefined> {
  try { return existsSync(path) ? parseEnv(readFileSync(path,'utf8')) : {}; }
  catch { throw networkConfigError(); }
}
/** Model credentials have one source: the private .env written by the TUI. */
export function localApiKey(name: string, privateEnv: NetworkEnvironment): string {
  const value = privateEnv[name]?.trim();
  if (!value) throw new TypeError('Model API key is missing from the private .env; configure it in the Common Memory TUI');
  return value;
}
/** Raw backslashes must survive Node dotenv parsing, notably for Windows CA paths. */
export function privateAssignment(name: string, value: string): string {
  if (!value || /[\r\n\0]/u.test(value)) throw networkConfigError();
  const quote = !value.includes('"') ? '"' : !value.includes("'") ? "'" : null;
  if (!quote) throw networkConfigError();
  const line = `${name}=${quote}${value}${quote}`;
  if (parseEnv(line)[name] !== value) throw networkConfigError();
  return line;
}
