import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config/config.js";
import { createConfiguredWriter } from "../config/runtime.js";
import { ProjectRegistry } from "../v2/registry.js";
import { PiCaptureRuntime, type SessionUserEntry } from "./extraction-runtime.js";

export function createCommonMemoryPiExtension(options: {runtimeFactory?: () => PiCaptureRuntime; resolveScope?: (cwd:string) => string} = {}) {
  return (pi: ExtensionAPI): void => {
    let runtime: PiCaptureRuntime | undefined;
    let registry: ProjectRegistry | undefined;
    const get = (): PiCaptureRuntime => {
      if (runtime) return runtime;
      if (options.runtimeFactory) return runtime = options.runtimeFactory();
      const config = loadConfig(); if (!config) throw new Error("Common Memory is not configured");
      registry = new ProjectRegistry(config.dataRoot);
      return runtime = new PiCaptureRuntime(createConfiguredWriter(config));
    };
    const safe = (fn:(r:PiCaptureRuntime)=>void): void => { try { fn(get()); } catch { process.stderr.write("[common-memory] capture unavailable; inspect common-memory status.\n"); } };
    const bind = (ctx:ExtensionContext): void => safe(r=>r.bind(ctx.sessionManager.getSessionId(),branchUsers(ctx.sessionManager.getBranch())));
    pi.on("session_start", (_event,ctx)=>safe(r=>r.start(ctx.sessionManager.getSessionId(),branchUsers(ctx.sessionManager.getBranch()))));
    pi.on("input", (event,ctx)=>{
      safe(r=>{ if(!ctx.hasPendingMessages())r.cancelInputs(ctx.sessionManager.getSessionId()); const project = registry?.resolve(ctx.cwd); const scope = options.resolveScope?.(ctx.cwd) ?? (project ? `project:${project.id}` : "global"); r.input({sessionId:ctx.sessionManager.getSessionId(),text:event.text,source:event.source,scope,parentEntryId:ctx.sessionManager.getLeafId(),hasUnsupportedContent:(event.images?.length??0)>0,...(event.streamingBehavior?{streamingBehavior:event.streamingBehavior}:{})}); });
      return {action:"continue"};
    });
    pi.on("agent_start", ()=>safe(r=>r.busy()));
    pi.on("message_end", (event,ctx)=>{
      if (event.message.role !== "user") return;
      const text = messageText(event.message.content); if (!text) return;
      const unsupported=hasNonTextContent(event.message.content);
      safe(r=>r.delivered(ctx.sessionManager.getSessionId(),text,event.message.timestamp,unsupported));
      // Pi appends its stable entry after this callback, so binding is deliberately deferred.
      const sessionId=ctx.sessionManager.getSessionId();
      setImmediate(()=>{ if(runtime && ctx.sessionManager.getSessionId()===sessionId) bind(ctx); });
    });
    pi.on("agent_settled", (_event,ctx)=>safe(r=>r.settled(ctx.sessionManager.getSessionId(),branchUsers(ctx.sessionManager.getBranch()))));
    pi.on("session_before_switch", (_event,ctx)=>{bind(ctx);safe(r=>{r.cancelInputs(ctx.sessionManager.getSessionId());r.flush();});});
    pi.on("session_before_compact", (_event,ctx)=>{bind(ctx);safe(r=>r.flush());});
    pi.on("session_before_tree", (_event,ctx)=>{bind(ctx);safe(r=>{r.cancelInputs(ctx.sessionManager.getSessionId());r.flush();});});
    pi.on("session_shutdown", (_event,ctx)=>{ if(runtime){bind(ctx);runtime.cancelInputs(ctx.sessionManager.getSessionId());runtime.shutdown();runtime=undefined;} });
    pi.registerCommand("memory-flush",{description:"Queue Common Memory maintenance",handler:async (_args,ctx)=>{bind(ctx);safe(r=>r.flush());}});
  };
}
export function branchUsers(entries:readonly unknown[]):SessionUserEntry[] {
  return entries.flatMap(value=>{
    if (!value || typeof value !== "object") return [];
    const entry=value as Record<string,unknown>; const message=entry.message as Record<string,unknown> | undefined;
    if(entry.type!=="message" || typeof entry.id!=="string" || message?.role!=="user" || typeof message.timestamp!=="number") return [];
    const text=messageText(message.content); return text ? [{id:entry.id,text,timestamp:message.timestamp}] : [];
  });
}
function messageText(content:unknown):string {
  if(typeof content==="string") return content;
  if(!Array.isArray(content)) return "";
  const text=content.flatMap(part=>part && typeof part==="object" && part.type==="text" && typeof part.text==="string"?[part.text]:[]).join("\n");
  return text || (hasNonTextContent(content)?"[unsupported non-text user content]":"");
}
function hasNonTextContent(content:unknown):boolean { return typeof content!=="string" && (!Array.isArray(content) || content.some(part=>!part || typeof part!=="object" || part.type!=="text" || typeof part.text!=="string")); }
export default createCommonMemoryPiExtension();
