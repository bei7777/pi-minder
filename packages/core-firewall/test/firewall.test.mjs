import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import { XMLBuilder } from "fast-xml-parser";
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
const sentenceCount = text => Array.from(new Intl.Segmenter("zh",{granularity:"sentence"}).segment(text)).length;
function checkCard(card) {
  assert.equal(sentenceCount(card.summary),2);
  assert.ok(card.title.length <= 80 && card.summary.length <= 159);
  assert.ok(card.action.label.length > 0 && card.action.label.length <= 32);
  assert.ok(card.action.text.length > 0 && card.action.text.length <= 160);
}

test("按分数归档、汇总和确认，重启后保留决策与回执", async t => {
  const {dir,db} = await open(t);
  db.configure({quietStart:"00:00",quietEnd:"00:00",timezone:"UTC",cooldownMinutes:10});
  const clock = new Date("2026-11-25T10:00:00Z");
  const low = db.ingest(event("low",2),clock);
  assert.equal(low.status,"archived");
  assert.equal(db.ingest(event("low",2)).id,low.id);
  db.ingest(event("digest-a",4),clock);
  db.ingest(event("digest-b",4),clock);
  const draft = await readFile(new URL("../README.md",import.meta.url),"utf8");
  const action = {label:"审阅发布说明",text:draft};
  const high = db.ingest({...event("high",5),action},clock);
  const [card] = db.dispatchDue(clock);
  assert.equal(card.id,high.id);
  checkCard(card);
  assert.equal(card.draftPreviewOnly,true);
  assert.equal(card.action.label,action.label);
  assert.deepEqual(db.get(high.id).action,action);
  const receipt = db.accept(high.id,"r1");
  assert.equal(receipt.text,draft);
  const second = new Firewall(join(dir,"data"));
  try {
    assert.deepEqual(second.accept(high.id,"r1"), receipt);
    second.ingest({...event("high",5), action, revision:"r2"},clock);
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
  const family = "👩‍👩‍👧‍👦";
  const longText = family.repeat(20);
  const long = db.ingest({...event("unicode",5),title:longText,summary:longText+"。请审阅。"},start);
  const [bounded] = db.dispatchDue(new Date("2026-11-01T12:00:00Z"));
  checkCard(bounded);
  assert.equal(bounded.title, family.repeat(7)+"…");
  assert.equal(bounded.summary,family.repeat(7)+"…。 请审阅。");
  assert.equal(db.get(long.id).title,longText);
  assert.equal(db.lease("a"),true);
  assert.equal(db.lease("b"),false);
  db.release("a");
  assert.equal(db.lease("b"),true);
});

test("本地 HTTP 服务器发布实际项目公告的 Atom 订阅", async t => {
  const {db} = await open(t);
  const xml = await readFile(new URL("./release.atom",import.meta.url));
  const docs = await Promise.all(["../README.md","../../core-memory/README.md","../../core-snapshot/README.md","../../../LICENSE"]
    .map(file=>readFile(new URL(file,import.meta.url),"utf8")));
  const heading = "Minder 发布说明。以下为三个核心模块的使用文档。";
  const article = (heading + "\r\n" + docs.join("\r\n")).slice(0,4096).trimEnd();
  const xmlText = article.replace(/\r\n?/gu,"\n");
  assert.ok(article.length > 3000);
  const rss = new XMLBuilder().build({rss:{channel:{title:"Minder",item:{
    title:"核心模块使用文档",guid:"urn:minder:core-manuals",description:article
  }}}});
  const server = createServer((req,res)=>{
    const manual=req.url==="/manual";
    res.setHeader("content-type",manual?"application/rss+xml":"application/atom+xml");
    res.end(manual?rss:xml);
  });
  await new Promise((ok,fail)=>server.once("error",fail).listen(0,"127.0.0.1",ok));
  try {
    const url = "http://127.0.0.1:"+server.address().port+"/release";
    await syncFeed(db,url);
    await syncFeed(db,url);
    assert.equal(db.list().length,1);
    assert.equal(db.list()[0].externalId,"urn:minder:development-plan");
    const manual = new URL("/manual",url).href;
    db.configure({rules:[{sourceId:manual,score:5,bypassQuiet:true}]});
    const [item] = await syncFeed(db,manual);
    const [card] = db.dispatchDue();
    checkCard(card);
    assert.equal(card.summary,"Minder 发布说明。 以下为三个核心模块的使用文档。");
    assert.equal(card.action.label,"整理订阅待办");
    assert.equal(card.draftPreviewOnly,false);
    const visibleFields = new Set(["status","title","summary","action","deliveredAt"]);
    for (const [key,value] of Object.entries(item))
      if (!visibleFields.has(key)) assert.deepEqual(card[key],value);
    assert.equal(db.get(item.id).summary,xmlText);
    assert.equal(db.explain(item.id).decision.summary,xmlText);
    assert.deepEqual(db.list("ready"),[card]);
    assert.deepEqual(db.inbox(),[{title:card.title,events:[card]}]);
    assert.equal(db.accept(item.id,item.revision).text,card.action.text);
  } finally { await new Promise(ok=>server.close(ok)); }
});

test("真实文件变更进入监听记录", async t => {
  const {db,dir} = await open(t);
  const root = join(dir,"notes"); await mkdir(root);
  db.configure({rules:[{sourceId:"dir:"+await realpath(root),score:5,bypassQuiet:true}],cooldownMinutes:0});
  let failure;
  const stop = await watchDirectory(db,root,e=>{failure=e;});
  async function waitFor(kind, count = 1) {
    for (let i=0;i<150;i++) {
      if (failure) throw failure;
      if (db.list().filter(e=>e.kind===kind).length >= count) return;
      await delay(40);
    }
    assert.fail("没有收到文件事件 "+kind);
  }
  try {
    const path=join(root,"笔记.md");
    await writeFile(path,"初稿"); await waitFor("created");
    await writeFile(path,"已修订"); await waitFor("modified");
    await writeFile(path,"完成第二次修订"); await waitFor("modified",2);
    await unlink(path); await waitFor("deleted");
    const [card] = db.dispatchDue();
    checkCard(card);
    assert.equal(card.action.label,"核对文件变更");
    assert.match(card.action.text,/笔记\.md/);
    assert.match(card.summary,/删除/);
    assert.equal(db.get(card.id).summary,"deleted · 笔记.md");
    assert.deepEqual(db.list("ready"),[card]);
    assert.equal(db.accept(card.id,card.revision).text,card.action.text);
  } finally { await stop(); }
});
