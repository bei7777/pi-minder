import { randomUUID } from "node:crypto";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync,
  statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTwoFilesPatch } from "diff";
import { effectiveMode, flushDirectory, flushFile, hashFile, ObjectStore, PathPolicy, SnapshotError } from "./files.js";
export { SnapshotError } from "./files.js";

export interface SnapshotOptions {
  stateDir: string;
  roots: string[];
  protectedPaths?: string[];
  maxFileBytes?: number;
  maxBytes?: number;
  retentionMs?: number;
}

type Status = "staging" | "committing" | "committed" | "undoing" | "undone" | "aborted";
export interface SnapshotRecord { id: string; label: string; status: Status; createdAt: number }
export interface FileChange { path: string; kind: "create" | "modify" | "delete"; before: string | null; after: string | null; patch: string }
export interface FileDiff extends SnapshotRecord { files: FileChange[] }
export interface ApprovalDetails { path: string; operation: "write" | "remove"; beforeBytes: number | null; afterBytes: number | null }
type Confirmation = (details: Readonly<ApprovalDetails>) => Promise<boolean>;
class LargeFileError extends SnapshotError {
  constructor(public path: string, public operation: string, public beforeBytes: number | null, public afterBytes: number | null) {
    super("LARGE_FILE", "This operation exceeds the reversible file-size limit: " + path);
  }
}
interface Entry {
  path: string; before: string | null; after: string | null; beforeMode: number; afterMode: number; scratch: string;
}
interface FileState { hash: string | null; mode: number }

function matches(state: FileState, hash: string | null, mode: number): boolean {
  return state.hash === hash && (hash === null || state.mode === mode);
}

function current(path: string, maxBytes: number): FileState {
  const item = lstatSync(path, { throwIfNoEntry: false });
  if (item && item.size > maxBytes) throw new SnapshotError("CONFLICT","External file exceeds snapshot limit: " + path);
  return item ? { hash: hashFile(path), mode: item.mode & 0o777 } : { hash: null, mode: 0 };
}

function sizeLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new SnapshotError("CONFIG", "Invalid " + name);
  return value;
}

export class SnapshotManager {
  private readonly db: DatabaseSync;
  private readonly mutex: DatabaseSync;
  private readonly policy: PathPolicy;
  private readonly objects: ObjectStore;
  private readonly maxFile: number;
  private readonly quota: number;
  private readonly age: number;
  private locked = false;
  private active: string | undefined;

  constructor(options: SnapshotOptions) {
    this.maxFile = sizeLimit(options.maxFileBytes ?? 500_000_000, "maxFileBytes");
    this.quota = sizeLimit(options.maxBytes ?? 5_000_000_000, "maxBytes");
    this.age = sizeLimit(options.retentionMs ?? 7 * 86_400_000, "retentionMs");
    mkdirSync(resolve(options.stateDir), { recursive: true, mode: 0o700 });
    const dir = realpathSync.native(resolve(options.stateDir));
    const protectedPaths = [...(options.protectedPaths ?? [])];
    if (process.env.MINDER_HOME) protectedPaths.push(process.env.MINDER_HOME);
    this.policy = new PathPolicy(options.roots, dir, protectedPaths);
    this.objects = new ObjectStore(dir);
    this.mutex = new DatabaseSync(join(dir, "writer.sqlite"));
    this.db = new DatabaseSync(join(dir, "journal.sqlite"));
    this.db.exec(`
      PRAGMA busy_timeout=3000;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entries (
        tx TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        path TEXT NOT NULL, before TEXT, after TEXT, beforeMode INTEGER NOT NULL, afterMode INTEGER NOT NULL,
        scratch TEXT NOT NULL, PRIMARY KEY(tx,path)
      );
      CREATE TABLE IF NOT EXISTS exceptions (
        id TEXT PRIMARY KEY, time INTEGER NOT NULL, path TEXT NOT NULL, operation TEXT NOT NULL,
        beforeBytes INTEGER, afterBytes INTEGER, status TEXT NOT NULL
      );
    `);
  }
  private acquire(): void {
    if (this.locked) throw new SnapshotError("BUSY", "Another snapshot transaction is active.");
    try { this.mutex.exec("BEGIN IMMEDIATE"); }
    catch (error) {
      if ((error as { errcode?: number }).errcode === 5)
        throw new SnapshotError("BUSY", "Another process is managing this snapshot directory.");
      throw error;
    }
    this.locked = true;
  }
  private release(): void {
    this.mutex.exec("ROLLBACK");
    this.locked = false;
    this.active = undefined;
  }
  private record(id: string): SnapshotRecord {
    const row = this.db.prepare("SELECT * FROM transactions WHERE id=?").get(id);
    if (!row) throw new SnapshotError("NOT_FOUND", "Unknown or expired snapshot: " + id);
    return row as unknown as SnapshotRecord;
  }
  private entries(id: string): Entry[] {
    return this.db.prepare("SELECT * FROM entries WHERE tx=? ORDER BY path").all(id) as unknown as Entry[];
  }
  private setStatus(id: string, status: Status): void {
    this.db.prepare("UPDATE transactions SET status=? WHERE id=?").run(status, id);
  }
  private assertActive(id: string): void {
    if (this.active !== id || this.record(id).status !== "staging")
      throw new SnapshotError("CLOSED", "Transaction is no longer accepting changes.");
  }
  private blocked(path: string, kind: string, beforeBytes: number | null, afterBytes: number | null): never {
    throw new LargeFileError(path,kind,beforeBytes,afterBytes);
  }
  private stage(id: string, input: string, data: Uint8Array | string | null, requestedMode?: number): void {
    this.assertActive(id);
    const path = this.policy.file(input);
    const previous = this.db.prepare("SELECT * FROM entries WHERE tx=? AND path=?").get(id,path) as unknown as Entry | undefined;
    const stat = lstatSync(path, {throwIfNoEntry:false});
    const size = data === null ? null : Buffer.byteLength(data);
    if ((stat?.size ?? 0) > this.maxFile || (size ?? 0) > this.maxFile)
      this.blocked(path, data === null ? "remove" : "write", stat?.size ?? null, size);
    if (data === null && (previous ? previous.after === null : !stat))
      throw new SnapshotError("NOT_FOUND", "No file to delete: " + path);
    const before = previous ? previous.before : stat ? this.objects.save(path, true) : null;
    const after = data === null ? null : this.objects.save(data);
    const beforeMode = previous?.beforeMode ?? ((stat?.mode ?? 0) & 0o777);
    const mode = requestedMode ?? (previous?.after !== null && previous ? previous.afterMode : stat ? beforeMode : (0o666 & ~process.umask()));
    this.db.prepare(`INSERT INTO entries VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(tx,path) DO UPDATE SET after=excluded.after, afterMode=excluded.afterMode`)
      .run(id,path,before,after,beforeMode,mode,previous?.scratch ?? randomUUID());
  }
  private mutate(id: string, action: () => void): void {
    this.assertActive(id);
    this.db.exec("SAVEPOINT stage_change");
    try {
      action();
      const hashes = this.db.prepare("SELECT before AS h FROM entries WHERE tx=? UNION SELECT after FROM entries WHERE tx=?").all(id,id);
      const bytes = hashes.reduce((sum,row) => sum + (row.h ? statSync(join(this.objects.dir,String(row.h))).size : 0),0);
      if (bytes > this.quota) throw new SnapshotError("QUOTA","This task exceeds the snapshot byte budget.");
      this.db.exec("RELEASE stage_change");
    } catch (error) {
      this.db.exec("ROLLBACK TO stage_change; RELEASE stage_change");
      if (error instanceof LargeFileError) {
        this.db.prepare("INSERT INTO exceptions VALUES(?,?,?,?,?,?,?)")
          .run(randomUUID(),Date.now(),error.path,error.operation,error.beforeBytes,error.afterBytes,"blocked");
      }
      this.sweep();
      throw error;
    }
    this.collect();
  }
  private view(id: string, input: string): Buffer {
    this.assertActive(id);
    const path = this.policy.file(input);
    const row = this.db.prepare("SELECT after FROM entries WHERE tx=? AND path=?").get(id,path);
    if (!row) {
      const item = statSync(path);
      if (item.size > this.maxFile) throw new SnapshotError("LARGE_FILE","File exceeds the read limit: " + path);
      return readFileSync(path);
    }
    if (row.after === null) throw new SnapshotError("NOT_FOUND", "File is deleted in this transaction: " + path);
    return this.objects.buffer(String(row.after));
  }
  private abortStage(id: string): void {
    this.db.prepare("DELETE FROM entries WHERE tx=?").run(id);
    this.setStatus(id,"aborted");
  }
  private preflight(id: string, reverse: boolean, recovering: boolean): void {
    for (const e of this.entries(id)) {
      const path = this.policy.file(e.path);
      const state = current(path,this.maxFile);
      // 旧事务可能只记录了创建文件时请求的权限。按相同目录的真实文件系统验证。
      if ((reverse || recovering) && e.after !== null && state.hash === e.after && state.mode !== e.afterMode
        && effectiveMode(path,e.afterMode) === state.mode) {
        this.db.prepare("UPDATE entries SET afterMode=? WHERE tx=? AND path=?").run(state.mode,id,e.path);
        e.afterMode = state.mode;
      }
      const origin = reverse ? matches(state,e.after,e.afterMode) : matches(state,e.before,e.beforeMode);
      const destination = reverse ? matches(state,e.before,e.beforeMode) : matches(state,e.after,e.afterMode);
      if (!origin && !(recovering && destination))
        throw new SnapshotError("CONFLICT", "The file changed outside this transaction: " + path);
      const hash = reverse ? e.before : e.after;
      if (hash && hashFile(join(this.objects.dir,hash)) !== hash)
        throw new SnapshotError("CORRUPT", "Damaged snapshot object: " + hash);
    }
  }
  private apply(id: string, reverse: boolean, recovering: boolean): void {
    this.preflight(id, reverse, recovering);
    this.setStatus(id,reverse ? "undoing" : "committing");
    for (const e of this.entries(id)) {
      const path = this.policy.file(e.path);
      const state = current(path,this.maxFile);
      const hash = reverse ? e.before : e.after;
      const mode = reverse ? e.beforeMode : e.afterMode;
      if (matches(state,hash,mode)) continue;
      if (!(reverse ? matches(state,e.after,e.afterMode) : matches(state,e.before,e.beforeMode)))
        throw new SnapshotError("CONFLICT", "File changed before publishing: " + path);
      this.objects.publish(hash,mode,path,e.scratch,actualMode=>{
        if (reverse) throw new SnapshotError("CONFLICT","Cannot restore original mode on this volume: " + path);
        // 替换前持久化目标卷实际提供的权限，确保中断后可识别已经发布的文件。
        this.db.prepare("UPDATE entries SET afterMode=? WHERE tx=? AND path=?").run(actualMode,id,e.path);
      });
    }
    this.setStatus(id,reverse ? "undone" : "committed");
  }
  private resume(): void {
    this.db.exec("UPDATE exceptions SET status='interrupted' WHERE status='awaiting'; UPDATE exceptions SET status='uncertain' WHERE status='authorized'");
    for (const row of this.db.prepare("SELECT id,status FROM transactions WHERE status IN ('staging','committing','undoing') ORDER BY createdAt").all()) {
      const id = String(row.id);
      if (row.status === "staging") this.abortStage(id);
      else this.apply(id,row.status === "undoing",true);
    }
  }
  async recover(): Promise<void> {
    this.acquire();
    try { this.resume(); } finally { this.release(); }
  }
  async begin(label: string) {
    this.acquire();
    const id = randomUUID();
    try {
      this.resume();
      this.collect();
      this.db.prepare("INSERT INTO transactions VALUES(?,?,?,?)").run(id,label,"staging",Date.now());
      this.active = id;
    } catch (error) { this.release(); throw error; }
    return {
      id,
      read: async (path: string) => this.view(id,path),
      write: async (path: string, data: string | Uint8Array) => this.mutate(id,() => this.stage(id,path,data)),
      remove: async (path: string) => this.mutate(id,() => this.stage(id,path,null)),
      move: async (from: string, to: string) => {
        this.assertActive(id);
        const src = this.policy.file(from), dest = this.policy.file(to);
        if (src === dest) return;
        this.mutate(id,() => {
          const item = lstatSync(src,{throwIfNoEntry:false});
          if (item && item.size > this.maxFile) this.blocked(src,"move",item.size,item.size);
          const bytes = this.view(id,src);
          const row = this.db.prepare("SELECT afterMode FROM entries WHERE tx=? AND path=?").get(id,src);
          const mode = row ? Number(row.afterMode) : item!.mode & 0o777;
          this.stage(id,dest,bytes,mode);
          this.stage(id,src,null);
        });
      },
      abort: async () => {
        this.assertActive(id);
        try { this.abortStage(id); this.collect(); } finally { this.release(); }
      },
      commit: async () => {
        this.assertActive(id);
        try {
          this.collect();
          this.apply(id,false,false);
          return await this.diff(id);
        } catch (error) {
          if (this.record(id).status === "staging") this.abortStage(id);
          throw error;
        } finally { this.release(); }
      },
    };
  }
  async list(): Promise<SnapshotRecord[]> {
    return this.db.prepare("SELECT * FROM transactions ORDER BY createdAt DESC,rowid DESC").all() as unknown as SnapshotRecord[];
  }
  async diff(id: string): Promise<FileDiff> {
    const record = this.record(id);
    const files: FileChange[] = [];
    for (const e of this.entries(id)) {
      if (e.before === e.after && (e.before === null || e.beforeMode === e.afterMode)) continue;
      const beforeSize = e.before ? statSync(join(this.objects.dir,e.before)).size : 0;
      const afterSize = e.after ? statSync(join(this.objects.dir,e.after)).size : 0;
      let patch = `Binary or large file (${beforeSize} → ${afterSize} bytes)`;
      if (beforeSize + afterSize <= 128_000) {
        const a = e.before ? this.objects.buffer(e.before) : Buffer.alloc(0);
        const b = e.after ? this.objects.buffer(e.after) : Buffer.alloc(0);
        if (!a.includes(0) && !b.includes(0)) {
          patch = createTwoFilesPatch(e.before ? e.path : "/dev/null",e.after ? e.path : "/dev/null",
            a.toString("utf8"),b.toString("utf8"),undefined,undefined,{context:3,timeout:150}) ?? patch;
        }
      }
      files.push({path:e.path,kind:e.before === null ? "create" : e.after === null ? "delete" : "modify",before:e.before,after:e.after,patch});
    }
    return {...record,files};
  }
  async undo(id: string): Promise<FileDiff> {
    this.acquire();
    try {
      this.resume();
      const record = this.record(id);
      if (record.status === "undone") return await this.diff(id);
      if (record.status !== "committed") throw new SnapshotError("STATE", "Only a committed transaction can be undone.");
      this.apply(id,true,false);
      return await this.diff(id);
    } finally { this.release(); }
  }
  private sweep(): number {
    const refs = new Set(this.db.prepare("SELECT before AS hash FROM entries UNION SELECT after FROM entries").all().map(r=>r.hash));
    let bytes = 0;
    for (const name of readdirSync(this.objects.dir)) {
      const path = join(this.objects.dir,name);
      if (!refs.has(name)) unlinkSync(path);
      else bytes += statSync(path).size;
    }
    return bytes;
  }
  private collect(): void {
    const terminal = "('committed','undone','aborted')";
    this.db.prepare("DELETE FROM transactions WHERE status IN "+terminal+" AND createdAt<?").run(Date.now()-this.age);
    let bytes = this.sweep();
    if (bytes <= this.quota) return;
    for (const row of this.db.prepare("SELECT id FROM transactions WHERE status IN "+terminal+" ORDER BY createdAt,rowid").all()) {
      this.db.prepare("DELETE FROM transactions WHERE id=?").run(row.id!);
      bytes = this.sweep();
      if (bytes <= this.quota) return;
    }
    throw new SnapshotError("QUOTA","Active snapshots exceed the byte budget.");
  }
  async gc(): Promise<void> {
    this.acquire();
    try { this.resume(); this.collect(); } finally { this.release(); }
  }
  private async exceptional(input: string, data: string | Uint8Array | null, confirm: Confirmation): Promise<void> {
    this.acquire();
    const id = randomUUID();
    try {
      this.resume();
      const path = this.policy.file(input);
      const stat = lstatSync(path,{bigint:true,throwIfNoEntry:false});
      const beforeBytes = stat ? Number(stat.size) : null;
      const afterBytes = data === null ? null : Buffer.byteLength(data);
      if ((beforeBytes ?? 0) <= this.maxFile && (afterBytes ?? 0) <= this.maxFile)
        throw new SnapshotError("REVERSIBLE","Use a reversible transaction for this file.");
      const operation = data === null ? "remove" : "write";
      const details = {path,operation,beforeBytes,afterBytes} as const;
      this.db.prepare("INSERT INTO exceptions VALUES(?,?,?,?,?,?,?)").run(id,Date.now(),path,operation,beforeBytes,afterBytes,"awaiting");
      const allowed = typeof confirm === "function" && await confirm(Object.freeze(details));
      if (allowed !== true) {
        this.db.prepare("UPDATE exceptions SET status='denied' WHERE id=?").run(id);
        throw new SnapshotError("DENIED","The irreversible operation was not confirmed.");
      }
      const check = lstatSync(this.policy.file(path),{bigint:true,throwIfNoEntry:false});
      if (check?.ino !== stat?.ino || check?.dev !== stat?.dev || check?.size !== stat?.size || check?.ctimeNs !== stat?.ctimeNs)
        throw new SnapshotError("CONFLICT","File changed while waiting for approval.");
      this.db.prepare("UPDATE exceptions SET status='authorized' WHERE id=?").run(id);
      if (data === null) unlinkSync(path);
      else {
        const stage = join(dirname(path),".minder-tx-"+id);
        writeFileSync(stage,data,{flag:"wx",mode:0o600});
        try {
          flushFile(stage);
          chmodSync(stage,stat ? Number(stat.mode & 0o777n) : 0o666 & ~process.umask());
          renameSync(stage,path);
        } finally { if (existsSync(stage)) unlinkSync(stage); }
      }
      flushDirectory(dirname(path));
      this.db.prepare("UPDATE exceptions SET status='executed' WHERE id=?").run(id);
    } catch (error) {
      const outcome = error instanceof SnapshotError && error.code === "CONFLICT" ? "conflict" : "interrupted";
      this.db.prepare("UPDATE exceptions SET status=? WHERE id=? AND status='awaiting'").run(outcome,id);
      this.db.prepare("UPDATE exceptions SET status='uncertain' WHERE id=? AND status='authorized'").run(id);
      throw error;
    } finally { this.release(); }
  }
  async irreversibleWrite(path: string, data: string | Uint8Array, confirm: Confirmation): Promise<void> {
    return this.exceptional(path,data,confirm);
  }
  async irreversibleRemove(path: string, confirm: Confirmation): Promise<void> { return this.exceptional(path,null,confirm); }
  close(): void {
    if (this.locked) {
      if (!this.active || this.record(this.active).status !== "staging")
        throw new SnapshotError("BUSY","A snapshot operation must finish before closing.");
      this.abortStage(this.active);
      this.release();
    }
    this.mutex.close();
    this.db.close();
  }
}

export type SnapshotTransaction = Awaited<ReturnType<SnapshotManager["begin"]>>;
export async function openSnapshot(options: SnapshotOptions): Promise<SnapshotManager> {
  const manager = new SnapshotManager(options);
  try {
    await manager.recover();
  } catch (error) {
    // 其他进程持有事务时，此连接仍可查询已提交的记录。
    if (error instanceof SnapshotError && error.code === "BUSY") return manager;
    manager.close();
    throw error;
  }
  return manager;
}
