import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import {
  createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition,
  type ExtensionFactory, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { openSnapshot } from "@minder/core-snapshot";

type Manager = Awaited<ReturnType<typeof openSnapshot>>;
type Transaction = Awaited<ReturnType<Manager["begin"]>>;
export interface SnapshotExtensionOptions { stateDir?: string; roots?: string[]; maxFileBytes?: number; additionalTools?: readonly string[] }
export function createSnapshotExtension(options: SnapshotExtensionOptions = {}): ExtensionFactory {
  return pi => {
    let manager: Promise<Manager> | undefined;
    let transaction: Promise<Transaction> | undefined;
    let workspace = options.roots?.[0] ?? process.cwd();
    let mutated = false;
    let failed = false;
    type Confirmation = Parameters<Manager["irreversibleRemove"]>[1];
    let exceptional: ((confirm: Confirmation) => Promise<void>) | undefined;
    const stateDir = options.stateDir ?? join(process.env.MINDER_HOME ?? join(homedir(), ".minder"), "snapshot");
    const store = () => manager ??= openSnapshot({stateDir,roots:options.roots ?? [workspace],maxFileBytes:options.maxFileBytes});
    const tx = () => transaction ??= store().then(db=>db.begin("Pi file changes"));
    const managed = new Set(["read","edit","write","minder_delete","minder_move","minder_list_files","minder_memory_search","minder_memory_propose","minder_firewall_list",...(options.additionalTools??[])]);
    pi.on("context",event=>({messages:event.messages.filter(message=>
      message.role!=="custom" || message.customType!=="minder-file-diff")}));
    const stage = async (operation:()=>Promise<void>, largeOperation?: (confirm:Confirmation)=>Promise<void>) => {
      try { await operation(); mutated=true; }
      catch(error) {
        failed=true;
        if (error && typeof error==="object" && "code" in error && error.code==="LARGE_FILE") exceptional=largeOperation;
        throw error;
      }
    };
    const readFile = async(path:string)=>(await tx()).read(path);
    const writeFile = async(path:string,content:string)=>stage(async()=>(await tx()).write(path,content),
      async confirm=>(await store()).irreversibleWrite(path,content,confirm));
    const access = async(path:string)=>{await readFile(path);};
    pi.registerTool({
      name:"minder_list_files",label:"List workspace files",
      description:"List actual file and folder names in a workspace directory. The default is the workspace root. Use this before guessing document paths; follow nextOffset for additional pages. Staged writes appear after commit.",
      parameters:Type.Object({path:Type.Optional(Type.String()),offset:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:1,maximum:200}))}),
      async execute(_id,{path,offset,limit}){
        const page=(await store()).listDirectory(path??".",offset,limit);
        return {content:[{type:"text",text:JSON.stringify(page)}],details:page};
      }
    });
    pi.registerTool(createReadToolDefinition(workspace,{operations:{readFile,access}}));
    pi.registerTool(createEditToolDefinition(workspace,{operations:{readFile,writeFile,access}}));
    pi.registerTool(createWriteToolDefinition(workspace,{operations:{writeFile,mkdir:async(dir)=>{
      if (!(await stat(dir)).isDirectory()) throw new Error("Destination parent must exist");
    }}}));
    pi.registerTool({
      name:"minder_delete",label:"Stage deletion",description:"Stage a regular file deletion in the current snapshot.",
      parameters:Type.Object({path:Type.String()}),
      async execute(_id,{path},_signal,_update,ctx){
        const absolute=resolve(ctx.cwd,path);
        await stage(async()=>(await tx()).remove(absolute),async confirm=>(await store()).irreversibleRemove(absolute,confirm));
        return {content:[{type:"text",text:"Staged deletion"}],details:{path}};
      }
    });
    pi.registerTool({
      name:"minder_move",label:"Stage move",description:"Stage a file move in the current snapshot.",
      parameters:Type.Object({from:Type.String(),to:Type.String()}),
      async execute(_id,{from,to},_signal,_update,ctx){await stage(async()=>(await tx()).move(resolve(ctx.cwd,from),resolve(ctx.cwd,to)));return {content:[{type:"text",text:"Staged move"}],details:{from,to}};}
    });
    pi.on("session_start",(_e,ctx)=>{
      workspace=ctx.cwd;
      pi.setActiveTools(pi.getActiveTools().filter(name=>managed.has(name)));
    });
    pi.on("tool_call",event=>{
      if (!managed.has(event.toolName)) return {block:true,reason:"Tool unavailable in the Minder managed-file profile"};
    });
    pi.on("user_bash",()=>{throw new Error("Interactive shell commands bypass the file transaction");});
    const finish = async (success:boolean,ctx:ExtensionContext) => {
      const pending=transaction;
      transaction=undefined;
      const commit=success && mutated && !failed;
      const exception=exceptional;
      mutated=false;failed=false;exceptional=undefined;
      if (!pending) return;
      const current=await pending;
      if (commit) {
        const diff=await current.commit();
        pi.sendMessage({customType:"minder-file-diff",content:stripVTControlCharacters("File Diff · " + diff.id + "\n" + diff.files.map(f=>f.patch || f.kind + " " + f.path).join("\n")),display:true});
      } else await current.abort();
      if (success && exception && ctx.hasUI) {
        await exception(details=>ctx.ui.confirm("超过快照上限，本次操作无法撤销",
          details.operation + " " + details.path + "\n" + details.beforeBytes + " → " + details.afterBytes + " bytes"));
      }
    };
    pi.on("agent_before_settle",event=>{if (event.outcome!=="completed") failed=true;});
    pi.on("agent_settled",async(event,ctx)=>finish(!event.aborted,ctx));
    pi.registerCommand("minder-files",{
      description:"Show snapshot history or File Diff <id>.",
      handler:async(args)=>{const db=await store();const value=args.trim()?await db.diff(args.trim()):await db.list();pi.sendMessage({customType:"minder-file-diff",content:JSON.stringify(value,null,2),display:true});}
    });
    pi.registerCommand("minder-undo",{
      description:"Undo the selected snapshot or latest committed file transaction.",
      handler:async(args)=>{const db=await store();const id=args.trim() || (await db.list()).find(r=>r.status==="committed")?.id;if(!id) throw new Error("No committed snapshot");const value=await db.undo(id);pi.sendMessage({customType:"minder-file-diff",content:JSON.stringify(value,null,2),display:true});}
    });
    pi.on("session_shutdown",async(_event,ctx)=>{await finish(false,ctx);(await manager)?.close();manager=undefined;});
  };
}
export default createSnapshotExtension();
