import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
const workspace=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const install=process.env.MINDER_PI_INSTALL_ROOT;
async function load(name,local) {
  const dir=install ? join(resolve(install),"node_modules",name) : join(workspace,local);
  const manifest=JSON.parse(readFileSync(join(dir,"package.json"),"utf8"));
  const entry=manifest.exports["."].import;
  return import(pathToFileURL(join(dir,entry)).href);
}
const {createAgentSession,DefaultResourceLoader,SessionManager}=await load("@earendil-works/pi-coding-agent","node_modules/@earendil-works/pi-coding-agent");
const {createSnapshotExtension}=await load("pi-minder-snapshot","packages/pi-minder-snapshot");
const {createMemoryExtension}=await load("pi-minder-memory","packages/pi-minder-memory");
const {createFirewallExtension}=await load("pi-minder-firewall","packages/pi-minder-firewall");
const {MemoryStore}=await load("@minder/core-memory","packages/core-memory");
const {Firewall}=await load("@minder/core-firewall","packages/core-firewall");
const {openSnapshot}=await load("@minder/core-snapshot","packages/core-snapshot");

test("三个扩展在真实 Pi SDK 中注册工具，持久化事务并处理用户命令",async()=>{
  const scratch=join(workspace,".minder-dev/pi-host-tests");
  mkdirSync(scratch,{recursive:true});
  const home=mkdtempSync(join(scratch,"run-"));
  const cwd=join(home,"workspace"), agentDir=join(home,"agent"), roots=[cwd];
  const stateDir=join(home,"snapshot"),vaultDir=join(home,"memory"), firewallDir=join(home,"firewall");
  mkdirSync(cwd);mkdirSync(agentDir);
  const file=join(cwd,"notes.md");writeFileSync(file,"Original");
  const loader=new DefaultResourceLoader({cwd,agentDir,noContextFiles:true,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,
    extensionFactories:[createSnapshotExtension({roots,stateDir}),createMemoryExtension({vaultDir}),createFirewallExtension({stateDir:firewallDir})]});
  await loader.reload();
  const {session}=await createAgentSession({cwd,agentDir,resourceLoader:loader,sessionManager:SessionManager.inMemory(cwd)});
  try {
    await session.bindExtensions({});
    assert.ok(session.getActiveToolNames().includes("minder_delete"));
    assert.ok(!session.getActiveToolNames().includes("bash"));
    const run=(name,args)=>{
      const tool=session.agent.state.tools.find(t=>t.name===name);
      assert.ok(tool,name);return tool.execute(randomUUID(),args);
    };
    await run("write",{path:"notes.md",content:"Reviewed"});
    await run("edit",{path:"notes.md",edits:[{oldText:"Reviewed",newText:"Revised"}]});
    assert.ok((await run("read",{path:"notes.md"})).content.some(c=>c.text?.includes("Revised")));
    assert.equal(readFileSync(file,"utf8"),"Original");
    await session.extensionRunner.emit({type:"agent_settled",aborted:false});
    assert.equal(readFileSync(file,"utf8"),"Revised");
    const snapshot=await openSnapshot({stateDir,roots});
    const [tx]=await snapshot.list();snapshot.close();
    await session.prompt("/minder-undo " + tx.id);
    assert.equal(readFileSync(file,"utf8"),"Original");
    await run("minder_memory_propose",{key:"ui.language",layer:"core",text:"使用中文",source:"用户明确提出"});
    await session.prompt("/minder-memory commit");
    const memory=new MemoryStore(vaultDir);
    try {assert.equal(memory.search("中文").length,1);}finally{memory.close();}
    await session.prompt("/minder-firewall rule calendar 5");
    const firewall=new Firewall(firewallDir);
    try {assert.equal(firewall.settings().rules.find(r=>r.sourceId==="calendar")?.score,5);}finally{firewall.close();}
  } finally {
    await session.extensionRunner.emit({type:"session_shutdown",reason:"quit"});
    session.dispose();rmSync(home,{recursive:true,force:true});
  }
});
