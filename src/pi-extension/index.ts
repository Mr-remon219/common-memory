import { piDiagnosticReporter } from './diagnostics.js';
import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import { IMPORT_BASES, IMPORT_LABEL_PATTERN } from '../v2/import.js';
import { PiMemoryService, nativeFailure } from './memory-service.js';
import { MEMORY_READ_GUIDANCE, MEMORY_READ_DESCRIPTION, MEMORY_READ_REPLACEMENT_GUIDANCE } from '../v2/read-guidance.js';
import { launchSessionDrain } from '../cli/session-drain.js';
const snapshots = (globalThis as typeof globalThis & {__commonMemoryPiSnapshots?:Map<string,MemoryView|string>}).__commonMemoryPiSnapshots ??= new Map<string,MemoryView|string>();
const NO_AUTO_READ = 'Automatic memory read was not requested for this session lifecycle action. '+MEMORY_READ_GUIDANCE;
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type CommonMemoryConfig } from "../config/config.js";
import { createConfiguredWriter } from "../config/runtime.js";
import { ProjectRegistry } from "../v2/registry.js";
import { renderMemoryView, type MemoryView } from "../v2/reader.js";
import { PiCaptureRuntime, type SessionUserEntry } from "./extraction-runtime.js";

export function createCommonMemoryPiExtension(options: {runtimeFactory?: () => PiCaptureRuntime; resolveScope?: (cwd:string) => string; configFactory?: () => CommonMemoryConfig | null} = {}) {
  return (pi: ExtensionAPI): void => {
    const report=piDiagnosticReporter();
    let runtime: PiCaptureRuntime | undefined;
    let registry: ProjectRegistry | undefined;
    let config: CommonMemoryConfig | undefined;
    // Only a valid configuration is cached; an unconfigured host is re-checked on the next event.
    const cfg = (): CommonMemoryConfig => {
      config ??= (options.configFactory ? options.configFactory() : loadConfig()) ?? undefined;
      if (!config) throw new Error("NOT_CONFIGURED");
      registry ??= new ProjectRegistry(config.dataRoot);
      return config;
    };
    const get = (): PiCaptureRuntime => {
      if (runtime) return runtime;
      if (options.runtimeFactory) return runtime = options.runtimeFactory();
      // Pi only captures delivered user turns; without permission to disclose them there is nothing to capture.
      const current = cfg();
      if (!current.disclosure.allowedProvenance.includes("user_explicit")) throw new Error("CAPTURE_NOT_AUTHORIZED");
      const writer = createConfiguredWriter(current);
      try { runtime = new PiCaptureRuntime(writer,current.sessionCache); }
      catch (error) {
        void writer.close().catch(() => { process.stderr.write('[common-memory] writer cleanup failed.\n'); });
        throw error;
      }
      if(!options.configFactory)launchSessionDrain();
      return runtime;
    };
    const safe = (fn:(r:PiCaptureRuntime)=>void): void => { try { fn(get()); } catch (error) { report("capture",error); } };
    const bind = (ctx:ExtensionContext): void => safe(r=>r.bind(ctx.sessionManager.getSessionId(),branchUsers(ctx.sessionManager.getBranch())));
    const freshConfig=()=>{const current=options.configFactory?options.configFactory():loadConfig();if(!current)throw new Error('NOT_CONFIGURED');return current;};
    const host=(ctx:ExtensionContext)=>({cwd:ctx.cwd,sessionId:ctx.sessionManager.getSessionId()});
    const service=new PiMemoryService({config:freshConfig,activeStore:()=>runtime&&config?{dataRoot:config.dataRoot,store:runtime.ingress.store}:undefined,wake:()=>{runtime?.flush();if(!options.configFactory)launchSessionDrain();}});
    const snapshotKey=(ctx:ExtensionContext)=>`${freshConfig().dataRoot}:${ctx.sessionManager.getSessionId()}`;
    const read=(ctx:ExtensionContext,contextId?:string)=>service.read(host(ctx),contextId);
    const frozen=(ctx:ExtensionContext)=>{
      const key=snapshotKey(ctx),value=snapshots.get(key);
      // Old string caches cannot be safely permission-filtered after a hot upgrade.
      if(!value || typeof value==='string')return NO_AUTO_READ;
      const allowed=new Set(service.contexts(host(ctx)).map(c=>c.id));
      const documents=value.documents.filter(d=>allowed.has(d.target.startsWith('project:')?d.target:'global'));
      const view={contexts:value.contexts.filter(c=>allowed.has(c)),documents,empty:documents.every(d=>d.empty)};
      snapshots.set(key,view);return renderMemoryView(view);
    };
    let feedbackTimer:ReturnType<typeof setInterval>|undefined;
    let uiContext:ExtensionContext|undefined;
    let feedbackGeneration=0;
    const notified=new Set<string>();
    const updateFeedback=()=>{
      const ctx=uiContext;if(!ctx?.hasUI)return;
      try {
        const status=service.status(host(ctx));if(!('queue' in status))return;
        const count=(states:string[])=>status.queue.observations.filter(r=>states.includes(r.state)).reduce((n,r)=>n+r.count,0);
        const waiting=count(['buffered','pending','claimed']),failed=count(['dead','quarantined']);
        ctx.ui.setStatus('common-memory',`Memory · ${waiting?`等待/处理 ${waiting}`:'就绪'}${failed?` · 需检查 ${failed}`:''} · /memory`);
        for(const job of status.queue.jobs)if(job.state==='dead'&&!notified.has(job.id)&&notified.size<20){notified.add(job.id);ctx.ui.notify('Common Memory 有任务处理失败；材料仍保留。打开 /memory → 处理状态查看与重试。','warning');}
      } catch(error) {ctx.ui.setStatus('common-memory','Memory · 不可用 · /memory');}
    };
    const refresh=(ctx:ExtensionContext)=>{snapshots.set(snapshotKey(ctx),read(ctx));};
    pi.on("session_start", (event,ctx)=>{
      try {const key=snapshotKey(ctx);if(!snapshots.has(key))snapshots.set(key,event.reason==='startup'?read(ctx):NO_AUTO_READ);}catch {process.stderr.write('[common-memory] startup read unavailable.\n');}
      safe(r=>r.start(ctx.sessionManager.getSessionId(),branchUsers(ctx.sessionManager.getBranch())));
      feedbackGeneration++;uiContext=ctx;if(feedbackTimer)clearInterval(feedbackTimer);
      if(ctx.hasUI){updateFeedback();feedbackTimer=setInterval(updateFeedback,2000);feedbackTimer.unref();}
    });
    pi.registerTool({name:'memory_read',label:'Read memory',description:MEMORY_READ_DESCRIPTION,promptSnippet:'Read authorized personal and project memory when needed.',promptGuidelines:[MEMORY_READ_GUIDANCE],parameters:Type.Object({contextId:Type.Optional(Type.String({maxLength:160}))}),execute:async(_id,input,_signal,_update,ctx)=>{try{const view=read(ctx,input.contextId);return {content:[{type:'text',text:`${MEMORY_READ_REPLACEMENT_GUIDANCE}\n\n${renderMemoryView(view)}`}],details:view};}catch(error){throw nativeFailure(error);}}});
    pi.on("input", (event,ctx)=>{
      safe(r=>{ if(!ctx.hasPendingMessages())r.cancelInputs(ctx.sessionManager.getSessionId()); const project = registry?.resolve(ctx.cwd); const scope = options.resolveScope?.(ctx.cwd) ?? (project ? `project:${project.id}` : "global"); r.input({sessionId:ctx.sessionManager.getSessionId(),text:event.text,source:event.source,scope,parentEntryId:ctx.sessionManager.getLeafId(),hasUnsupportedContent:(event.images?.length??0)>0,...(event.streamingBehavior?{streamingBehavior:event.streamingBehavior}:{})}); });
      return {action:"continue"};
    });
    // Reading is independent of capture: no Writer, model or API key is needed to disclose current memory.
    pi.on("before_agent_start", (event,ctx)=>{
      try {
        const key=snapshotKey(ctx);
        // Freeze only our appended block; the host owns the current base system prompt.
        if(!snapshots.has(key))snapshots.set(key,read(ctx));
        return {systemPrompt:`${event.systemPrompt}\n\n## Common Memory\n${frozen(ctx)}\n\n${MEMORY_READ_GUIDANCE}`};
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
    pi.on("session_shutdown", async (event,ctx)=>{ feedbackGeneration++;if(feedbackTimer)clearInterval(feedbackTimer);feedbackTimer=undefined;uiContext=undefined;if(ctx.hasUI)ctx.ui.setStatus('common-memory',undefined); if(event.reason==='quit'){try{snapshots.delete(snapshotKey(ctx));}catch{/* unconfigured */}} if(runtime){try { bind(ctx);runtime.context(ctx.sessionManager.getSessionId(),branchContext(ctx.sessionManager.getBranch()));runtime.cancelInputs(ctx.sessionManager.getSessionId());if(event.reason==='quit'){runtime.end(ctx.sessionManager.getSessionId());launchSessionDrain();} } finally { try { await runtime.shutdown(); } finally { runtime=undefined;config=undefined;registry=undefined; } }} });
    pi.registerCommand("memory-refresh",{description:"Replace the frozen Common Memory snapshot",handler:async (_args,ctx)=>{refresh(ctx);if(ctx.hasUI)ctx.ui.notify('Common Memory 快照已刷新。','info');}});
    pi.registerCommand("memory-flush",{description:"Queue Common Memory maintenance",handler:async (_args,ctx)=>{if(runtime)bind(ctx);service.flush();updateFeedback();}});
    pi.registerCommand('memory',{description:'Open Common Memory: browse, adjust, import and processing status',handler:async(_args,ctx)=>{
      const {openMemoryPanel}=await import('./memory-ui.js');
      const generation=feedbackGeneration;
      await openMemoryPanel(ctx,service,()=>refresh(ctx),()=>{if(runtime)bind(ctx);service.flush();},()=>{if(generation!==feedbackGeneration)throw new Error('CANCELLED');});updateFeedback();
    }});
    pi.registerTool({name:'memory_status',label:'Memory status',description:'Discover current authorized scopes and capabilities, inspect body-free queue state, or check an original importId/requestId in this Pi session. Automatic capture already submits user turns: do not duplicate them. Processed is not proof of retention. Follow next; prefer /memory for interactive recovery, not repeated polling.',promptSnippet:'Check memory permissions, processing and recovery.',parameters:Type.Object({importId:Type.Optional(Type.String({pattern:'^[A-Za-z0-9_-]{1,128}$'})),requestId:Type.Optional(Type.String({pattern:'^[A-Za-z0-9_-]{1,128}$'}))}),execute:async(_id,input,_signal,_update,ctx)=>{
      try {const value=service.status(host(ctx),input);return {content:[{type:'text',text:JSON.stringify(value)}],details:value};}catch(error){throw nativeFailure(error);}
    }});
    pi.registerTool({name:'memory_init',label:'Import memory material',description:'Only when the user explicitly requests importing existing material. Preserve sources, dates, conditions, uncertainty and gaps; do not preselect long-term value or submit this session\'s execution status. Material stays agent-reported, never authenticated user speech. Requires configured agent_observation authorization AND native user confirmation of this payload. Keep importId and payload unchanged on retry. Accepted means queued, not remembered. Never duplicate automatically captured user turns.',parameters:Type.Object({importId:Type.String({pattern:'^[A-Za-z0-9_-]{1,128}$'}),contextId:Type.String({maxLength:160}),sourceLabel:Type.String({pattern:IMPORT_LABEL_PATTERN.source}),basis:StringEnum([...IMPORT_BASES]),understanding:Type.String({minLength:1}),gaps:Type.Optional(Type.String())}),execute:async(_id,input,signal,_update,ctx)=>{
      const generation=feedbackGeneration;
      try {
        if(!ctx.hasUI)throw new Error('IMPORT_CONFIRMATION_REQUIRED');
        const info=service.info(host(ctx));if(!info.initEnabled)throw new Error('INIT_DISABLED');
        if(!info.contexts.some(c=>c.id===input.contextId))throw new Error('CONTEXT_UNAVAILABLE');
        signal?.throwIfAborted();
        const payload=structuredClone(input);
        const approved=await ctx.ui.confirm('Common Memory：授权导入这些材料？',JSON.stringify(payload,null,2),{...(signal?{signal}:{})});
        if(!approved || signal?.aborted || generation!==feedbackGeneration)throw new Error('CANCELLED');
        const result=service.import(host(ctx),payload,signal);updateFeedback();return {content:[{type:'text',text:JSON.stringify(result)}],details:result};
      }catch(error){throw nativeFailure(error);}
    }});
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
