import { Type } from 'typebox';
import { MEMORY_READ_GUIDANCE, MEMORY_READ_DESCRIPTION } from '../v2/read-guidance.js';
import { launchSessionDrain } from '../cli/session-drain.js';
const snapshots = (globalThis as typeof globalThis & {__commonMemoryPiSnapshots?:Map<string,string>}).__commonMemoryPiSnapshots ??= new Map<string,string>();
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type CommonMemoryConfig } from "../config/config.js";
import { createConfiguredWriter } from "../config/runtime.js";
import { ProjectRegistry } from "../v2/registry.js";
import { readAuthorizedMemory, renderMemoryView } from "../v2/reader.js";
import { PiCaptureRuntime, type SessionUserEntry } from "./extraction-runtime.js";

export function createCommonMemoryPiExtension(options: {runtimeFactory?: () => PiCaptureRuntime; resolveScope?: (cwd:string) => string; configFactory?: () => CommonMemoryConfig | null} = {}) {
  return (pi: ExtensionAPI): void => {
    let runtime: PiCaptureRuntime | undefined;
    let registry: ProjectRegistry | undefined;
    let config: CommonMemoryConfig | undefined;
    // Only a valid configuration is cached; an unconfigured host is re-checked on the next event.
    const cfg = (): CommonMemoryConfig => {
      config ??= (options.configFactory ? options.configFactory() : loadConfig()) ?? undefined;
      if (!config) throw new Error("Common Memory is not configured");
      registry ??= new ProjectRegistry(config.dataRoot);
      return config;
    };
    const get = (): PiCaptureRuntime => {
      if (runtime) return runtime;
      if (options.runtimeFactory) return runtime = options.runtimeFactory();
      // Pi only captures delivered user turns; without permission to disclose them there is nothing to capture.
      const current = cfg();
      if (!current.disclosure.allowedProvenance.includes("user_explicit")) throw new Error("Delivered user evidence is not authorized for disclosure");
      const writer = createConfiguredWriter(current);
      try { runtime = new PiCaptureRuntime(writer,current.sessionCache); }
      catch (error) {
        void writer.close().catch(() => { process.stderr.write('[common-memory] writer cleanup failed.\n'); });
        throw error;
      }
      if(!options.configFactory)launchSessionDrain();
      return runtime;
    };
    const safe = (fn:(r:PiCaptureRuntime)=>void): void => { try { fn(get()); } catch { process.stderr.write("[common-memory] capture unavailable; inspect common-memory status.\n"); } };
    const bind = (ctx:ExtensionContext): void => safe(r=>r.bind(ctx.sessionManager.getSessionId(),branchUsers(ctx.sessionManager.getBranch())));
    const snapshotKey=(ctx:ExtensionContext)=>`${cfg().dataRoot}:${ctx.sessionManager.getSessionId()}`;
    const read=(ctx:ExtensionContext,contextId?:string)=>{
      const current=cfg(),project=registry!.resolve(ctx.cwd);
      const contexts=['global',...(project?[`project:${project.id}`]:[])].filter(scope=>current.disclosure.allowedScopes.includes(scope));
      if(contextId!==undefined&&!contexts.includes(contextId))throw new Error('CONTEXT_UNAVAILABLE');
      return readAuthorizedMemory({dataRoot:current.dataRoot,contexts:contextId?[contextId]:contexts});
    };
    pi.on("session_start", (event,ctx)=>{
      try {const key=snapshotKey(ctx);if(!snapshots.has(key))snapshots.set(key,event.reason==='startup'?renderMemoryView(read(ctx)):'Automatic memory read was not requested for this session lifecycle action. '+MEMORY_READ_GUIDANCE);}catch {process.stderr.write('[common-memory] startup read unavailable.\n');}
      safe(r=>r.start(ctx.sessionManager.getSessionId(),branchUsers(ctx.sessionManager.getBranch())));
    });
    pi.registerTool({name:'memory_read',label:'Read memory',description:MEMORY_READ_DESCRIPTION,promptSnippet:'Read authorized personal and project memory when needed.',promptGuidelines:[MEMORY_READ_GUIDANCE],parameters:Type.Object({contextId:Type.Optional(Type.String({maxLength:160}))}),execute:async(_id,input,_signal,_update,ctx)=>{const view=read(ctx,input.contextId);return {content:[{type:'text',text:renderMemoryView(view)}],details:view};}});
    pi.on("input", (event,ctx)=>{
      safe(r=>{ if(!ctx.hasPendingMessages())r.cancelInputs(ctx.sessionManager.getSessionId()); const project = registry?.resolve(ctx.cwd); const scope = options.resolveScope?.(ctx.cwd) ?? (project ? `project:${project.id}` : "global"); r.input({sessionId:ctx.sessionManager.getSessionId(),text:event.text,source:event.source,scope,parentEntryId:ctx.sessionManager.getLeafId(),hasUnsupportedContent:(event.images?.length??0)>0,...(event.streamingBehavior?{streamingBehavior:event.streamingBehavior}:{})}); });
      return {action:"continue"};
    });
    // Reading is independent of capture: no Writer, model or API key is needed to disclose current memory.
    pi.on("before_agent_start", (event,ctx)=>{
      try {
        const key=snapshotKey(ctx);
        // Freeze only our appended block; the host owns the current base system prompt.
        if(!snapshots.has(key))snapshots.set(key,renderMemoryView(read(ctx)));
        return {systemPrompt:`${event.systemPrompt}\n\n## Common Memory\n${snapshots.get(key)}\n\n${MEMORY_READ_GUIDANCE}`};
      } catch { process.stderr.write("[common-memory] memory unavailable for this turn; inspect common-memory status.\n"); return undefined; }
    });
    pi.on("agent_start", ()=>safe(r=>r.busy()));
    pi.on("message_end", (event,ctx)=>{
      if (event.message.role !== "user") {
        const sessionId=ctx.sessionManager.getSessionId();
        setImmediate(()=>{if(runtime&&ctx.sessionManager.getSessionId()===sessionId)safe(r=>{r.bind(sessionId,branchUsers(ctx.sessionManager.getBranch()));r.context(sessionId,branchContext(ctx.sessionManager.getBranch()));});});
        return;
      }
      const text = messageText(event.message.content); if (!text) return;
      const unsupported=hasNonTextContent(event.message.content);
      safe(r=>r.delivered(ctx.sessionManager.getSessionId(),text,event.message.timestamp,unsupported));
      // Pi appends its stable entry after this callback, so binding is deliberately deferred.
      const sessionId=ctx.sessionManager.getSessionId();
      setImmediate(()=>{ if(runtime && ctx.sessionManager.getSessionId()===sessionId) bind(ctx); });
    });
    pi.on("agent_settled", (_event,ctx)=>safe(r=>{r.bind(ctx.sessionManager.getSessionId(),branchUsers(ctx.sessionManager.getBranch()));r.context(ctx.sessionManager.getSessionId(),branchContext(ctx.sessionManager.getBranch()));r.settled(ctx.sessionManager.getSessionId(),branchUsers(ctx.sessionManager.getBranch()),branchInterrupted(ctx.sessionManager.getBranch())?'interrupted':'settled');}));
    pi.on("session_before_switch", (_event,ctx)=>{bind(ctx);safe(r=>{r.cancelInputs(ctx.sessionManager.getSessionId());});});
    pi.on("session_before_compact", (_event,ctx)=>{bind(ctx);});
    pi.on("session_before_tree", (_event,ctx)=>{bind(ctx);safe(r=>{r.cancelInputs(ctx.sessionManager.getSessionId());});});
    pi.on("session_shutdown", async (event,ctx)=>{ if(event.reason==='quit'){try{snapshots.delete(snapshotKey(ctx));}catch{/* unconfigured */}} if(runtime){try { bind(ctx);runtime.context(ctx.sessionManager.getSessionId(),branchContext(ctx.sessionManager.getBranch()));runtime.cancelInputs(ctx.sessionManager.getSessionId());if(event.reason==='quit'){runtime.end(ctx.sessionManager.getSessionId());launchSessionDrain();} } finally { try { await runtime.shutdown(); } finally { runtime=undefined;config=undefined;registry=undefined; } }} });
    pi.registerCommand("memory-refresh",{description:"Replace the frozen Common Memory snapshot",handler:async (_args,ctx)=>{config=undefined;registry=undefined;const body=renderMemoryView(read(ctx));snapshots.set(snapshotKey(ctx),body);}});
    pi.registerCommand("memory-flush",{description:"Queue Common Memory maintenance",handler:async (_args,ctx)=>{bind(ctx);safe(r=>r.flush());}});
  };
}
export function branchUsers(entries:readonly unknown[]):SessionUserEntry[] {
  return entries.flatMap((value,sequence)=>{
    if (!value || typeof value !== "object") return [];
    const entry=value as Record<string,unknown>; const message=entry.message as Record<string,unknown> | undefined;
    if(entry.type!=="message" || typeof entry.id!=="string" || message?.role!=="user" || typeof message.timestamp!=="number") return [];
    const text=messageText(message.content); return text ? [{id:entry.id,text,timestamp:message.timestamp,sequence}] : [];
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

export function branchContext(entries:readonly unknown[]):{sequence:number;id:string;role:'assistant'|'tool';text:string;timestamp:number}[] {
  return entries.flatMap((value,sequence)=>{if(!value||typeof value!=='object')return [];const e=value as Record<string,unknown>,m=e.message as Record<string,unknown>|undefined;if(e.type!=='message'||typeof e.id!=='string'||!m||!['assistant','toolResult'].includes(String(m.role))||typeof m.timestamp!=='number')return [];const text=messageText(m.content);return text?[{sequence,id:e.id,role:m.role==='assistant'?'assistant' as const:'tool' as const,text,timestamp:m.timestamp}]:[];});
}

function branchInterrupted(entries:readonly unknown[]):boolean {
  for(const value of [...entries].reverse()){if(!value||typeof value!=='object')continue;const m=(value as {message?:{role?:string;stopReason?:string}}).message;if(m?.role==='assistant')return m.stopReason==='aborted'||m.stopReason==='error';}return false;
}
