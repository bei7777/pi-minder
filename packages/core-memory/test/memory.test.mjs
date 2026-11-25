import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { MemoryStore } from "../lib/index.js";

const scratch = resolve(".minder-dev/memory-tests");
mkdirSync(scratch,{recursive:true});
function open(t) {
  const dir=mkdtempSync(join(scratch,"vault-"));
  const store=new MemoryStore(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {store,dir};
}
const profile={key:"ui.language",layer:"core",source:"用户在本次会话中选择语言",intent:"observed",text:"使用中文"};

test("审阅、重写、外部编辑冲突、可追溯撤销",t=>{
  const {store,dir}=open(t);
  const first=store.begin("one");
  store.propose(first,profile);
  assert.deepEqual(store.search("中文"),[]);
  assert.equal(store.diff(first).length,1);
  const created=store.commit(first);
  const found=store.search("使用中文")[0];
  assert.equal(found.key,profile.key);
  const second=store.begin("two");
  store.propose(second,{...profile,text:"使用英文"});
  const update=store.commit(second);
  assert.equal(store.search("英文").length,1);
  assert.equal(store.search("中文").length,0);
  store.revert(update.id);
  assert.equal(store.search("中文").length,1);
  store.propose(store.begin("three"),{...profile,text:"使用法语"});
  const file=join(dir,found.path);
  const old=readFileSync(file,"utf8");
  writeFileSync(file,old.replace("使用中文","使用德语"));
  assert.equal(store.search("德语").length,1);
  assert.throws(()=>store.commit("three"),/after review/);
  assert.throws(()=>store.revert(created.id),/after review/);
});

test("短期记忆过期归档，同一事实的候选并发冲突",t=>{
  const {store}=open(t);
  const active={...profile,key:"project.status",layer:"active",text:"复核数据",expiresAt:"2024-01-01T00:00:00Z"};
  assert.throws(()=>store.propose(store.begin("ttl"),{...active,expiresAt:undefined}),/TTL/);
  store.propose("ttl",active);store.commit("ttl");
  const archived=store.expire();
  assert.ok(archived.changes.some(c=>c.path.startsWith("archive/")));
  assert.equal(store.search("复核数据").length,0);
  store.propose(store.begin("a"),profile);
  store.propose(store.begin("b"),{...profile,layer:"episodic",text:"会议里使用英文"});
  store.commit("a");
  assert.throws(()=>store.commit("b"),/Concurrent change/);
  assert.equal(store.search("使用中文")[0].layer,"core");
});

test("持久化候选在不同的本地连接中可审阅",t=>{
  const {store,dir}=open(t);
  store.propose(store.begin("persist"),profile);
  const second=new MemoryStore(dir);
  try { assert.equal(second.diff("persist").length,1);second.commit("persist"); }
  finally {second.close();}
  assert.equal(store.history().length,1);
  assert.equal(store.search("使用中文").length,1);
});

test("逐条批准和放弃，各自独立；重新建立全文索引后仍能撤销",t=>{
  const dir=mkdtempSync(join(scratch,"reindex-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store=new MemoryStore(dir);
  const sid=store.begin("audit");
  store.propose(sid,profile);
  store.propose(sid,{...profile,key:"theme",text:"默认浅色"});
  store.propose(sid,{...profile,key:"footer",text:"显示时间"});
  const accepted=store.commit(sid,["ui.language"]);
  assert.equal(store.diff(sid).length,2);
  store.discard(sid,"footer");
  assert.equal(store.diff(sid)[0].key,"theme");
  store.commit(sid);
  store.close();
  rmSync(join(dir,".minder/index.sqlite"));
  const restored=new MemoryStore(dir);
  try {
    assert.equal(restored.search("使用中文").length,1);
    assert.equal(restored.history().length,2);
    restored.revert(accepted.id);
    assert.equal(restored.search("使用中文").length,0);
    assert.equal(restored.search("默认浅色").length,1);
  } finally {restored.close();}
});

test("按会话原文拟定每日摘要，已拒绝的相同摘要保持静默",t=>{
  const {store}=open(t);
  const at=new Date().toISOString();
  const turns=[{at,role:"user",text:"检查周报出处。",ref:"daily/1"},{at,role:"assistant",text:"已找到三段原文。",ref:"daily/2"}];
  const [draft]=store.proposeEpisode("journal",turns);
  assert.ok(draft.path.startsWith("episodic/"));
  assert.ok(draft.after.includes("已找到三段原文"));
  assert.ok(draft.after.includes("daily/2"));
  assert.equal(store.search("周报").length,0);
  store.discard("journal");
  assert.deepEqual(store.proposeEpisode("journal",turns),[]);
  store.proposeEpisode("journal",[...turns,{at,role:"user",text:"确认出处。",ref:"daily/3"}]);
  store.commit("journal");
  assert.equal(store.search("确认出处")[0].layer,"episodic");
});
