import type { ApprovedModelRequest, MemoryModelResult } from '../contracts/model-port.js';
import { decodeResponsesEnvelope } from './response-decoder.js';
import { RemoteHttpMemoryModel, type RemoteHttpOptions } from './remote-http.js';
import { validateRemoteTuning, type ReasoningEffort } from './options.js';
export { normalizeOpenAICompatibleBaseUrl } from './remote-http.js';
export interface OpenAIResponsesMemoryModelOptions extends RemoteHttpOptions { reasoningEffort?: ReasoningEffort }
export class OpenAIResponsesMemoryModel extends RemoteHttpMemoryModel {
  readonly #reasoningEffort: ReasoningEffort | undefined;
  constructor(options: OpenAIResponsesMemoryModelOptions) { super(options, 'responses'); this.#reasoningEffort = validateRemoteTuning(options, 'responses').reasoningEffort; }
  protected serialize(request: ApprovedModelRequest): string {
    return JSON.stringify({model:this.model,store:false,...(this.#reasoningEffort === undefined ? {} : {reasoning:{effort:this.#reasoningEffort}}),max_output_tokens:this.maxOutputTokens,input:[{role:'system',content:[{type:'input_text',text:request.prompt}]},{role:'user',content:[{type:'input_text',text:JSON.stringify(request.projection)}]}],text:{format:{type:'json_schema',name:request.schemaName ?? 'memory_maintenance_v2',strict:true,schema:request.schema}}});
  }
  protected decode(envelope: unknown, fingerprintKey: string): MemoryModelResult { return decodeResponsesEnvelope(envelope, fingerprintKey); }
}
export function createOpenAIResponsesMemoryModel(options: OpenAIResponsesMemoryModelOptions): OpenAIResponsesMemoryModel { return new OpenAIResponsesMemoryModel(options); }
