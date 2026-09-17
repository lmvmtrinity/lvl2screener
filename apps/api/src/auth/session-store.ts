import { randomBytes } from "node:crypto";

/** W5: in-memory session store for the remote-access profile's single operator. There is only
 * ever one API process holding sessions (the worker never serves HTTP), so this doesn't need to
 * be durable or shared -- a restart simply signs the operator out, which is an acceptable and
 * obvious failure mode for a single-workstation tool. */
export interface SessionRecord {
  id: string;
  csrfToken: string;
  expiresAt: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(
    private readonly ttlMs: number = 12 * 60 * 60 * 1000,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  create(): SessionRecord {
    const record: SessionRecord = {
      id: randomBytes(32).toString("hex"),
      csrfToken: randomBytes(32).toString("hex"),
      expiresAt: this.clock() + this.ttlMs,
    };
    this.sessions.set(record.id, record);
    return record;
  }

  get(id: string): SessionRecord | undefined {
    const record = this.sessions.get(id);
    if (!record) return undefined;
    if (record.expiresAt <= this.clock()) {
      this.sessions.delete(id);
      return undefined;
    }
    return record;
  }

  destroy(id: string): void {
    this.sessions.delete(id);
  }

  get size(): number {
    return this.sessions.size;
  }
}
