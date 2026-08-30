import { join, resolve } from "node:path";
export class RepositoryLayout {
  readonly dataRoot: string;
  readonly repositoryRoot: string;
  readonly facts: string;
  readonly proposals: string;
  readonly reviews: string;
  readonly schema: string;
  readonly state: string;
  readonly transactions: string;
  readonly index: string;
  readonly indexDatabase: string;
  readonly lockDatabase: string;
  constructor(dataRoot: string) {
    this.dataRoot = resolve(dataRoot); this.repositoryRoot = join(this.dataRoot, "repository");
    this.facts = join(this.repositoryRoot, "memory", "facts"); this.proposals = join(this.repositoryRoot, "memory", "proposals"); this.reviews = join(this.repositoryRoot, "memory", "reviews"); this.schema = join(this.repositoryRoot, "schema");
    this.state = join(this.dataRoot, "state"); this.transactions = join(this.state, "transactions");
    this.index = join(this.dataRoot, "index"); this.indexDatabase = join(this.index, "memory.sqlite"); this.lockDatabase = join(this.state, "repository-lock.sqlite");
  }
  factPath(id: string): string { return join(this.facts, `${id}.yaml`); }
  proposalPath(id: string): string { return join(this.proposals, `${id}.yaml`); }
  reviewPath(id: string): string { return join(this.reviews, `${id}.yaml`); }
}
