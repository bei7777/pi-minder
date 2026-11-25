import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { randomUUID } from "node:crypto";
import { type ExtensionFactory, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Firewall, syncFeed, watchDirectory, type Score } from "@minder/core-firewall";

export interface FirewallExtensionOptions { stateDir?: string; pollIntervalMs?: number; manageSources?: boolean }
interface Sources { directories: string[]; feeds: string[] }
const empty: Sources = { directories:[], feeds:[] };
export function createFirewallExtension(options: FirewallExtensionOptions = {}): ExtensionFactory {
  return pi => {
    let db: Firewall | undefined;
    let timer: NodeJS.Timeout | undefined;
    let ongoing: Promise<void> | undefined;
    const watches = new Map<string,()=>Promise<void>>();
    const owner=randomUUID();
    const interval=options.pollIntervalMs ?? 60_000;
    const stopWatches = async () => {
      for(const close of watches.values()) await close();
      watches.clear();
    };
    const store = () => db ??= new Firewall(options.stateDir ?? join(process.env.MINDER_HOME ?? join(homedir(), ".minder"), "firewall"));
    const sources = (): Sources => JSON.parse(store().cursor("pi:minder:sources") ?? JSON.stringify(empty));
    const notifyError = (ctx: ExtensionContext, error: unknown) => ctx.ui.notify(String(error),"error");
    const poll = async (ctx: ExtensionContext) => {
      if (ongoing) return ongoing;
      ongoing = (async()=>{
        const backend=store();
        const configured=sources();
        if (options.manageSources!==false && (configured.directories.length || configured.feeds.length)) {
          if (backend.lease(owner,Math.max(90_000,interval*3))) {
            for (const dir of configured.directories) {
              if (!watches.has(dir)) watches.set(dir,await watchDirectory(backend,dir,error=>notifyError(ctx,error)));
            }
            for (const url of configured.feeds) await syncFeed(backend,url);
            backend.dispatchDue();
          } else await stopWatches();
        }
        if (!ctx.hasUI) return;
        const inbox=backend.list("ready");
        const seen=new Set<string>(JSON.parse(backend.cursor("pi:minder:shown") ?? "[]"));
        const ready=inbox.filter(card=>!seen.has(card.id));
        const digests=ready.filter(d=>d.score===4);
        if (digests.length) ctx.ui.notify("Minder 汇总 · " + digests.length + " 项，使用 /minder-firewall list 查看","info");
        for (const card of ready.filter(d=>d.score===5)) {
          const option = card.action ? card.action.label + " · " + card.action.text : "查看草稿";
          ctx.ui.notify(stripVTControlCharacters([card.title,card.summary,option,"/minder-firewall accept "+card.id].join("\n")),"info");
        }
        backend.checkpoint("pi:minder:shown",JSON.stringify(inbox.map(card=>card.id)));
      })();
      try { await ongoing; } finally { ongoing=undefined; }
    };
    pi.on("session_start",async(_event,ctx)=>{
      timer = setInterval(()=>{void poll(ctx).catch(error=>notifyError(ctx,error));},interval);
      timer.unref();
      await poll(ctx);
    });
    pi.registerTool({
      name:"minder_firewall_list",label:"Attention inbox",description:"List pending owner action card identifiers and delivery state.",
      parameters:Type.Object({}),
      async execute(){
        const items=store().list("ready").map(({id,revision,score})=>({id,revision,score}));
        return {content:[{type:"text",text:JSON.stringify(items)}],details:items};
      }
    });
    pi.registerCommand("minder-firewall",{
      description:"list, settings, quiet <start> <end> <zone>, rule <source> <1-5>, watch <dir>, feed <URL>, accept <id>, refresh",
      handler:async(args,ctx)=>{
        const [command="list",...fields]=args.trim().split(/\s+/u).filter(Boolean);
        const backend=store();
        let value:unknown;
        switch(command) {
          case "list": value=backend.list("ready");break;
          case "settings": value={...backend.settings(),...sources()};break;
          case "quiet":
            if(fields.length!==3) throw new Error("Specify start, end and an IANA timezone");
            value=backend.configure({quietStart:fields[0],quietEnd:fields[1],timezone:fields[2]});break;
          case "rule": {
            const score=Number(fields.pop()) as Score;
            const sourceId=fields.join(" ");
            value=backend.configure({rules:[...backend.settings().rules.filter(r=>r.sourceId!==sourceId),{sourceId,score}]});break;
          }
          case "watch":
          case "feed": {
            if (options.manageSources===false) throw new Error("使用发行版的 minder watch 管理事件来源");
            const data=sources(), input=fields.join(" ");
            if(!input) throw new Error("Specify a directory or feed URL");
            const key=command==="watch"?"directories":"feeds";
            const entry=command==="watch"?resolve(ctx.cwd,input):new URL(input).href;
            data[key]=[...new Set([...data[key],entry])];
            backend.checkpoint("pi:minder:sources",JSON.stringify(data));await poll(ctx);value=data;break;
          }
          case "refresh": await poll(ctx);value=backend.list("ready");break;
          case "accept": {
            const card=backend.get(fields[0] ?? "");
            const receipt=backend.accept(card.id,card.revision);
            ctx.ui.setEditorText(receipt.text);value="草稿已放入输入框";break;
          }
          default: throw new Error("Unknown firewall command");
        }
        ctx.ui.notify(typeof value==="string"?value:JSON.stringify(value,null,2),"info");
      }
    });
    pi.on("session_shutdown",async()=>{
      if(timer) clearInterval(timer);
      if(ongoing) await ongoing;
      await stopWatches();db?.release(owner);db?.close();db=undefined;
    });
  };
}
export default createFirewallExtension();
