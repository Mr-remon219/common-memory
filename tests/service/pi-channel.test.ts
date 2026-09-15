import { describe, expect, it } from 'vitest';
import { PiCaptureRuntime, type PiCapturePort } from '../../src/pi-extension/extraction-runtime.js';

describe('Pi service channel',()=>{
  it('serializes host events and waits for durable acknowledgements on shutdown',async()=>{
    const seen:string[]=[],release: (()=>void)[]=[];
    const port:PiCapturePort={async call<T=unknown>(operation:string){seen.push(operation);await new Promise<void>(resolve=>release.push(resolve));return undefined as T;}};
    const runtime=new PiCaptureRuntime(port);const first=runtime.start('session',[],'/workspace'),second=runtime.input({sessionId:'session',cwd:'/workspace',text:'hello',source:'interactive'});await new Promise<void>(resolve=>setImmediate(resolve));expect(seen).toEqual(['pi.start']);release.shift()!();await first;await new Promise<void>(resolve=>setImmediate(resolve));expect(seen).toEqual(['pi.start','pi.input']);let stopped=false;const shutdown=runtime.shutdown().then(()=>{stopped=true;});await Promise.resolve();expect(stopped).toBe(false);release.shift()!();await second;await shutdown;expect(stopped).toBe(true);
  });
  it('does not turn host lifecycle transitions into service task cancellation',async()=>{
    const seen:string[]=[];const runtime=new PiCaptureRuntime({async call<T=unknown>(operation:string){seen.push(operation);return undefined as T;}});runtime.busy();await runtime.settled('session',[],'interrupted','/workspace');await runtime.end('session','/workspace');await runtime.shutdown();expect(seen).toEqual(['pi.settled','pi.end']);expect(seen).not.toContain('task.cancel');
  });
});
