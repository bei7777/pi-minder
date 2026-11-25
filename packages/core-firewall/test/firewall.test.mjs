import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import { Firewall, syncFeed, watchDirectory } from "../lib/index.js";

const parent = resolve(".minder-dev");
await mkdir(parent, { recursive: true });
async function open(t) {
  const dir = await mkdtemp(join(parent,"firewall-"));
  const db = new Firewall(join(dir,"data"));
  t.after(() => db.close());
  return { dir, db };
}
const event = (id, score) => ({
  sourceId:"release", externalId:id, revision:"r1", occurredAt:"2026-11-25T10:00:00Z",
  title:"Minder release", summary:"Review the release artifacts.", kind:"release", score
});

test("按分数归档、汇总和确认，重启后保留决策与回执", async t => {
  const {dir,db} = await open(t);
  db.configure({quietStart:"00:00",quietEnd:"00:00",timezone:"UTC",cooldownMinutes:10});
  const clock = new Date("2026-11-25T10:00:00Z");
  const low = db.ingest(event("low",2),clock);
  assert.equal(low.status,"archived");
  assert.equal(db.ingest(event("low",2)).id,low.id);
  db.ingest(event("digest-a",4),clock);
  db.ingest(event("digest-b",4),clock);
  const high = db.ingest(event("high",5),clock);
  assert.deepEqual(db.dispatchDue(clock).map(e=>e.id),[high.id]);
  const receipt = db.accept(high.id,"r1");
  const second = new Firewall(join(dir,"data"));
  try {
    assert.deepEqual(second.accept(high.id,"r1"), receipt);
    second.ingest({...event("high",5), revision:"r2"},clock);
    assert.equal(second.dispatchDue(clock).length,0);
    assert.equal(second.dispatchDue(new Date("2026-11-25T11:00:00Z")).length,3);
    assert.equal(second.inbox().find(group=>group.title==="定时汇总").events.length,2);
  } finally { second.close(); }
});

test("规则优先与跨午夜静默；监听者租约互斥", async t => {
  const {db} = await open(t);
  db.configure({ quietStart:"22:00",quietEnd:"07:00",timezone:"America/New_York",rules:[{sourceId:"release",score:5}] });
  const start = new Date("2026-11-01T05:30:00Z");
  const item = db.ingest(event("zone",2),start);
  assert.equal(item.score,5);
  assert.equal(db.dispatchDue(start).length,0);
  assert.equal(db.explain(item.id,start).waitingFor,"免打扰结束");
  assert.equal(db.explain(item.id,start).policyAtIngest.rules[0].score,5);
  assert.equal(db.dispatchDue(new Date("2026-11-01T12:00:00Z")).length,1);
  assert.equal(db.lease("a"),true);
  assert.equal(db.lease("b"),false);
  db.release("a");
  assert.equal(db.lease("b"),true);
});

test("本地 HTTP 服务器发布实际项目公告的 Atom 订阅", async t => {
  const {db} = await open(t);
  const xml = await readFile(new URL("./release.atom",import.meta.url));
  const server = createServer((_req,res)=>{res.setHeader("content-type","application/atom+xml");res.end(xml);});
  await new Promise((ok,fail)=>server.once("error",fail).listen(0,"127.0.0.1",ok));
  try {
    const url = "http://127.0.0.1:"+server.address().port+"/release";
    await syncFeed(db,url);
    await syncFeed(db,url);
    assert.equal(db.list().length,1);
    assert.equal(db.list()[0].externalId,"urn:minder:development-plan");
  } finally { await new Promise(ok=>server.close(ok)); }
});

test("真实文件变更进入监听记录", async t => {
  const {db,dir} = await open(t);
  const root = join(dir,"notes"); await mkdir(root);
  let failure;
  const stop = await watchDirectory(db,root,e=>{failure=e;});
  async function waitFor(kind) {
    for (let i=0;i<150;i++) {
      if (failure) throw failure;
      if (db.list().some(e=>e.kind===kind)) return;
      await delay(40);
    }
    assert.fail("没有收到文件事件 "+kind);
  }
  try {
    const path=join(root,"笔记.md");
    await writeFile(path,"初稿"); await waitFor("created");
    await writeFile(path,"已修订"); await waitFor("modified");
    await unlink(path); await waitFor("deleted");
  } finally { await stop(); }
});
