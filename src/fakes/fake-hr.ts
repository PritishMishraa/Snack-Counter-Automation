import type { ClaimId } from '../domain/model.js';
import type { ClaimRequest, ClaimStatus, Clock, HrPort } from '../ports.js';

export interface StoredClaim {
  readonly id: ClaimId;
  readonly request: ClaimRequest;
  readonly createdAt: Date;
  status: ClaimStatus;
}

/**
 * Simulated third-party HR system. It validates input the way a strict external API would,
 * can be told to fail (to exercise retries), and lets tests or the demo approve/reject claims.
 */
export class FakeHr implements HrPort {
  readonly claims = new Map<ClaimId, StoredClaim>();
  private seq = 0;
  private failuresRemaining = 0;
  private statusFailuresRemaining = 0;

  constructor(private readonly clock: Clock) {}

  /** The next `n` createClaim calls throw, like an outage. */
  failNext(n: number): void {
    this.failuresRemaining = n;
  }

  async createClaim(request: ClaimRequest): Promise<ClaimId> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      throw new Error('HR system unavailable (simulated)');
    }
    if (!/^\d+\.\d{2}$/.test(request.amount) || Number(request.amount) <= 0) {
      throw new Error(`HR rejected malformed amount "${request.amount}"`);
    }
    if (!request.employeeId || !request.receiptImage || !request.description) {
      throw new Error('HR rejected claim with missing fields');
    }
    const id = `HR-${++this.seq}`;
    this.claims.set(id, { id, request, createdAt: this.clock.now(), status: { state: 'PENDING' } });
    return id;
  }

  /** The next `n` getClaimStatus calls throw. */
  failStatusNext(n: number): void {
    this.statusFailuresRemaining = n;
  }

  async getClaimStatus(claimId: ClaimId): Promise<ClaimStatus> {
    if (this.statusFailuresRemaining > 0) {
      this.statusFailuresRemaining--;
      throw new Error('HR status endpoint timed out (simulated)');
    }
    const c = this.claims.get(claimId);
    if (!c) throw new Error(`Unknown claim ${claimId}`);
    return c.status;
  }

  approve(claimId: ClaimId): void {
    this.decide(claimId, { state: 'APPROVED', decidedAt: this.clock.now() });
  }

  reject(claimId: ClaimId, reason: string): void {
    this.decide(claimId, { state: 'REJECTED', decidedAt: this.clock.now(), reason });
  }

  /** Approves every pending claim older than `ageMs`. Used by the demo to mimic HR's 1-10 day turnaround. */
  approveOlderThan(ageMs: number): void {
    const now = this.clock.now().getTime();
    for (const c of this.claims.values()) {
      if (c.status.state === 'PENDING' && now - c.createdAt.getTime() >= ageMs) this.approve(c.id);
    }
  }

  private decide(claimId: ClaimId, status: ClaimStatus): void {
    const c = this.claims.get(claimId);
    if (!c) throw new Error(`Unknown claim ${claimId}`);
    if (c.status.state !== 'PENDING') throw new Error(`Claim ${claimId} already decided`);
    c.status = status;
  }
}
