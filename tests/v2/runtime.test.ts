import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeStore } from "../../src/v2/runtime.js";

const roots:string[]=[];const stores:RuntimeStore[]=[];
function setup(options:ConstructorParameters<typeof RuntimeStore>[1]={}) {const root=mkdtempSync(join(tmpdir(),"cm-v2-"));roots.push(root);const store=new RuntimeStore(root,options);stores.push(store);return {store,root};}
function add(store:RuntimeStore,n:number,text="用户当前状态") {return store.enqueue({sessionId:"s",entryId:String(n),text,scope:"global",source:"interactive",observedAt:"2026-01-01T00:00:00Z"});}
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
describe("durable V2 runtime",()=>{
  it("hybrid count, idle, bytes and oldest wait; no empty calls",()=>{
    let now=0;const {store}=setup({now:()=>now});expect(store.claim({force:true})).toBeNull();add(store,1);expect(store.claim()).toBeNull();now=120000;let job=store.claim()!;expect(job.observations).toHaveLength(1);store.finish(job);
    for(let n=2;n<=7;n++)add(store,n);job=store.claim()!;expect(job.observations).toHaveLength(6);store.finish(job);
    add(store,8,"x".repeat(16384));job=store.claim()!;store.finish(job);
    add(store,9);now+=599999;add(store,10);expect(store.claim()).toBeNull();now++;expect(store.claim()!.observations).toHaveLength(2);
  });
  it("fences expired owners across connections and freezes batches",()=>{
    let now=0;const {store,root}=setup({now:()=>now});const second=new RuntimeStore(root,{now:()=>now});stores.push(second);add(store,1);const old=store.claim({force:true})!;add(store,2);expect(second.claim({force:true})).toBeNull();now=120000;const fresh=second.claim({force:true})!;expect(fresh.generation).toBe(2);expect(fresh.observations.map(o=>o.id)).toEqual(old.observations.map(o=>o.id));expect(()=>store.finish(old)).toThrow("STALE_LEASE");second.finish(fresh);expect(second.pending()).toHaveLength(1);
  });
  it("recovers permanent receipts idempotently and purges forgotten processed bodies",()=>{
    const {store}=setup();const observation=add(store,1);const job=store.claim({force:true})!;const receipt={jobId:job.id,observationIds:[observation.id],associations:[{target:"profile:s1",sourceIds:[observation.id]}]};store.recoverReceipt(receipt);store.recoverReceipt(receipt);expect(store.pending()).toHaveLength(0);expect(store.sources("profile:s1")).toEqual([observation.id]);const forget=add(store,2);const next=store.claim({force:true})!;store.finish(next,{jobId:next.id,observationIds:[forget.id],forgetSourceIds:[observation.id]});expect(store.db.prepare("SELECT text FROM observations WHERE id=?").get(observation.id)!.text).toBeNull();expect(store.sources("profile:s1")).toEqual([observation.id]);expect(add(store,1).state).toBe("processed");
  });
  it("actual delivery orders steer before queued follow-up and keeps assistant-independent evidence",()=>{
    const {store}=setup();store.stageInput({sessionId:"s",text:"follow",scope:"global",source:"interactive",streamingBehavior:"followUp"});store.stageInput({sessionId:"s",text:"steer",scope:"global",source:"interactive",streamingBehavior:"steer"});store.delivered("s","steer",10);store.delivered("s","follow",11);expect(store.pending()).toHaveLength(0);store.bind("s",[{id:"f",text:"follow",timestamp:11},{id:"s",text:"steer",timestamp:10}]);expect(store.pending().map(o=>o.text)).toEqual(["steer","follow"]);store.bind("s",[{id:"s",text:"steer",timestamp:10}]);expect(store.pending()).toHaveLength(2);
  });
  it("quarantines ambiguous and extension-originated input without blocking FIFO",()=>{
    const {store}=setup();for(let i=0;i<2;i++)store.stageInput({sessionId:"s",text:"same",scope:"global",source:"interactive"});store.delivered("s","same",10);store.bind("s",[{id:"a",text:"same",timestamp:10}]);expect(store.pending()).toEqual([]);expect(store.status().observations).toContainEqual({state:"quarantined",count:1});add(store,3);expect(store.claim({force:true})!.observations).toHaveLength(1);
  });
  it("retries with backoff, dead letters and explicitly requeues",()=>{
    let now=0;const {store}=setup({now:()=>now,maxAttempts:2});add(store,1);let job=store.claim({force:true})!;store.fail(job,new Error("do not persist raw text"));expect(store.claim({force:true})).toBeNull();now=1000;job=store.claim({force:true})!;store.fail(job,new Error());expect(store.status().jobs[0]!.state).toBe("dead");store.retry(job.id);expect(store.claim({force:true})).not.toBeNull();
  });
  it("trim preserves whole turns and quarantining doesn't mark them processed",()=>{
    const {store}=setup();add(store,1);add(store,2);let job=store.claim({force:true})!;job=store.trim(job,1);expect(store.pending()).toHaveLength(1);store.quarantine(job,job.observations[0]!.id,"oversized");expect(store.pending()).toHaveLength(1);expect(store.status().observations).toContainEqual({state:"quarantined",count:1});
  });
  it("rolls back no-op consumption if transaction fails",()=>{const {store}=setup();add(store,1);const job=store.claim({force:true})!;expect(()=>store.transaction(()=>{store.finish(job);throw new Error("crash");})).toThrow();store.assertLease(job);});
  it("deduplicates delivered events after binding and purges capture plaintext",()=>{
    const {store}=setup();store.stageInput({sessionId:"s",text:"secret old state",source:"interactive",scope:"global"});store.delivered("s","secret old state",1);store.bind("s",[{id:"one",text:"secret old state",timestamp:1}]);
    store.stageInput({sessionId:"s",text:"secret old state",source:"interactive",scope:"global"});store.delivered("s","secret old state",1);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM inputs").get()!.n).toBe(1);
    expect(store.db.prepare("SELECT text FROM deliveries").get()!.text).toBe("");store.cancelInputs("s");expect(store.db.prepare("SELECT COUNT(*) AS n FROM inputs").get()!.n).toBe(0);
  });
  it("reports ambiguous stable entries visibly",()=>{const {store}=setup();store.delivered("s","text",1);store.bind("s",[{id:"a",text:"text",timestamp:1},{id:"b",text:"text",timestamp:1}]);expect(store.status().quarantinedDeliveries).toBe(1);});
  it("rejects runtime sidecar symlinks and hardlinked databases",()=>{
    const root=mkdtempSync(join(tmpdir(),"cm-v2-"));roots.push(root);writeFileSync(join(root,"target"),"");symlinkSync(join(root,"target"),join(root,"runtime.sqlite-wal"));expect(()=>new RuntimeStore(root)).toThrow("Unsafe runtime path");rmSync(join(root,"runtime.sqlite-wal"));linkSync(join(root,"target"),join(root,"runtime.sqlite"));expect(()=>new RuntimeStore(root)).toThrow("Unsafe runtime path");
  });
  it("replacement associations carry explicit old sources but remove stale target keys",()=>{const {store}=setup();const a=add(store,1),job=store.claim({force:true})!;store.finish(job,{jobId:job.id,observationIds:[a.id],associations:[{target:"old",sourceIds:[a.id]}]});const b=add(store,2),next=store.claim({force:true})!;store.finish(next,{jobId:next.id,observationIds:[b.id],removeTargets:["old"],associations:[{target:"new",sourceIds:[a.id,b.id]}]});expect(store.sources("old")).toEqual([]);expect(store.sources("new")).toEqual([a.id,b.id]);});

  it("persistent flush drains a below-threshold tail without waiting idle",()=>{const {store}=setup();for(let n=0;n<7;n++)add(store,n);store.requestFlush();const first=store.claim()!;expect(first.observations).toHaveLength(6);store.finish(first);const tail=store.claim()!;expect(tail.observations).toHaveLength(1);store.finish(tail);expect(store.claim()).toBeNull();});

});
