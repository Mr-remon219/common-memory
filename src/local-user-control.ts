import type { ApplyUndoInput, EditApproveInput, GovernanceInput, ProposeInput, UndoPreviewDto, UndoPreviewInput } from "./core/contracts/dto.js";
import { governanceAuthority, trustedContributor } from "./core/contracts/ports.js";
import type { CoreService } from "./core/service/core-service.js";

export interface LocalUserMemoryControlOptions { sessionId?: string | null }
const LOCAL_CONTROL_TOKEN = Symbol("LocalUserMemoryControl");
/** Explicit local-user control surface; it owns nominal capabilities without exposing their constructors. */
export class LocalUserMemoryControl {
  readonly #core: CoreService; readonly #contributor; readonly #authority;
  private constructor(core: CoreService, options: LocalUserMemoryControlOptions, token: symbol) { if (token !== LOCAL_CONTROL_TOKEN) throw new TypeError("Use createLocalUserMemoryControl"); this.#core = core; this.#contributor = trustedContributor("local_user", options.sessionId ?? null); this.#authority = governanceAuthority(); }
  static create(core: CoreService, options: LocalUserMemoryControlOptions = {}): LocalUserMemoryControl { return new LocalUserMemoryControl(core, options, LOCAL_CONTROL_TOKEN); }
  propose(input: ProposeInput) { return this.#core.propose(input, this.#contributor); }
  approve(input: GovernanceInput) { return this.#core.approve(input, this.#authority); }
  editApprove(input: EditApproveInput) { return this.#core.editApprove(input, this.#authority); }
  reject(input: GovernanceInput) { return this.#core.reject(input, this.#authority); }
  previewUndo(input: UndoPreviewInput | string[]) { return this.#core.previewUndo(Array.isArray(input) ? { review_ids: input } : input); }
  applyUndo(input: ApplyUndoInput | UndoPreviewDto) { return this.#core.applyUndo("preview" in input ? input : { preview: input }, this.#authority); }
}
export function createLocalUserMemoryControl(core: CoreService, options: LocalUserMemoryControlOptions = {}): LocalUserMemoryControl { return LocalUserMemoryControl.create(core, options); }
