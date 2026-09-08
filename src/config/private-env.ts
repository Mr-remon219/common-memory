import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { PRIVATE_NETWORK_KEYS, networkConfigError, type NetworkEnvironment } from '../memory-manager/network/route.js';

export function readPrivateEnv(path: string): Record<string,string | undefined> {
  try { return existsSync(path) ? parseEnv(readFileSync(path,'utf8')) : {}; }
  catch { throw networkConfigError(); }
}
/** Legacy compatibility only. New clients never call this or mutate process.env. */
export function loadLegacyEnv(path: string): void {
  const values = readPrivateEnv(path);
  for (const [key,value] of Object.entries(values)) {
    if (!PRIVATE_NETWORK_KEYS.some(k => k === key.toUpperCase()) && process.env[key] === undefined) process.env[key] = value;
  }
}
export function localApiKey(name: string, env: NetworkEnvironment, privateEnv: NetworkEnvironment): string {
  const value = (env[name] !== undefined ? env[name] : privateEnv[name])?.trim();
  if (!value) throw new TypeError(`API key environment variable ${name} is not set`);
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
