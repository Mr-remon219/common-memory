import { createRequire } from 'node:module';
import type { DatabaseSync, DatabaseSyncOptions } from 'node:sqlite';

const require = createRequire(import.meta.url);

/** Loading filesystem/read-only helpers must not initialize SQLite or emit its warning. */
export function openDatabase(path: string, options: DatabaseSyncOptions): DatabaseSync {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  return new DatabaseSync(path, options);
}

/** Node 22 truncates TEXT results at NUL. Read body columns as BLOB and decode UTF-8. */
export function decodeText<T extends Record<string, unknown> | undefined>(row: T, columns: readonly string[] = ['text']): T {
  if (row) for (const column of columns) {
    const value = row[column];
    if (value instanceof Uint8Array) row[column] = Buffer.from(value).toString('utf8');
  }
  return row;
}

/** A lock/transaction cannot remain held across an asynchronous callback. */
export function synchronousResult<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') &&
      typeof (value as { then?: unknown }).then === 'function') {
    throw new Error('Database transaction/lock callback must be synchronous');
  }
  return value;
}
