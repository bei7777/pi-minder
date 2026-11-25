import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import frontMatterModule from "front-matter";
import { stringify } from "yaml";

export type MemoryLayer = "core" | "active" | "episodic";
export interface MemoryInput {
  key: string;
  layer: MemoryLayer;
  text: string;
  source: string;
  expiresAt?: string;
  intent: "user" | "observed";
  operation?: "upsert" | "archive";
}
export interface MemoryChange {
  key: string;
  path: string;
  before: string | null;
  after: string | null;
}
export interface MemoryCommit { id: string; sessionId: string; changes: MemoryChange[] }
export interface MemoryHit { key: string; layer: MemoryLayer; path: string; text: string; source: string }
export interface EpisodeTurn { at: string; role: "user" | "assistant"; text: string; ref: string }
interface Document extends MemoryHit { raw: string; expiresAt?: string }
interface StoredProposal { base: string; change: string }
interface JournalRow { id: string; session: string; changes: string }
const layers: MemoryLayer[] = ["core", "active", "episodic"];
const frontMatter = frontMatterModule as unknown as typeof import("front-matter").default;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const date = (text: string) => {
  if (!/^\d{4}-\d\d-\d\dT/u.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new Error("Expected an ISO timestamp with a time and zone");
  }
  if (!/(?:Z|[+-]\d\d:\d\d)$/u.test(text)) throw new Error("Timestamp requires a time zone");
  return new Date(text).toISOString();
};
function check(input: MemoryInput) {
  if (!input.key.trim() || input.key.length > 256 || !input.source.trim() || !layers.includes(input.layer)) {
    throw new Error("Memory requires a valid key, source and layer");
  }
  if (!["user", "observed"].includes(input.intent)) throw new Error("Unknown evidence type");
  if (input.operation && !["upsert", "archive"].includes(input.operation)) throw new Error("Unknown operation");
  if (input.operation !== "archive" && !input.text.trim()) throw new Error("Empty memory");
  if (input.operation !== "archive" && input.layer === "active" && !input.expiresAt) throw new Error("Active memory requires a TTL");
  if (input.expiresAt) date(input.expiresAt);
}
function toMarkdown(input: MemoryInput) {
  const { key, layer, intent, source, expiresAt } = input;
  const meta = { key, layer, intent, source, ...(expiresAt ? { expiresAt: date(expiresAt) } : {}) };
  return "---\n" + stringify(meta) + "---\n\n" + input.text.trim() + "\n";
}
function syncDirectory(directory: string) {
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export class MemoryStore {
  readonly root: string;
  private db: DatabaseSync;

  constructor(vaultDir: string) {
    mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
    if (lstatSync(vaultDir).isSymbolicLink()) throw new Error("Memory vault cannot be a symbolic link");
    this.root = realpathSync(vaultDir);
    for (const dir of [...layers, "archive", ".minder"]) this.ensureDir(dir);
    const dbFile = this.path(".minder/memory.sqlite");
    this.db = new DatabaseSync(dbFile);
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, started TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS episode_cursor (session TEXT NOT NULL, day TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(session,day));
      CREATE TABLE IF NOT EXISTS proposals (session TEXT NOT NULL, key TEXT NOT NULL, base TEXT NOT NULL, change TEXT NOT NULL, PRIMARY KEY(session,key));
      CREATE TABLE IF NOT EXISTS commits (id TEXT PRIMARY KEY, session TEXT NOT NULL, changes TEXT NOT NULL, state TEXT NOT NULL, created TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending ON commits(state) WHERE state='pending';
    `);
    this.db.prepare("ATTACH DATABASE ? AS searchdb").run(this.path(".minder/index.sqlite"));
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS searchdb.memory_fts USING fts5(key,layer UNINDEXED,path UNINDEXED,text,source UNINDEXED,tokenize='trigram');
      CREATE TABLE IF NOT EXISTS searchdb.indexed_files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, entry INTEGER NOT NULL);
      DROP TABLE IF EXISTS main.memory_fts;`);
    this.lock(() => this.recoverPending());
    this.reindex();
  }
  private lock<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private path(rel: string) {
    const file = resolve(this.root, rel);
    if (!file.startsWith(this.root + sep)) throw new Error("Outside memory vault");
    let current = file;
    while (current !== this.root) {
      const st = lstatSync(current, { throwIfNoEntry: false });
      if (st?.isSymbolicLink()) throw new Error("Symbolic links in the vault are unsupported: " + rel);
      current = dirname(current);
    }
    return file;
  }
  private ensureDir(rel: string) { mkdirSync(this.path(rel), { recursive: true, mode: 0o700 }); }
  private documents(): Document[] {
    const docs: Document[] = [];
    const keys = new Set<string>();
    const scan = (rel: string, layer: MemoryLayer) => {
      for (const entry of readdirSync(this.path(rel), { withFileTypes: true })) {
        const path = rel + "/" + entry.name;
        if (entry.isDirectory()) { scan(path, layer); continue; }
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const raw = readFileSync(this.path(path), "utf8");
        const parsed = frontMatter<Pick<MemoryInput,"key"|"layer"|"intent"|"source"|"expiresAt">>(raw);
        const attrs = parsed.attributes;
        if (typeof attrs.key !== "string" || attrs.layer !== layer || typeof attrs.source !== "string") {
          throw new Error("Invalid memory front matter: " + path);
        }
        if (layer === "active" && !attrs.expiresAt) throw new Error("Missing expiration: " + path);
        const expiresAt = attrs.expiresAt ? date(new Date(attrs.expiresAt).toISOString()) : undefined;
        if (keys.has(attrs.key)) throw new Error("Duplicate live memory key: " + attrs.key);
        keys.add(attrs.key);
        docs.push({ key: attrs.key, layer, path, text: parsed.body.trim(), source: attrs.source, raw, expiresAt });
      }
    };
    for (const layer of layers) scan(layer, layer);
    return docs;
  }
  private current(path: string): string | null {
    const file = this.path(path);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  }
  private write(path: string, value: string | null) {
    const target = this.path(path);
    if (value === null) { rmSync(target); syncDirectory(dirname(target)); return; }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const tmp = join(dirname(target), "." + randomUUID() + ".new");
    const fd = openSync(tmp, "wx", 0o600);
    try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, target);
    syncDirectory(dirname(target));
  }
  private recoverPending() {
    const row = this.db.prepare("SELECT id,session,changes FROM commits WHERE state='pending'").get() as unknown as JournalRow | undefined;
    if (!row) return;
    const changes: MemoryChange[] = JSON.parse(row.changes);
    for (const change of changes) {
      const actual = this.current(change.path);
      if (actual !== change.after && actual !== change.before) {
        throw new Error("Memory changed during recovery: " + change.path);
      }
    }
    for (const change of changes) {
      if (this.current(change.path) !== change.after) this.write(change.path, change.after);
    }
    this.db.prepare("UPDATE commits SET state='committed' WHERE id=?").run(row.id);
    const remove = this.db.prepare("DELETE FROM proposals WHERE session=? AND key=?");
    for (const key of new Set(changes.map(change=>change.key))) remove.run(row.session,key);
    this.db.prepare("DELETE FROM sessions WHERE id=? AND NOT EXISTS(SELECT 1 FROM proposals WHERE session=?)").run(row.session,row.session);
  }
  private index() {
    const docs = this.documents();
    const rows = this.db.prepare("SELECT path,hash,entry FROM searchdb.indexed_files").all() as unknown as {path:string;hash:string;entry:number}[];
    const known = new Map(rows.map(row=>[row.path,row]));
    if (!known.size) this.db.exec("DELETE FROM searchdb.memory_fts");
    const add = this.db.prepare("INSERT INTO searchdb.memory_fts(key,layer,path,text,source) VALUES(?,?,?,?,?)");
    const stamp = this.db.prepare("INSERT OR REPLACE INTO searchdb.indexed_files VALUES(?,?,?)");
    const remove = this.db.prepare("DELETE FROM searchdb.memory_fts WHERE rowid=?");
    for (const item of docs) {
      const hash = digest(item.raw);
      const prior = known.get(item.path);
      known.delete(item.path);
      if (prior?.hash === hash) continue;
      if (prior) remove.run(prior.entry);
      const {lastInsertRowid}=add.run(item.key,item.layer,item.path,item.text,item.source);
      stamp.run(item.path,hash,lastInsertRowid);
    }
    const forget = this.db.prepare("DELETE FROM searchdb.indexed_files WHERE path=?");
    for (const prior of known.values()) {
      remove.run(prior.entry);
      forget.run(prior.path);
    }
    return docs.length;
  }
  reindex(): number { return this.lock(() => { this.recoverPending(); return this.index(); }); }
  begin(sessionId: string): string {
    if (!sessionId.trim()) throw new Error("Session id required");
    this.db.prepare("INSERT OR IGNORE INTO sessions(id,started) VALUES(?,?)").run(sessionId, new Date().toISOString());
    return sessionId;
  }
  propose(sessionId: string, input: MemoryInput): MemoryChange[] {
    check(input);
    return this.lock(() => {
      this.recoverPending();
      if (!this.db.prepare("SELECT 1 FROM sessions WHERE id=?").get(sessionId)) throw new Error("Unknown session");
      const prior = this.db.prepare("SELECT base FROM proposals WHERE session=? AND key=?").get(sessionId,input.key);
      const existing: Document | null = prior ? JSON.parse(String(prior.base)) : this.documents().find(d=>d.key===input.key) ?? null;
      const slug = Array.from(input.key.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "-")).slice(0,32).join("");
      const name = "m-" + slug + "-" + digest(input.key).slice(0,16) + ".md";
      const now = new Date().toISOString().slice(0,10);
      const destination = input.operation === "archive" ? "archive/" + now + "/" + randomUUID() + "-" + name :
        existing?.layer === input.layer ? existing.path : input.layer + "/" + (input.layer === "episodic" ? now + "/" : "") + name;
      if (input.operation === "archive" && !existing) throw new Error("No memory to archive");
      const changes: MemoryChange[] = [];
      if (existing && existing.path !== destination) changes.push({key: input.key,path:existing.path,before:existing.raw,after:null});
      const before = existing?.path === destination ? existing.raw : null;
      const after = input.operation === "archive" ? existing!.raw : toMarkdown(input);
      if (before !== after) changes.push({key:input.key,path:destination,before,after});
      if (changes.length) {
        this.db.prepare("INSERT INTO proposals VALUES(?,?,?,?) ON CONFLICT(session,key) DO UPDATE SET change=excluded.change")
          .run(sessionId,input.key,JSON.stringify(existing),JSON.stringify(changes));
      } else this.db.prepare("DELETE FROM proposals WHERE session=? AND key=?").run(sessionId,input.key);
      return changes;
    });
  }
  diff(sessionId: string): MemoryChange[] {
    const rows = this.db.prepare("SELECT change FROM proposals WHERE session=? ORDER BY key").all(sessionId) as unknown as StoredProposal[];
    return rows.flatMap(row => JSON.parse(row.change) as MemoryChange[]);
  }
  pendingSessions(): { id: string; started: string; count: number }[] {
    return this.db.prepare(`SELECT s.id,s.started,COUNT(p.key) AS count FROM sessions s
      JOIN proposals p ON p.session=s.id GROUP BY s.id,s.started ORDER BY s.started DESC`)
      .all() as unknown as { id: string; started: string; count: number }[];
  }
  discard(sessionId: string, key?: string): number {
    return this.lock(() => {
      this.recoverPending();
      if (key !== undefined) {
        return Number(this.db.prepare("DELETE FROM proposals WHERE session=? AND key=?").run(sessionId,key).changes);
      }
      const result = this.db.prepare("DELETE FROM proposals WHERE session=?").run(sessionId);
      this.db.prepare("DELETE FROM sessions WHERE id=?").run(sessionId);
      return Number(result.changes);
    });
  }
  private applyCommit(sessionId: string, produce: () => MemoryChange[]): MemoryCommit {
    const result = this.lock(() => {
      this.recoverPending();
      const changes = produce();
      if (!changes.length) throw new Error("No changes to commit");
      const live = this.documents();
      for (const c of changes) {
        const other = live.find(doc => doc.key === c.key && doc.path !== c.path);
        if (other && c.after !== null && !c.path.startsWith("archive/") && !changes.some(e=>e.path===other.path && e.after===null)) {
          throw new Error("Concurrent change to memory key: " + c.key);
        }
        if (this.current(c.path) !== c.before) throw new Error("Memory changed after review: " + c.path);
      }
      const id = randomUUID();
      this.db.prepare("INSERT INTO commits VALUES(?,?,?,'pending',?)").run(id,sessionId,JSON.stringify(changes),new Date().toISOString());
      return { id, sessionId, changes };
    });
    this.lock(() => { this.recoverPending(); this.index(); });
    return result;
  }
  commit(sessionId: string, keys?: readonly string[]): MemoryCommit {
    return this.applyCommit(sessionId,() => {
      const changes = this.diff(sessionId);
      if (keys === undefined) return changes;
      const wanted = new Set(keys);
      for (const key of wanted) {
        if (!changes.some(c=>c.key===key)) throw new Error("Unknown proposal: " + key);
      }
      return changes.filter(c=>wanted.has(c.key));
    });
  }
  proposeEpisode(sessionId: string, turns: readonly EpisodeTurn[], day = new Date().toISOString().slice(0,10)): MemoryChange[] {
    const relevant = turns.filter(turn=>date(turn.at).slice(0,10)===day && turn.text.trim() && turn.ref.trim());
    if (!relevant.length) return [];
    const items = relevant.slice(-12).map(turn=>{
      const normalized = turn.text.trim().replace(/\s+/gu," ");
      const first = normalized.match(/^.*?[。！？!?](?:\s|$)?/u)?.[0]?.trim() ?? normalized;
      const excerpt = Array.from(first).slice(0,160).join("");
      return "- " + (turn.role==="user"?"用户":"助手") + " · " + excerpt;
    });
    const source = relevant.slice(-12).map(turn=>turn.ref).join(", ");
    const fingerprint=digest(JSON.stringify([items,source]));
    if (this.db.prepare("SELECT digest FROM episode_cursor WHERE session=? AND day=?").get(sessionId,day)?.digest===fingerprint) return [];
    const changes=this.propose(this.begin(sessionId),{
      key:"episode/" + day + "/" + sessionId,layer:"episodic",intent:"observed",
      text:"# " + day + "\n\n" + items.join("\n"),source
    });
    this.db.prepare("INSERT OR REPLACE INTO episode_cursor VALUES(?,?,?)").run(sessionId,day,fingerprint);
    return changes;
  }
  revert(id: string): MemoryCommit {
    return this.applyCommit("revert-" + randomUUID(),() => {
      return this.show(id).changes.map(c=>({...c,before:c.after,after:c.before}));
    });
  }
  show(id: string): MemoryCommit {
    const row = this.db.prepare("SELECT id,session,changes FROM commits WHERE id=? AND state='committed'").get(id) as unknown as JournalRow | undefined;
    if (!row) throw new Error("Unknown memory commit");
    return {id:row.id,sessionId:row.session,changes:JSON.parse(row.changes) as MemoryChange[]};
  }
  history() { return this.db.prepare("SELECT id,session,created FROM commits WHERE state='committed' ORDER BY rowid DESC").all(); }
  expire(now = new Date()): MemoryCommit | null {
    const expired = this.documents().filter(d=>d.layer==="active" && d.expiresAt && Date.parse(d.expiresAt)<=now.getTime());
    if (!expired.length) return null;
    const id = this.begin("ttl-" + randomUUID());
    for (const doc of expired) {
      const changes = this.propose(id, {...doc, intent:"user",operation:"archive"});
      if (!changes.some(c=>c.path===doc.path && c.before===doc.raw)) {
        this.discard(id);
        throw new Error("Active memory changed during expiration: " + doc.key);
      }
    }
    return this.commit(id);
  }
  search(query: string, limit = 20): MemoryHit[] {
    if (!query.trim()) return [];
    if (!Number.isInteger(limit) || limit<1 || limit>200) throw new Error("Limit must be 1–200");
    this.expire();
    this.reindex();
    const long = Array.from(query).length >= 3;
    const sql = "SELECT key,layer,path,text,source FROM searchdb.memory_fts WHERE " + (long ? "memory_fts MATCH ? ORDER BY rank" : "instr(key||' '||text,?)>0") + " LIMIT ?";
    return this.db.prepare(sql).all(long ? '"' + query.replaceAll('"','""') + '"' : query,limit) as unknown as MemoryHit[];
  }
  close() { this.db.close(); }
}
