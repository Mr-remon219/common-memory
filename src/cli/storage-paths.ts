import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { configFilePath, type CommonMemoryConfig } from '../config/config.js';
function actual(path: string): string { try { return realpathSync(path); } catch { return `${path} (unresolved or not created)`; } }
/** Read-only path diagnosis: neither realpath failure nor absent storage creates directories. */
export function storagePathLines(config: CommonMemoryConfig): string[] {
  const path = configFilePath(), memory = join(config.dataRoot, 'memory'), runtime = join(config.dataRoot, 'runtime.sqlite');
  return [`Config: ${path}`,`Actual config: ${actual(path)}`,`Data: ${config.dataRoot}`,`Actual data: ${actual(config.dataRoot)}`,`Memory: ${actual(memory)}`,`Runtime: ${actual(runtime)}`];
}
