import { homedir } from "node:os";
import { join } from "node:path";
import { type ExtensionFactory, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MemoryStore, type EpisodeTurn } from "@minder/core-memory";

export interface MemoryExtensionOptions { vaultDir?: string }
export function createMemoryExtension(options: MemoryExtensionOptions = {}): ExtensionFactory {
  return pi => {
    let db: MemoryStore | undefined;
    let timer: NodeJS.Timeout | undefined;
    const store = () => db ??= new MemoryStore(options.vaultDir ?? join(process.env.MINDER_HOME ?? join(homedir(), ".minder"), "memory"));
    const sessionId = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
    pi.on("context",event=>({messages:event.messages.filter(message=>
      message.role!=="custom" || !["minder-memory","minder-memory-diff"].includes(message.customType))}));
    const proposeEpisode = (ctx: ExtensionContext) => {
      const id=sessionId(ctx);
      const turns: EpisodeTurn[]=[];
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type!=="message") continue;
        const message=entry.message;
        if (message.role!=="user" && message.role!=="assistant") continue;
        const text=typeof message.content==="string" ? message.content :
          message.content.flatMap(part=>part.type==="text"?[part.text]:[]).join("\n");
        if (text.trim()) turns.push({at:entry.timestamp,role:message.role,text,ref:"pi:" + id + "/" + entry.id});
      }
      return store().proposeEpisode(id,turns);
    };
    const render = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value });
    pi.registerTool({
      name:"minder_memory_search", label:"Search memory", description:"Search reviewed personal Markdown memory.",
      parameters:Type.Object({query:Type.String({minLength:1})}),
      async execute(_id,{query}) { return render(store().search(query)); }
    });
    pi.registerTool({
      name:"minder_memory_propose", label:"Propose memory", description:"Draft a memory change for the owner to review. Use a stable fact key, include source evidence, and supply an ISO expiration for active context.",
      parameters:Type.Object({
        key:Type.String(), layer:Type.Union([Type.Literal("core"),Type.Literal("active"),Type.Literal("episodic")]),
        text:Type.String(), source:Type.String(), expiresAt:Type.Optional(Type.String()),
        operation:Type.Optional(Type.Union([Type.Literal("upsert"),Type.Literal("archive")])),
      }),
      async execute(_id,input,_signal,_update,ctx) {
        const session = store().begin(sessionId(ctx));
        return render(store().propose(session,{...input,intent:"observed"}));
      }
    });
    pi.registerCommand("minder-memory", {
      description:"Review Markdown changes: diff, commit [key], discard [key], show <id>, revert <id>, search <query>, history",
      handler:async(args,ctx) => {
        const [op="diff",...argsList] = args.trim().split(/\s+/u).filter(Boolean);
        const arg = argsList.join(" ");
        const vault = store();
        let value: unknown;
        switch (op) {
          case "diff": value=vault.diff(sessionId(ctx)); break;
          case "commit": value=vault.commit(sessionId(ctx),arg?[arg]:undefined); break;
          case "discard": value=vault.discard(sessionId(ctx),arg || undefined); break;
          case "revert": value=vault.revert(arg); break;
          case "search": value=vault.search(arg); break;
          case "history": value=vault.history(); break;
          case "show": value=vault.show(arg); break;
          default: throw new Error("Use diff, commit [key], discard [key], show <id>, revert <id>, search <query> or history");
        }
        pi.sendMessage({customType:"minder-memory", content:JSON.stringify(value,null,2), display:true});
      }
    });
    pi.on("session_start",(_event,ctx)=>{
      store().expire();
      timer=setInterval(()=>{
        try { store().expire(); }
        catch(error) { ctx.ui.notify(String(error),"error"); }
      },60_000);
      timer.unref();
    });
    pi.on("agent_settled",(event,ctx)=>{
      if (!event.aborted) proposeEpisode(ctx);
      const changes=store().diff(sessionId(ctx));
      if (changes.length) pi.sendMessage({customType:"minder-memory-diff", content:"Memory Diff\n" + JSON.stringify(changes,null,2), display:true});
    });
    pi.on("session_shutdown",(event,ctx)=>{
      if(timer) clearInterval(timer);
      try { if(event.reason==="quit" || event.reason==="new") proposeEpisode(ctx); }
      finally {db?.close();db=undefined;}
    });
  };
}
export default createMemoryExtension();
