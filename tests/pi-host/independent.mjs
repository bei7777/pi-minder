import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const consumer = process.env.MINDER_PI_INSTALL_ROOT;
const registry = new URL(process.env.MINDER_TEST_REGISTRY);
assert.equal(registry.hostname,"127.0.0.1","Use the isolated local release registry");
assert.ok(consumer,"Set MINDER_PI_INSTALL_ROOT to the installed release consumer");
const root = resolve(consumer);
const sdk = join(root,"node_modules","@earendil-works","pi-coding-agent");
const manifest = JSON.parse(await readFile(join(sdk,"package.json"),"utf8"));
const cli = join(sdk,manifest.bin.pi);
const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(join(sdk,manifest.exports["."].import)));
const expected = { snapshot:"minder_delete",memory:"minder_memory_search",firewall:"minder_firewall_list" };
for (const [capability,tool] of Object.entries(expected)) {
  const subject = "pi-minder-" + capability;
  const installed = JSON.parse(await readFile(join(root,"node_modules",subject,"package.json"),"utf8"));
  const dir = await mkdtemp(join(root,"independent-" + capability + "-"));
  const agentDir = join(dir,"agent");
  const cwd = join(dir,"workspace");
  await mkdir(cwd);
  const env = {...process.env,PI_CODING_AGENT_DIR:agentDir,MINDER_HOME:join(dir,"state"),PI_SKIP_VERSION_CHECK:"1"};
  await execute(process.execPath,[cli,"install","npm:" + subject + "@" + installed.version],{env,cwd,timeout:180000});
  const settings = JSON.parse(await readFile(join(agentDir,"settings.json"),"utf8"));
  assert.deepEqual(settings.packages,["npm:" + subject + "@" + installed.version]);
  const loader = new DefaultResourceLoader({cwd,agentDir,settingsManager:SettingsManager.create(cwd,agentDir),
    noContextFiles:true,noThemes:true,noSkills:true,noPromptTemplates:true});
  await loader.reload();
  const reported = loader.getExtensions();
  assert.deepEqual(reported.errors,[]);
  const tools = reported.extensions.flatMap(extension=>[...extension.tools.keys()]);
  assert.ok(tools.includes(tool),subject + " did not register " + tool);
  for (const other of Object.values(expected).filter(value=>value!==tool)) assert.ok(!tools.includes(other),"Unexpected tool: " + other);
  console.log(subject + "@" + installed.version + " independently installed and loaded via pi install");
}
