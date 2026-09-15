import { editResultMessage } from '../v2/service-guidance.js';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { getMarkdownTheme, getSettingsListTheme } from '@earendil-works/pi-coding-agent';
import { Container, Markdown, SettingsList, Text, matchesKey, truncateToWidth, type Component, type SettingItem } from '@earendil-works/pi-tui';
import { randomUUID } from 'node:crypto';
import { IMPORT_BASES } from '../v2/import.js';
import { nativeFailure, type MemoryHost, type PiMemoryService } from './memory-service.js';

const clean = (text:string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'');
const stateNames: Record<string,string> = {buffered:'等待当前交互结束',pending:'排队中',claimed:'处理中',running:'处理中',retry:'等待重试',paused:'已暂停',dead:'处理失败',quarantined:'已隔离',processed:'已处理',done:'作业已结束（查看回执）'};
const state = (value:string) => stateNames[value] ?? value;

/** Full body remains available by scrolling; this viewport never truncates stored/model material. */
export class MemoryViewer implements Component {
  #offset=0;
  #lastHeight=10;
  constructor(readonly load:()=>string, readonly height:()=>number, readonly keybindings:{matches(data:string,action:'tui.select.cancel'|'tui.select.up'|'tui.select.down'):boolean}, readonly close:()=>void) {}
  handleInput(data:string) {
    if(this.keybindings.matches(data,'tui.select.cancel'))this.close();
    else if(this.keybindings.matches(data,'tui.select.up'))this.#offset=Math.max(0,this.#offset-1);
    else if(this.keybindings.matches(data,'tui.select.down'))this.#offset++;
    else if(matchesKey(data,'pageUp'))this.#offset=Math.max(0,this.#offset-this.#lastHeight);
    else if(matchesKey(data,'pageDown'))this.#offset+=this.#lastHeight;
    else if(matchesKey(data,'home'))this.#offset=0;
    else if(matchesKey(data,'end'))this.#offset=Number.MAX_SAFE_INTEGER;
  }
  render(width:number) {
    let body:string;
    try { body=clean(this.load()); } catch(error) { body=nativeFailure(error).message; }
    const lines=new Markdown(body,0,0,getMarkdownTheme()).render(Math.max(1,width));
    const height=Math.max(1,Math.min(24,this.height()-8));this.#lastHeight=height;
    this.#offset=Math.min(this.#offset,Math.max(0,lines.length-height));
    return [...lines.slice(this.#offset,this.#offset+height),truncateToWidth(`↑↓ / PgUp PgDn 滚动 · Home/End · Esc 返回 · ${this.#offset+1}–${Math.min(this.#offset+height,lines.length)}/${lines.length}`,Math.max(1,width))];
  }
  invalidate() {}
}

/** The same SettingsList building block as Pi /settings, with persistent document subpages. */
async function page(ctx:ExtensionCommandContext,title:string,items:SettingItem[],selected?:string) {
  return ctx.ui.custom<string|undefined>((tui,theme,_kb,done)=>{
    const container=new Container();
    container.addChild(new Text(theme.fg('accent',theme.bold(title)),1,0));
    const list=new SettingsList(items,Math.max(1,Math.min(14,tui.terminal.rows-8)),getSettingsListTheme(),id=>done(id),()=>done(undefined),{enableSearch:true});
    if(selected)list.selectItem(selected);
    container.addChild(list);
    return {render:(w:number)=>container.render(w),invalidate:()=>container.invalidate(),handleInput:(data:string)=>{list.handleInput(data);tui.requestRender();}};
  });
}
const action=(id:string,label:string,description:string):SettingItem=>({id,label,currentValue:'打开 →',values:['打开 →'],description});
async function view(ctx:ExtensionCommandContext,title:string,load:()=>string) {
  await ctx.ui.custom((_tui,_theme,kb,done)=>new MemoryViewer(()=>`# ${title}\n\n${load()}`,()=>_tui.terminal.rows,kb,()=>done(undefined)));
}
async function chooseScope(ctx:ExtensionCommandContext,contexts:{id:string;name:string}[]) {
  return page(ctx,'选择记忆范围',contexts.map(c=>action(c.id,clean(c.name),c.id)));
}
async function processing(ctx:ExtensionCommandContext,host:MemoryHost,service:PiMemoryService,valid:()=>void) {
  let selected:string|undefined;
  for(;;) {
    valid();const status=await service.status(host,{},true);
    if(!('queue' in status))return;
    const summary=[...status.queue.observations.map(r=>`${state(r.state)} ${r.count}`),...status.queue.jobStates.map(r=>`任务${state(r.state)} ${r.count}`)];
    const items:SettingItem[]=[{id:'summary',label:'状态汇总',currentValue:summary.join(' · ') || '暂无请求',description:'汇总覆盖全部当前可见任务；明细最多展示最近/活跃的 20 个。已处理不等于已记住；这里不展示原始对话。'},action('refresh','刷新状态','读取 Core 当前状态，不重复提交材料。')];
    for(const [index,request] of status.recent.entries())items.push(action(`request:${index}`,`${request.importId?'导入':'调整'} ${request.importId ?? request.requestId}`,`${request.outcome.editResult ? editResultMessage(request.outcome.editResult) : state(request.outcome.state)} · ${request.contextId}`));
    for(const job of status.queue.jobs)items.push(action(`job:${job.id}`,`任务 ${job.id.slice(0,8)}`,`${state(job.state)} · 尝试 ${job.attempts}${job.diagnostic?` · ${job.diagnostic.reason}`:''}`));
    selected=await page(ctx,'Common Memory · 处理状态',items,selected);if(!selected)return;
    if(selected==='refresh')continue;
    if(selected.startsWith('request:')) {
      const item=status.recent[Number(selected.slice(8))];if(!item)continue;
      const identity=item.importId?{importId:item.importId}:{requestId:item.requestId!};
      const current=await service.status(host,identity,true);await view(ctx,'请求状态',()=>JSON.stringify(current,null,2));
    } else if(selected.startsWith('job:')) {
      const id=selected.slice(4),job=status.queue.jobs.find(j=>j.id===id);if(!job)continue;
      const fresh=await service.status(host,{},true),current='queue' in fresh?fresh.queue.jobs.find(j=>j.id===id):undefined;if(!current)throw new Error('CONTEXT_UNAVAILABLE');
      await view(ctx,'任务状态',()=>`${state(current.state)}\n\n${JSON.stringify(current,null,2)}\n\n失败任务可由用户确认重试；活动任务可由用户明确取消。`);
      if(['dead','paused'].includes(job.state) && await ctx.ui.confirm('重试任务？','将重新处理原始材料，不更换身份，不修改原文；仍受当前来源与范围权限约束。')) {valid();await service.retry(host,id);ctx.ui.notify('已请求重试；不代表记忆已更新。','info');}
      else if(['running','retry'].includes(job.state)&&await ctx.ui.confirm('取消任务？','这会持久停止该任务；服务重启不会自动恢复。之后只能由用户显式重试。')){valid();await service.cancel(host,id);ctx.ui.notify('任务已取消；原材料和任务身份仍保留。','info');}
    }
  }
}
export async function openMemoryPanel(ctx:ExtensionCommandContext,service:PiMemoryService,refresh:()=>void,flush:()=>void|Promise<void>,valid:()=>void=()=>{}) {
  if(ctx.mode!=='tui') {if(ctx.hasUI)ctx.ui.notify('/memory 页面需要 Pi TUI 模式；可用 memory_read / memory_status。','warning');else throw new Error('/memory requires Pi TUI; use memory_read or memory_status');return;}
  const host={cwd:ctx.cwd,sessionId:ctx.sessionManager.getSessionId()};let selected:string|undefined;
  for(;;) {
    try {
      valid();const info=service.info(host,true);
      const items:SettingItem[]=[];
      const bodies=new Map<string,()=>string>();
      for(const context of info.contexts)for(const document of service.read(host,context.id,true).documents) {
        const title=document.target==='profile'?'Profile':document.target==='preferences'?'Preferences':clean(context.name);
        items.push({id:document.target,label:title,currentValue:document.empty?'空 · 查看 →':'查看 →',description:context.id+' · 仅用户页面展示，不追加到 Agent 上下文。'});
        bodies.set(document.target,()=>{
          const current=service.read(host,context.id,true).documents.find(d=>d.target===document.target);
          if(!current)throw new Error('CONTEXT_UNAVAILABLE');return current.empty?`# ${title}\n\n暂无记忆。`:current.content;
        });
      }
      items.push(action('search','查找记忆','在已授权 Markdown 中按关键词查找；不创建索引，不向模型额外披露。'));
      items.push(action('adjust','调整记忆','用自然语言删除、纠正或补充；Core 验证后落档，不直接编辑 Markdown。'));
      items.push(action('status','处理状态','查看队列、近期调整/导入、失败原因与重试。'));
      items.push(action('permissions','授权范围','查看当前权限。此页面不会扩大披露或写入授权。'));
      items.push(action('import','导入已有材料',info.initEnabled?'用户选择/粘贴现有材料，明确来源并确认提交。':'未授权 agent_observation；请先在 Common Memory 配置中授权。'));
      items.push(action('refresh','刷新 Agent 记忆快照','仅刷新当前会话已授权的 global/当前项目；浏览其他项目不会自动注入。'));
      items.push(action('flush','继续处理','请求后台处理已封批的材料；未封批会话仍按原策略等待，不拆开当前轮次。'));
      selected=await ctx.ui.custom<string|undefined>((tui,theme,kb,done)=>{
        for(const item of items){const load=bodies.get(item.id);if(load)item.submenu=(_value,back)=>new MemoryViewer(load,()=>tui.terminal.rows,kb,()=>back());}
        const container=new Container();container.addChild(new Text(theme.fg('accent',theme.bold('Common Memory')),1,0));
        const list=new SettingsList(items,Math.max(1,Math.min(14,tui.terminal.rows-8)),getSettingsListTheme(),id=>done(id),()=>done(undefined),{enableSearch:true});if(selected)list.selectItem(selected);container.addChild(list);
        return {render:(w:number)=>container.render(w),invalidate:()=>container.invalidate(),handleInput:(data:string)=>{list.handleInput(data);tui.requestRender();}};
      });
      if(!selected)return;
      valid();
      if(selected==='status')await processing(ctx,host,service,valid);
      else if(selected==='search'){
        const query=await ctx.ui.input('查找记忆关键词');if(!query?.trim())continue;
        valid();const matches=service.read(host,undefined,true).documents.filter(d=>d.content.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
        const target=await page(ctx,'查找结果',matches.map(d=>action(d.target,d.target,`包含「${clean(query)}」`)));
        if(target)await view(ctx,'查找结果',()=>{valid();const scope=target.startsWith('project:')?target:'global';return service.read(host,scope,true).documents.find(d=>d.target===target)!.content;});
      }
      else if(selected==='permissions')await view(ctx,'授权与能力',()=>JSON.stringify(service.info(host,true),null,2));
      else if(selected==='refresh'){refresh();ctx.ui.notify('当前 Agent 记忆快照已刷新。','info');}
      else if(selected==='flush'){await flush();ctx.ui.notify('已请求继续处理；请查看处理状态，不代表已记住。','info');}
      else if(selected==='adjust') {
        const scope=await chooseScope(ctx,service.info(host,true).adjustmentContexts);if(!scope)continue;
        const prompt=await ctx.ui.editor('调整记忆：描述删除、纠正或补充（提交后进入 Core 处理）');if(prompt===undefined || !prompt.trim())continue;
        const requestId=randomUUID();
        if(!await ctx.ui.confirm('提交记忆调整？',`范围：${scope}\n将把输入及获授权的记忆发送给配置的维护模型。提交后退出页面不会撤回请求。`))continue;
        valid();const result=await service.adjust(host,scope,prompt,requestId);ctx.ui.notify(`已入队 ${result.requestId}，尚未确认记忆更新。可在处理状态中查看。`,'info');
      } else if(selected==='import') {
        if(!service.info(host,true).initEnabled)throw new Error('INIT_DISABLED');
        const scope=await chooseScope(ctx,service.contexts(host,true));if(!scope)continue;
        const sourceLabel=await ctx.ui.input('来源标签','例如：prior-assistant');if(sourceLabel===undefined)continue;
        const basis=await ctx.ui.select('实际材料来源',[...IMPORT_BASES]);if(basis===undefined)continue;
        const understanding=await ctx.ui.editor('粘贴已有 Agent 整理材料，保留条件、时间、不确定性和来源');if(understanding===undefined)continue;
        const gaps=await ctx.ui.editor('覆盖缺口/限定条件（可留空）');if(gaps===undefined)continue;
        if(!await ctx.ui.confirm('授权导入本次材料？',`范围：${scope}\n来源：${clean(sourceLabel)}\n这些材料将发送给维护模型，始终作为 Agent 报告而非认证用户原话。允许导入不等于认可每条事实。`))continue;
        valid();const result=await service.import(host,{importId:randomUUID(),contextId:scope,sourceLabel,basis:basis as typeof IMPORT_BASES[number],understanding,gaps},undefined,true);
        ctx.ui.notify(`导入已入队 ${result.importId}；请在处理状态核验。`,'info');
      }
    } catch(error) {ctx.ui.notify(nativeFailure(error).message,'error');return;}
  }
}
