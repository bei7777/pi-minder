import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { openSnapshot } from "../lib/index.js";

async function fixture(t, settings = {}) {
  const base = resolve(".snapshot-test-work");
  mkdirSync(base,{recursive:true});
  const dir = mkdtempSync(join(base,"case-"));
  const root = join(dir,"workspace");
  const stateDir = join(dir,"state");
  mkdirSync(root);
  const options = {roots:[root],stateDir,...settings};
  const manager = await openSnapshot(options);
  t.after(() => {
    manager.close();
    rmSync(dir,{recursive:true,force:true});
  });
  return {options,root,stateDir,manager, path:name=>join(root,name)};
}

test("create, modify, rename and delete appear as one reviewed transaction",async t=>{
  const {manager,path} = await fixture(t);
  writeFileSync(path("notes"),"old\n");
  writeFileSync(path("archive"),"history\n");
  const tx = await manager.begin("weekly materials");
  await tx.write("notes","new\n");
  await tx.move("archive","history");
  await tx.write("new","created\n");
  assert.equal((await tx.read("notes")).toString(),"new\n");
  assert.equal(readFileSync(path("notes"),"utf8"),"old\n");
  await assert.rejects(tx.read("archive"),{code:"NOT_FOUND"});
  const diff = await tx.commit();
  assert.equal(diff.files.length,4);
  assert.match(diff.files.find(f=>f.path===path("notes")).patch,/-old\n\+new/);
  assert.equal(existsSync(path("archive")),false);
  assert.equal(readFileSync(path("history"),"utf8"),"history\n");
  assert.equal((await manager.undo(tx.id)).status,"undone");
  assert.equal(readFileSync(path("notes"),"utf8"),"old\n");
  assert.equal(readFileSync(path("archive"),"utf8"),"history\n");
  assert.equal(existsSync(path("new")),false);
  assert.equal(existsSync(path("history")),false);
  assert.equal((await manager.undo(tx.id)).status,"undone");
});

test("concurrent managers serialize writes and conflicting user edits survive",async t=>{
  const {manager,options,path} = await fixture(t);
  const second = await openSnapshot(options);
  try {
    const tx = await manager.begin("two participants");
    await assert.rejects(second.begin("busy"),{code:"BUSY"});
    await tx.write("first","one");
    await tx.write("second","two");
    await tx.commit();
    writeFileSync(path("second"),"human");
    await assert.rejects(second.undo(tx.id),{code:"CONFLICT"});
    assert.equal(readFileSync(path("first"),"utf8"),"one");
    assert.equal(readFileSync(path("second"),"utf8"),"human");
    const stale = await manager.begin("stale");
    await stale.write("second","update");
    writeFileSync(path("second"),"new human content");
    await assert.rejects(stale.commit(),{code:"CONFLICT"});
    assert.equal(readFileSync(path("second"),"utf8"),"new human content");
  } finally { second.close(); }
});

if (process.platform === "win32") {
  test("Windows sharing restrictions prevent partial undo and a retry restores both paths", async t=>{
    const {manager,path} = await fixture(t);
    writeFileSync(path("first.txt"),"first");
    writeFileSync(path("locked.txt"),"second");
    const tx = await manager.begin("Windows file sharing");
    for (const input of ["//minder.invalid/share/note","notes.txt:stream","NUL.txt"]) {
      await assert.rejects(tx.write(input,"data"),{code:"PATH"});
    }
    await tx.write(path("first.txt"),"edited");
    await tx.write(path("locked.txt"),"edited");
    await tx.commit();
    const helper = fileURLToPath(new URL("./lock.ps1",import.meta.url));
    const child = spawn("pwsh",["-NoProfile","-NonInteractive","-File",helper,path("locked.txt")],
      {stdio:["pipe","pipe","inherit"], timeout:30000});
    const exited = once(child,"exit");
    try {
      const [ready] = await Promise.race([
        once(child.stdout,"data"),
        exited.then(([code])=>{throw new Error("File lock process exited early: "+code);})
      ]);
      assert.equal(ready.toString().trim(),"locked");
      await assert.rejects(manager.undo(tx.id),error=>["EBUSY","EPERM","EACCES"].includes(error.code));
      assert.equal(readFileSync(path("first.txt"),"utf8"),"edited");
    } finally {
      child.stdin.end("\n");
      const [code] = await exited;
      assert.equal(code,0);
    }
    await manager.undo(tx.id);
    assert.equal(readFileSync(path("first.txt"),"utf8"),"first");
    assert.equal(readFileSync(path("locked.txt"),"utf8"),"second");
  });
}

test("reject traversal, protected ancestors, links and aliased regular files",async t=>{
  const {manager,root,path,stateDir} = await fixture(t);
  const tx = await manager.begin("path checks");
  await assert.rejects(tx.write("../outside","x"),{code:"OUTSIDE_ROOT"});
  mkdirSync(path(".ssh"));
  await assert.rejects(tx.write(".ssh/key","x"),{code:"PROTECTED"});
  symlinkSync(stateDir,path("linked"),process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(tx.write("linked/journal.sqlite","x"),{code:"SYMLINK"});
  writeFileSync(path("original"),"user-data");
  linkSync(path("original"),join(root,"alias"));
  await assert.rejects(tx.write("alias","x"),{code:"TYPE"});
  assert.equal(readFileSync(path("original"),"utf8"),"user-data");
  await tx.abort();
});

test("large-file approval is human, separately audited, and guards against later replacement",async t=>{
  const {manager,path,stateDir} = await fixture(t,{maxFileBytes:4});
  writeFileSync(path("big"),"12345");
  const tx = await manager.begin("oversize");
  await assert.rejects(tx.remove("big"),{code:"LARGE_FILE"});
  await tx.abort();
  await assert.rejects(manager.irreversibleRemove("big",async info=>{
    assert.equal(info.beforeBytes,5);
    return false;
  }),{code:"DENIED"});
  await assert.rejects(manager.irreversibleRemove("big",async ()=>{
    writeFileSync(path("big"),"changed by human");
    return true;
  }),{code:"CONFLICT"});
  assert.equal(readFileSync(path("big"),"utf8"),"changed by human");
  await manager.irreversibleRemove("big",async ()=>true);
  const audit = new DatabaseSync(join(stateDir,"journal.sqlite"));
  try {
    assert.deepEqual(audit.prepare("SELECT status FROM exceptions ORDER BY rowid").all().map(r=>r.status),["blocked","denied","conflict","executed"]);
  } finally { audit.close(); }
  assert.equal(existsSync(path("big")),false);
});

test("quota evicts oldest completed snapshots and preserves the last admitted staged bytes",async t=>{
  const {manager,path} = await fixture(t,{maxBytes:8});
  const first = await manager.begin("first");
  await first.write("a","12345");
  await first.commit();
  const second = await manager.begin("second");
  await second.write("b","abcde");
  await assert.rejects(manager.diff(first.id),{code:"NOT_FOUND"});
  await assert.rejects(second.write("c","45678"),{code:"QUOTA"});
  await second.commit();
  assert.equal(existsSync(path("c")),false);
  assert.equal(readFileSync(path("b"),"utf8"),"abcde");
});

test("a 500 MB plus one byte file only creates an audit record",async t=>{
  const {manager,path,stateDir} = await fixture(t);
  writeFileSync(path("recording"),"");
  truncateSync(path("recording"),500_000_001);
  const tx = await manager.begin("size policy");
  await assert.rejects(tx.write("recording","changed"),{code:"LARGE_FILE"});
  await tx.abort();
  assert.equal(statSync(path("recording")).size,500_000_001);
  assert.deepEqual(readdirSync(join(stateDir,"objects")),[]);
});

test("empty files and binary data survive replace and undo byte for byte",async t=>{
  const {manager,path} = await fixture(t);
  const bytes = Buffer.from([0,255,42,0,128]);
  writeFileSync(path("blob"),bytes);
  writeFileSync(path("empty"),"");
  const tx = await manager.begin("bytes");
  await tx.write("blob",Buffer.from([11,0,254]));
  await tx.remove("empty");
  assert.match((await tx.commit()).files.find(f=>f.path===path("blob")).patch,/Binary/);
  await manager.undo(tx.id);
  assert.deepEqual(readFileSync(path("blob")),bytes);
  assert.equal(readFileSync(path("empty")).length,0);
});

test("time-based retention removes expired history",async t=>{
  const {manager,path} = await fixture(t,{retentionMs:20});
  const tx = await manager.begin("expiry");
  await tx.write("retained","user file");
  await tx.commit();
  await delay(40);
  await manager.gc();
  await assert.rejects(manager.diff(tx.id),{code:"NOT_FOUND"});
  assert.equal(readFileSync(path("retained"),"utf8"),"user file");
});

test("a killed writer can resume a partially published commit", {timeout:60000},async t=>{
  const {manager,options,path} = await fixture(t);
  const child = fork(new URL("./writer.mjs",import.meta.url),[JSON.stringify(options)],{stdio:["ignore","ignore","inherit","ipc"]});
  t.after(()=>child.kill("SIGKILL"));
  const termination = once(child,"exit");
  const [id] = await once(child,"message");
  child.send("publish");
  while (!existsSync(path("item-000"))) {
    assert.equal(child.exitCode,null);
    await delay(1);
  }
  child.kill("SIGKILL");
  await termination;
  assert.equal((await manager.list())[0].status,"committing");
  assert.equal(existsSync(path("item-099")),false);
  await manager.recover();
  assert.equal((await manager.diff(id)).status,"committed");
  assert.equal(readFileSync(path("item-099"),"utf8"),"real staged bytes");
  await manager.undo(id);
  assert.equal(existsSync(path("item-000")),false);
});

test("restart completes a partially published undo without changing its outcome", {timeout:60000},async t=>{
  const {manager,options,path} = await fixture(t);
  const child = fork(new URL("./writer.mjs",import.meta.url),[JSON.stringify(options),"undo"],{stdio:["ignore","ignore","inherit","ipc"]});
  t.after(()=>child.kill("SIGKILL"));
  const termination = once(child,"exit");
  const [id] = await once(child,"message");
  const committed = once(child,"message");
  child.send("publish");
  await committed;
  child.send("undo");
  while (existsSync(path("item-000"))) {
    assert.equal(child.exitCode,null);
    await delay(1);
  }
  child.kill("SIGKILL");
  await termination;
  assert.equal((await manager.diff(id)).status,"undoing");
  assert.equal(existsSync(path("item-099")),true);
  const reopened = await openSnapshot(options);
  try {
    assert.equal((await reopened.undo(id)).status,"undone");
    assert.equal(existsSync(path("item-099")),false);
  } finally { reopened.close(); }
});
