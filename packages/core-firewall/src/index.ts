import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stripVTControlCharacters } from "node:util";

export type Score = 1 | 2 | 3 | 4 | 5;
export interface SourceEvent {
  sourceId: string;
  externalId: string;
  revision: string;
  occurredAt: string;
  kind: string;
  title: string;
  summary: string;
  action?: { label: string; text: string };
  score?: Score;
  scoringError?: string;
}
export interface Rules {
  quietStart: string;
  quietEnd: string;
  timezone: string;
  cooldownMinutes: number;
  digestMinutes: number;
  rules: { sourceId: string; score: Score; bypassQuiet?: boolean }[];
}
export interface Decision extends SourceEvent {
  id: string;
  status: "archived" | "pending" | "digest" | "ready" | "accepted" | "superseded";
  score: Score;
  reason: string;
  dueAt: number;
  deliveredAt: number | null;
  groupKey: string;
}

export interface ActionCard extends Decision {
  status: "ready";
  title: string;
  summary: string;
  action: { label: string; text: string };
  draftPreviewOnly: boolean;
}

const sentences = new Intl.Segmenter("zh", { granularity: "sentence" });
const graphemes = new Intl.Segmenter("zh", { granularity: "grapheme" });
const fileChanges: ReadonlyMap<string, string> = new Map([
  ["created", "创建"], ["modified", "修改"], ["deleted", "删除"]
]);

function singleLine(text: string): string {
  return stripVTControlCharacters(text).replace(/[\p{Cc}\p{Bidi_Control}\s]+/gu, " ").trim();
}

function shorten(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = 0;
  for (const {index, segment} of graphemes.segment(text)) {
    if (index + segment.length >= limit) break;
    end = index + segment.length;
  }
  return text.slice(0, end).trimEnd() + "…";
}

function cardSummary(event: Decision, fileChange: string | undefined): string {
  if (fileChange) return "监听目录中的文件已经" + fileChange + "。 文件名称与变更时间已记入本地日志。";
  const parts: string[] = [];
  for (const {segment} of sentences.segment(singleLine(event.summary))) {
    if (!/[\p{L}\p{N}\p{S}]/u.test(segment)) continue;
    const excerpt = shorten(segment.trim(), 78);
    parts.push(/[\p{Sentence_Terminal}]["'\p{Pe}\p{Pf}]*$/u.test(excerpt) ? excerpt : excerpt + "。");
    if (parts.length === 2) break;
  }
  if (!parts.length) parts.push(event.kind === "feed" ? "订阅中出现了新的条目。" : "收到新的来源事件。");
  if (parts.length === 1) parts.push("来源和记录时间可在本地事件日志中查看。");
  return parts.join(" ");
}

function cardFor(event: Decision): ActionCard {
  const title = shorten(singleLine(event.title), 80) || "未命名事件";
  const fileChange = event.sourceId.startsWith("dir:") ? fileChanges.get(event.kind) : undefined;
  const label = fileChange ? "核对文件变更" : event.kind === "feed" ? "整理订阅待办" : "核对事件";
  const generatedDraft = fileChange ? `请核对文件「${title}」的${fileChange}记录，列出需要处理的事项。`
    : event.kind === "feed" ? `请根据订阅条目「${title}」整理待办事项。`
    : `请核对事件「${title}」并列出待办事项。`;
  const draft = event.action?.text ?? generatedDraft;
  const preview = shorten(singleLine(draft), 160);
  return { ...event, status: "ready", title, summary: cardSummary(event, fileChange),
    action: { label: shorten(singleLine(event.action?.label ?? label), 32) || label, text: preview },
    draftPreviewOnly: preview !== draft };
}

const defaults: Rules = {
  quietStart: "22:00", quietEnd: "07:00", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  cooldownMinutes: 30, digestMinutes: 60, rules: []
};

function quiet(now: number, config: Rules): boolean {
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone, hourCycle: "h23", hour: "2-digit", minute: "2-digit"
  }).format(now);
  const { quietStart: start, quietEnd: end } = config;
  return start <= end ? local >= start && local < end : local >= start || local < end;
}

function checkScore(value: number): asserts value is Score {
  if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error("优先级必须在 1 至 5 之间");
}
function checkEvent(e: SourceEvent) {
  for (const value of [e.sourceId, e.externalId, e.revision, e.kind, e.title, e.summary])
    if (typeof value !== "string" || !value.trim() || value.length > 16384) throw new Error("事件字段无效");
  if (!Number.isFinite(Date.parse(e.occurredAt))) throw new Error("事件时间无效");
  if (e.score !== undefined) checkScore(e.score);
  if (e.action && (!e.action.label?.trim() || !e.action.text?.trim())) throw new Error("行动草稿为空");
}

type Row = Record<string, unknown>;
function decode(row: Row): Decision {
  return { ...JSON.parse(String(row.body)), id: row.id, status: row.status, score: row.score,
    reason: row.reason, dueAt: row.due_at, deliveredAt: row.delivered_at, groupKey: row.group_key };
}

export class Firewall {
  private db: DatabaseSync;
  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(resolve(stateDir, "state.sqlite"));
    this.db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, external TEXT NOT NULL, revision TEXT NOT NULL,
        body TEXT NOT NULL, score INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL,
        due_at INTEGER NOT NULL, delivered_at INTEGER, group_key TEXT NOT NULL,
        UNIQUE(source,external,revision)
      );
      CREATE INDEX IF NOT EXISTS schedule ON events(status,due_at);
      CREATE INDEX IF NOT EXISTS cooldown ON events(group_key,delivered_at);
      CREATE TABLE IF NOT EXISTS receipts (event_id TEXT PRIMARY KEY, draft TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (source TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, until INTEGER);
      CREATE TABLE IF NOT EXISTS decision_policies (event_id TEXT PRIMARY KEY, json TEXT NOT NULL);
    `);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  settings(): Rules {
    const row = this.db.prepare("SELECT json FROM settings WHERE id=1").get();
    return row ? JSON.parse(String(row.json)) : structuredClone(defaults);
  }
  configure(patch: Partial<Rules>): Rules {
    return this.transaction(() => {
      const rules = { ...this.settings(), ...patch };
      for (const clock of [rules.quietStart, rules.quietEnd])
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(clock)) throw new Error("时间应使用 HH:MM");
      new Intl.DateTimeFormat("en", { timeZone: rules.timezone });
      for (const duration of [rules.cooldownMinutes,rules.digestMinutes])
        if (!Number.isInteger(duration) || duration < 0 || duration > 10080) throw new Error("无效的分钟数");
      const ids = new Set<string>();
      for (const entry of rules.rules) {
        if (!entry.sourceId?.trim() || ids.has(entry.sourceId)) throw new Error("来源规则重复或为空");
        ids.add(entry.sourceId);
        checkScore(entry.score);
      }
      this.db.prepare("INSERT OR REPLACE INTO settings VALUES(1,?)").run(JSON.stringify(rules));
      return rules;
    });
  }
  ingest(event: SourceEvent, at = new Date()): Decision {
    checkEvent(event);
    const now = at.getTime();
    return this.transaction(() => {
      const old = this.db.prepare("SELECT * FROM events WHERE source=? AND external=? AND revision=?")
        .get(event.sourceId, event.externalId, event.revision);
      if (old) return decode(old);
      const config = this.settings();
      const rule = config.rules.find(r => r.sourceId === event.sourceId);
      const score = rule?.score ?? event.score ?? 2;
      const reason = rule ? "来源规则" : event.score ? "宿主评分" : event.scoringError ? "评分不可用，普通事件" : "普通事件";
      const status = score < 4 ? "archived" : score === 4 ? "digest" : "pending";
      const groupKey = JSON.stringify([event.sourceId,event.externalId,event.action?.label ?? "查看草稿"]);
      const id = randomUUID();
      const interval = Math.max(1, config.digestMinutes) * 60000;
      const due = score === 4 ? (Math.floor(now / interval) + 1) * interval : now;
      this.db.prepare("UPDATE events SET status='superseded' WHERE source=? AND external=? AND status IN ('pending','digest','ready')")
        .run(event.sourceId,event.externalId);
      this.db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,NULL,?)")
        .run(id,event.sourceId,event.externalId,event.revision,JSON.stringify(event),score,status,reason,due,groupKey);
      this.db.prepare("INSERT INTO decision_policies VALUES(?,?)").run(id,JSON.stringify(config));
      return this.get(id);
    });
  }
  get(id: string) {
    const row = this.db.prepare("SELECT * FROM events WHERE id=?").get(id);
    if (!row) throw new Error("找不到对应的事件");
    return decode(row);
  }
  list(status: "ready"): ActionCard[];
  list(status?: string): Decision[];
  list(status?: string): Decision[] {
    const rows = status ? this.db.prepare("SELECT * FROM events WHERE status=? ORDER BY rowid DESC").all(status)
      : this.db.prepare("SELECT * FROM events ORDER BY rowid DESC").all();
    return rows.map(row => status === "ready" ? cardFor(decode(row)) : decode(row));
  }
  explain(id: string, at = new Date()) {
    const decision = this.get(id);
    const current = this.settings();
    const policy = this.db.prepare("SELECT json FROM decision_policies WHERE event_id=?").get(id);
    let waitingFor: string | null = null;
    if (decision.status === "pending" || decision.status === "digest") {
      const source = current.rules.find(rule => rule.sourceId === decision.sourceId);
      const previous = this.db.prepare("SELECT MAX(delivered_at) AS at FROM events WHERE group_key=?").get(decision.groupKey);
      if (at.getTime() < decision.dueAt) waitingFor = "汇总时间";
      else if (!source?.bypassQuiet && quiet(at.getTime(), current)) waitingFor = "免打扰结束";
      else if (previous?.at != null && Number(previous.at)+current.cooldownMinutes*60000 > at.getTime()) waitingFor = "冷却结束";
      else waitingFor = "下一次投递";
    }
    return {decision, waitingFor, policyAtIngest: policy ? JSON.parse(String(policy.json)) : null};
  }
  inbox(): { title: string; events: ActionCard[] }[] {
    const groups = new Map<string, {title: string; events: ActionCard[]}>();
    for (const e of this.list("ready")) {
      const key = e.score === 4 ? "digest:" + e.dueAt : e.id;
      const group = groups.get(key) ?? {title: e.score === 4 ? "定时汇总" : e.title, events: []};
      group.events.push(e);
      groups.set(key, group);
    }
    return [...groups.values()];
  }
  dispatchDue(at = new Date()): ActionCard[] {
    const now = at.getTime();
    return this.transaction(() => {
      const config = this.settings();
      const rows = this.db.prepare("SELECT * FROM events WHERE status IN ('pending','digest') AND due_at<=? ORDER BY due_at,rowid").all(now);
      const delivered = [];
      for (const row of rows) {
        const event = decode(row);
        const rule = config.rules.find(r => r.sourceId === event.sourceId);
        if (quiet(now, config) && !rule?.bypassQuiet) continue;
        const prev = this.db.prepare("SELECT MAX(delivered_at) AS last FROM events WHERE group_key=?").get(event.groupKey);
        if (prev?.last != null && Number(prev.last) + config.cooldownMinutes * 60000 > now) continue;
        this.db.prepare("UPDATE events SET status='ready',delivered_at=? WHERE id=?").run(now, event.id);
        delivered.push(cardFor({ ...event, deliveredAt: now, status: "ready" }));
      }
      return delivered;
    });
  }
  accept(id: string, revision: string): { text: string; at: number } {
    return this.transaction(() => {
      const event = this.get(id);
      if (event.revision !== revision) throw new Error("行动卡版本已改变");
      const existing = this.db.prepare("SELECT draft,at FROM receipts WHERE event_id=?").get(id);
      if (existing) return { text: String(existing.draft), at: Number(existing.at) };
      if (event.status !== "ready") throw new Error("当前行动卡不可执行");
      const text = event.action?.text ?? cardFor(event).action.text;
      const at = Date.now();
      this.db.prepare("INSERT INTO receipts VALUES(?,?,?)").run(id,text,at);
      this.db.prepare("UPDATE events SET status='accepted' WHERE id=?").run(id);
      return { text, at };
    });
  }
  cursor(source: string): string | undefined {
    const row = this.db.prepare("SELECT json FROM cursors WHERE source=?").get(source);
    return row && String(row.json);
  }
  checkpoint(source: string, value: string) {
    this.db.prepare("INSERT OR REPLACE INTO cursors VALUES(?,?)").run(source,value);
  }
  lease(owner: string, ttl = 90000): boolean {
    const now = Date.now();
    const result = this.db.prepare(`INSERT INTO lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET
      owner=excluded.owner,until=excluded.until WHERE owner=excluded.owner OR until<=?`).run(owner,now+ttl,now);
    return Number(result.changes) === 1;
  }
  release(owner: string) { this.db.prepare("DELETE FROM lease WHERE owner=?").run(owner); }
  close() { this.db.close(); }
}

export { syncFeed, watchDirectory, scoreWithOllama } from "./sources.js";
