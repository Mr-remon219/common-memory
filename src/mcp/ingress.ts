import { isAbsolute } from 'node:path';
import type { CommonMemoryConfig } from '../config/config.js';
import { RuntimeStore } from '../v2/runtime.js';
import { ProjectRegistry } from '../v2/registry.js';
import { AGENT_IMPORT_SOURCE, encodeAgentImport, type AgentImportPayload } from '../v2/import.js';
import { readAuthorizedMemory, type MemoryView } from '../v2/reader.js';

export type McpCapability = 'relay' | 'init' | 'read';
export const MCP_CAPABILITIES: readonly McpCapability[] = ['relay', 'init', 'read'];
export interface McpOptions { clientId: string; workspaces: string[]; global: boolean; accept: boolean; capabilities: McpCapability[] }
export interface SubmissionIdentity { submissionId: string; conversationId?: string | undefined }
export interface Submission extends SubmissionIdentity { contextId: string; text: string }
export interface InitSubmission extends AgentImportPayload { importId: string; contextId: string }
export type SubmissionOutcome = import("../v2/runtime.js").ObservationOutcome;
const validId = (id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id);

/** Local host trust is established at launch, never by a tool argument. */
export class McpIngress {
  readonly #registry: ProjectRegistry;
  readonly #projects: { workspace: string; contextId: string }[];
  readonly #options: McpOptions;
  /** Read-only launches never open the runtime database. */
  constructor(readonly store: RuntimeStore | null, readonly config: CommonMemoryConfig, options: McpOptions) {
    if (!validId(options.clientId)) throw new Error('INVALID_CLIENT_ID');
    if (!options.capabilities.length || options.capabilities.some(c => !MCP_CAPABILITIES.includes(c))) throw new Error('INVALID_CAPABILITY');
    if (!store && options.capabilities.some(c => c !== 'read')) throw new Error('STORE_REQUIRED');
    this.#options = { ...options, workspaces: [...options.workspaces], capabilities: [...new Set(options.capabilities)] };
    this.#registry = new ProjectRegistry(config.dataRoot);
    this.#projects = options.workspaces.map(workspace => {
      if (!isAbsolute(workspace)) throw new Error('WORKSPACE_MUST_BE_ABSOLUTE');
      const project = this.#registry.resolve(workspace);
      if (!project) throw new Error('UNREGISTERED_WORKSPACE');
      return { workspace, contextId: `project:${project.id}` };
    });
  }
  get capabilities(): readonly McpCapability[] { return this.#options.capabilities; }
  has(capability: McpCapability): boolean { return this.#options.capabilities.includes(capability); }
  contexts(): string[] {
    const projects = this.#projects.filter(item => {
      try { return `project:${this.#registry.resolve(item.workspace)?.id}` === item.contextId; }
      catch { return false; }
    }).map(item => item.contextId);
    return [...new Set([...(this.#options.global ? ['global'] : []), ...projects])]
      .filter(scope => this.config.disclosure.allowedScopes.includes(scope));
  }
  info(): { capabilities: McpCapability[]; submissionEnabled: boolean; initEnabled: boolean; readEnabled: boolean; contexts: string[] } {
    const contexts = this.contexts();
    const userExplicit = this.config.disclosure.allowedProvenance.includes('user_explicit');
    return {
      capabilities: [...this.#options.capabilities],
      submissionEnabled: this.has('relay') && this.#options.accept && userExplicit && contexts.length > 0,
      // Init needs the launch capability and the configured permission to disclose agent-reported material remotely.
      initEnabled: this.has('init') && this.config.disclosure.allowedProvenance.includes('agent_observation') && contexts.length > 0,
      readEnabled: this.has('read') && contexts.length > 0,
      contexts,
    };
  }
  /** Read-only launches have no queue: item status is not part of their profile, not a backend failure. */
  #store(): RuntimeStore { if (!this.store) throw new Error('STATUS_UNAVAILABLE'); return this.store; }
  #session(input: SubmissionIdentity): string {
    if (!validId(input.submissionId) || (input.conversationId !== undefined && !validId(input.conversationId))) throw new Error('INVALID_SUBMISSION_ID');
    return `mcp:${JSON.stringify([this.#options.clientId, input.conversationId === undefined ? ['submission', input.submissionId] : ['conversation', input.conversationId]])}`;
  }
  #initSession(importId: string): string {
    if (!validId(importId)) throw new Error('INVALID_SUBMISSION_ID');
    return `mcp-init:${JSON.stringify([this.#options.clientId, importId])}`;
  }
  status(input: SubmissionIdentity): SubmissionOutcome | null {
    return this.#store().observationOutcome(this.#session(input), input.submissionId);
  }
  initStatus(importId: string): SubmissionOutcome | null {
    return this.#store().observationOutcome(this.#initSession(importId), importId);
  }
  submit(input: Submission, signal?: AbortSignal): { accepted: true; duplicate: boolean; state: string; contextId: string } {
    const sessionId = this.#session(input);
    if (!this.info().submissionEnabled) throw new Error('SUBMISSION_DISABLED');
    if (!this.contexts().includes(input.contextId)) throw new Error('CONTEXT_UNAVAILABLE');
    if (!input.text.trim() || Buffer.byteLength(input.text) > this.config.disclosure.maxTotalBytes) throw new Error('INVALID_TEXT_SIZE');
    if (signal?.aborted) throw new Error('CANCELLED');
    return this.#enqueue(sessionId, input.submissionId, input.contextId, input.text, 'mcp_user_submission', false);
  }
  /** Agent-reported understanding: durably queued as one agent_import observation and flushed promptly. */
  init(input: InitSubmission, signal?: AbortSignal): { accepted: true; duplicate: boolean; state: string; contextId: string } {
    const sessionId = this.#initSession(input.importId);
    if (!this.info().initEnabled) throw new Error('INIT_DISABLED');
    if (!this.contexts().includes(input.contextId)) throw new Error('CONTEXT_UNAVAILABLE');
    const text = encodeAgentImport({ sourceLabel: input.sourceLabel, basis: input.basis, understanding: input.understanding, gaps: input.gaps });
    if (Buffer.byteLength(text) > this.config.disclosure.maxTotalBytes) throw new Error('INVALID_TEXT_SIZE');
    if (signal?.aborted) throw new Error('CANCELLED');
    return this.#enqueue(sessionId, input.importId, input.contextId, text, AGENT_IMPORT_SOURCE, true);
  }
  read(contextId?: string): MemoryView {
    if (!this.info().readEnabled) throw new Error('READ_DISABLED');
    const contexts = this.contexts();
    if (contextId !== undefined && !contexts.includes(contextId)) throw new Error('CONTEXT_UNAVAILABLE');
    return readAuthorizedMemory({ dataRoot: this.config.dataRoot, contexts: contextId === undefined ? contexts : [contextId] });
  }
  #enqueue(sessionId: string, entryId: string, scope: string, text: string, source: string, flush: boolean) {
    const store = this.#store();
    return store.transaction(() => {
      const duplicate = store.observationStatus(sessionId, entryId) !== null;
      let observation;
      try { observation = store.enqueue({ sessionId, entryId, scope, text, source, observedAt: new Date().toISOString() }); }
      catch (error) {
        if (error instanceof Error && error.message === 'Conflicting observation identity') throw new Error('SUBMISSION_CONFLICT');
        throw error;
      }
      if (flush) store.requestFlush();
      return { accepted: true as const, duplicate, state: observation.state, contextId: observation.scope };
    });
  }
}
