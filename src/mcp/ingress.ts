import { isAbsolute } from 'node:path';
import type { CommonMemoryConfig } from '../config/config.js';
import { RuntimeStore } from '../v2/runtime.js';
import { ProjectRegistry } from '../v2/registry.js';

export interface McpOptions { clientId: string; workspaces: string[]; global: boolean; accept: boolean }
export interface SubmissionIdentity { submissionId: string; conversationId?: string | undefined }
export interface Submission extends SubmissionIdentity { contextId: string; text: string }
const validId = (id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id);

/** Local host trust is established at launch, never by a tool argument. */
export class McpIngress {
  readonly #registry: ProjectRegistry;
  readonly #projects: { workspace: string; contextId: string }[];
  readonly #options: McpOptions;
  constructor(readonly store: RuntimeStore, readonly config: CommonMemoryConfig, options: McpOptions) {
    if (!validId(options.clientId)) throw new Error('INVALID_CLIENT_ID');
    this.#options = { ...options, workspaces: [...options.workspaces] };
    this.#registry = new ProjectRegistry(config.dataRoot);
    this.#projects = options.workspaces.map(workspace => {
      if (!isAbsolute(workspace)) throw new Error('WORKSPACE_MUST_BE_ABSOLUTE');
      const project = this.#registry.resolve(workspace);
      if (!project) throw new Error('UNREGISTERED_WORKSPACE');
      return { workspace, contextId: `project:${project.id}` };
    });
  }
  contexts(): string[] {
    const projects = this.#projects.filter(item => {
      try { return `project:${this.#registry.resolve(item.workspace)?.id}` === item.contextId; }
      catch { return false; }
    }).map(item => item.contextId);
    return [...new Set([...(this.#options.global ? ['global'] : []), ...projects])]
      .filter(scope => this.config.disclosure.allowedScopes.includes(scope));
  }
  info(): { submissionEnabled: boolean; contexts: string[] } {
    const contexts = this.contexts();
    return { submissionEnabled: this.#options.accept && this.config.disclosure.allowedProvenance.includes('user_explicit') && contexts.length > 0, contexts };
  }
  #session(input: SubmissionIdentity): string {
    if (!validId(input.submissionId) || (input.conversationId !== undefined && !validId(input.conversationId))) throw new Error('INVALID_SUBMISSION_ID');
    return `mcp:${JSON.stringify([this.#options.clientId, input.conversationId === undefined ? ['submission', input.submissionId] : ['conversation', input.conversationId]])}`;
  }
  status(input: SubmissionIdentity): {state: string} | null {
    return this.store.observationStatus(this.#session(input), input.submissionId);
  }
  submit(input: Submission, signal?: AbortSignal): { accepted: true; duplicate: boolean; state: string; contextId: string } {
    const sessionId = this.#session(input);
    if (!this.info().submissionEnabled) throw new Error('SUBMISSION_DISABLED');
    if (!this.contexts().includes(input.contextId)) throw new Error('CONTEXT_UNAVAILABLE');
    if (!input.text.trim() || Buffer.byteLength(input.text) > this.config.disclosure.maxTotalBytes) throw new Error('INVALID_TEXT_SIZE');
    if (signal?.aborted) throw new Error('CANCELLED');
    return this.store.transaction(() => {
      const duplicate = this.store.observationStatus(sessionId, input.submissionId) !== null;
      let observation;
      try {
        observation = this.store.enqueue({ sessionId, entryId: input.submissionId, scope: input.contextId, text: input.text,
          source: 'mcp_user_submission', observedAt: new Date().toISOString() });
      } catch (error) {
        if (error instanceof Error && error.message === 'Conflicting observation identity') throw new Error('SUBMISSION_CONFLICT');
        throw error;
      }
      return { accepted: true, duplicate, state: observation.state, contextId: observation.scope };
    });
  }
}
