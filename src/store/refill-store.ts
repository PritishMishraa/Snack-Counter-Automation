import { DomainError } from '../domain/errors.js';
import { ACTIVE_STATUSES, type OfficeId, type Refill, type RefillId } from '../domain/model.js';

export type InsertResult = { readonly inserted: true; readonly refill: Refill } | { readonly inserted: false; readonly existing: Refill };

/**
 * Persistence contract. A real implementation would be one SQL table with
 *  - a `version` column checked in `UPDATE ... WHERE id = ? AND version = ?`
 *  - a partial unique index on (office_id) WHERE status IN (active statuses)
 */
export interface RefillStore {
  get(id: RefillId): Promise<Refill | undefined>;
  list(): Promise<readonly Refill[]>;
  findActive(officeId: OfficeId): Promise<Refill | undefined>;
  /** Atomically inserts unless the office already has an active refill. */
  insertIfNoActive(refill: Refill): Promise<InsertResult>;
  /** Writes `next` only if the stored version still equals `expectedVersion`. */
  save(next: Refill, expectedVersion: number): Promise<Refill>;
}

/**
 * In-memory store. Every method yields to the event loop first, like a real database round-trip would,
 * so concurrent callers genuinely interleave and the version check is exercised by the tests.
 */
export class InMemoryRefillStore implements RefillStore {
  private readonly rows = new Map<RefillId, Refill>();

  async get(id: RefillId): Promise<Refill | undefined> {
    await tick();
    return this.rows.get(id);
  }

  async list(): Promise<readonly Refill[]> {
    await tick();
    return [...this.rows.values()];
  }

  async findActive(officeId: OfficeId): Promise<Refill | undefined> {
    await tick();
    return this.findActiveSync(officeId);
  }

  async insertIfNoActive(refill: Refill): Promise<InsertResult> {
    await tick();
    const existing = this.findActiveSync(refill.officeId);
    if (existing) return { inserted: false, existing };
    if (this.rows.has(refill.id)) throw new Error(`Duplicate refill id ${refill.id}`);
    this.rows.set(refill.id, refill);
    return { inserted: true, refill };
  }

  async save(next: Refill, expectedVersion: number): Promise<Refill> {
    await tick();
    const current = this.rows.get(next.id);
    if (!current) throw new DomainError('NOT_FOUND', `Refill ${next.id} not found`);
    if (current.version !== expectedVersion) {
      throw new DomainError('CONCURRENT_UPDATE', `Refill ${next.id} was changed by someone else`);
    }
    if (next.version !== expectedVersion + 1) throw new Error('Version must be incremented by exactly one');
    if (ACTIVE_STATUSES.has(next.status)) {
      const other = this.findActiveSync(next.officeId);
      if (other && other.id !== next.id) throw new DomainError('INVALID_STATE', `Office ${next.officeId} already has an active refill`);
    }
    this.rows.set(next.id, next);
    return next;
  }

  private findActiveSync(officeId: OfficeId): Refill | undefined {
    for (const r of this.rows.values()) {
      if (r.officeId === officeId && ACTIVE_STATUSES.has(r.status)) return r;
    }
    return undefined;
  }
}

function tick(): Promise<void> {
  // setImmediate is Node-only. In the browser a microtask still lets concurrent callers interleave,
  // without setTimeout's 4 ms clamping slowing the month-long simulation down.
  return new Promise((resolve) => (typeof setImmediate === 'function' ? setImmediate(resolve) : queueMicrotask(resolve)));
}
