import type { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, readdirSync, copyFileSync, openSync, fsyncSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withRepositoryLock } from './lock.js';
import { safeDirectory, syncDirectory } from './canonical.js';

export const RUNTIME_PROTOCOL = 2;
const version = (db: DatabaseSync) => Number(db.prepare('PRAGMA user_version').get()!.user_version);
const dataVersion = (db: DatabaseSync) => Number(db.prepare('PRAGMA data_version').get()!.data_version);

/**
 * Old binaries register an older capability (or none). Takeover invalidates live
 * leases under the canonical lock before replacing their mutation fences.
 * This is compatibility fencing, not a security boundary against the local owner.
 */
export function initializeRuntime(db: DatabaseSync, root: string, _now: number, initialize: () => void): void {
  db.function('common_memory_runtime_protocol', {deterministic:true}, () => RUNTIME_PROTOCOL);
  if (version(db) > RUNTIME_PROTOCOL) throw new Error('UNSUPPORTED_RUNTIME_VERSION');
  const existing = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'").get());
  const migrate = (expectedDataVersion?: number) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (expectedDataVersion !== undefined && dataVersion(db)!==expectedDataVersion) throw new Error('UPGRADE_WRITER_ACTIVE');
      if (version(db) > RUNTIME_PROTOCOL) throw new Error('UNSUPPORTED_RUNTIME_VERSION');
      const previous=version(db),takeover=existing&&previous<RUNTIME_PROTOCOL;
      if(takeover) {
        // Only our exact, versioned trigger definitions are replaceable. A prefix
        // is not ownership proof, and a conflicting schema must fail closed.
        const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        for(const row of tables)for(const operation of ['INSERT','UPDATE','DELETE']){
          const name=`runtime_protocol_${row.name==='jobs'?'':String(row.name)+'_'}${operation.toLowerCase()}`,prior=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name);
          if(!prior)continue;
          const table=String(row.name).replaceAll('"','""'),quoted=name.replaceAll('"','""');
          const expected=`CREATE TRIGGER "${quoted}" BEFORE ${operation} ON "${table}" BEGIN SELECT CASE WHEN common_memory_runtime_protocol()!=${previous} THEN RAISE(ABORT,'INCOMPATIBLE_WRITER') END; END`;
          if(prior.sql!==expected)throw new Error('INCOMPATIBLE_RUNTIME_TRIGGER');
          db.exec(`DROP TRIGGER "${quoted}"`);
        }
        // Under repository lock -> DB transaction: old SELECT lease checks fail,
        // even before their incompatible mutation trigger would reject a write.
        db.prepare("UPDATE jobs SET state='retry',token=lower(hex(randomblob(16))),generation=generation+1,expires=0,available=0 WHERE state='running'").run();
      }
      initialize();
      // Fence every durable mutation, not only leases. An old ingress otherwise
      // inserts rows without the normalized digests needed by forget tombstones.
      for(const table of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
        const name=String(table.name).replaceAll('"','""');
        for (const operation of ['INSERT','UPDATE','DELETE']) {
          const trigger=`runtime_protocol_${name==='jobs'?'':name+'_'}${operation.toLowerCase()}`;
          db.exec(`CREATE TRIGGER IF NOT EXISTS "${trigger}" BEFORE ${operation} ON "${name}" BEGIN SELECT CASE WHEN common_memory_runtime_protocol()!=${RUNTIME_PROTOCOL} THEN RAISE(ABORT,'INCOMPATIBLE_WRITER') END; END;`);
        }
      }
      db.exec(`PRAGMA user_version=${RUNTIME_PROTOCOL}; COMMIT`);
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  if (!existing || version(db) === RUNTIME_PROTOCOL) { migrate(); return; }
  withRepositoryLock(root, () => {
    // Lock ordering matches canonical commits. Expired owners are fenced by their
    // token/generation and cannot renew after the protocol trigger is installed.
    const fromProtocol=version(db),before = dataVersion(db);
    const backup = join(root,'runtime','upgrade-backups',`protocol-${fromProtocol}-${randomUUID()}`);
    safeDirectory(backup);
    const database = join(backup,'runtime.sqlite');
    // VACUUM INTO takes a consistent SQLite snapshot including committed WAL pages.
    db.exec(`VACUUM INTO '${database.replaceAll("'","''")}'`);
    sync(database);
    for (const name of readdirSync(root)) {
      if (name.startsWith('runtime.sqlite')) continue;
      copy(join(root,name),join(backup,name),name==='runtime');
    }
    const manifest = join(backup,'backup.json');
    writeFileSync(manifest,JSON.stringify({version:1,fromProtocol,toProtocol:RUNTIME_PROTOCOL,createdAt:new Date().toISOString(),dataOnly:true})+'\n',{mode:0o600,flag:'wx'});
    sync(manifest);
    for(const directory of [backup,join(root,'runtime','upgrade-backups'),join(root,'runtime'),root])syncDirectory(directory);
    // The equality check and schema/fence publication share one writer transaction.
    // Any concurrent acceptance invalidates this backup and leaves migration undone.
    migrate(before);
  });
}
function sync(path: string): void { const fd=openSync(path,'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function copy(source: string, target: string, runtime=false): void {
  if (!existsSync(source)) return;
  const info=lstatSync(source);
  if (info.isSymbolicLink() || !info.isDirectory() && (!info.isFile() || info.nlink!==1)) throw new Error('UNSAFE_UPGRADE_BACKUP_PATH');
  if (info.isDirectory()) {
    mkdirSync(target,{mode:0o700});
    for (const name of readdirSync(source)) {
      if (runtime && (name==='upgrade-backups' || name.startsWith('repository-lock.sqlite') || name.startsWith('service-owner.sqlite'))) continue;
      copy(join(source,name),join(target,name));
    }
    syncDirectory(target);
  } else { copyFileSync(source,target); sync(target); }
}
