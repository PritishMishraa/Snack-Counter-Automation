import type { Currency, Money } from './money.js';
import type { LocalDate, Month } from './time.js';

export type OfficeId = string;
export type EmployeeId = string;
export type RefillId = string;
export type ClaimId = string;

export interface Office {
  readonly id: OfficeId;
  readonly name: string;
  readonly currency: Currency;
  readonly timeZone: string;
  readonly monthlyBudget: Money;
  /** Largest single purchase the system will pre-approve. Bigger receipts go to an admin. */
  readonly maxPurchase: Money;
  /** If less than this is left in the month, a refill is put on hold instead of being assigned. */
  readonly minPurchase: Money;
  /** Chat channel where the office's volunteers hang out. */
  readonly channel: string;
  /** People who handle escalations (over-limit receipts, nobody available, rejected claims). */
  readonly admins: readonly EmployeeId[];
}

export interface Volunteer {
  readonly employeeId: EmployeeId;
  readonly name: string;
  readonly homeOfficeId: OfficeId;
  readonly active: boolean;
}

/**
 * Where a volunteer is on a given day. Volunteers set this in chat ("/snack here", "/snack holiday ...").
 * Absence of an entry means "unknown", which is not the same as "not available".
 */
export type PresenceStatus = { kind: 'office'; officeId: OfficeId } | { kind: 'remote' } | { kind: 'holiday' };

export interface PresenceEntry {
  readonly employeeId: EmployeeId;
  readonly date: LocalDate;
  readonly status: PresenceStatus;
}

export type RefillStatus =
  /** Reported empty, looking for someone to buy. */
  | 'AWAITING_VOLUNTEER'
  /** Not enough budget left this month; resumes automatically next month or when an admin overrides. */
  | 'ON_HOLD_BUDGET'
  /** Exactly one volunteer has committed to buy; budget is reserved. */
  | 'COMMITTED'
  /** Receipt is in but above the pre-approved limit; an admin must approve before claiming. */
  | 'NEEDS_APPROVAL'
  /** Receipt accepted; claim not yet accepted by HR (e.g. HR was down). Retried automatically. */
  | 'PURCHASED'
  /** Claim exists in HR, waiting for approval (1-10 days). */
  | 'CLAIM_SUBMITTED'
  | 'REIMBURSED'
  | 'CLAIM_REJECTED'
  | 'CANCELLED';

/** Statuses during which the box is still physically empty. Only one such refill may exist per office. */
export const ACTIVE_STATUSES: ReadonlySet<RefillStatus> = new Set(['AWAITING_VOLUNTEER', 'ON_HOLD_BUDGET', 'COMMITTED']);

/** Statuses whose purchase amount counts as money the company has spent or owes. */
export const SPENT_STATUSES: ReadonlySet<RefillStatus> = new Set([
  'NEEDS_APPROVAL',
  'PURCHASED',
  'CLAIM_SUBMITTED',
  'REIMBURSED',
]);

export interface Offer {
  /** null means the refill is open to anyone in the office channel. */
  readonly to: EmployeeId | null;
  readonly sentAt: Date;
  readonly expiresAt: Date;
}

export interface Commitment {
  readonly buyer: EmployeeId;
  readonly committedAt: Date;
  readonly dueAt: Date;
  /** The most the buyer may spend without admin approval. Reserved against the budget. */
  readonly spendLimit: Money;
  readonly budgetMonth: Month;
  readonly reminderSent: boolean;
}

export interface Purchase {
  readonly buyer: EmployeeId;
  readonly amount: Money;
  readonly receiptImage: string;
  readonly items: readonly string[];
  readonly purchasedAt: Date;
  readonly budgetMonth: Month;
}

export interface ClaimRef {
  readonly claimId: ClaimId;
  readonly submittedAt: Date;
  readonly decidedAt?: Date;
  readonly rejectionReason?: string;
  readonly overdueEscalated?: boolean;
}

export interface RefillEvent {
  readonly at: Date;
  readonly type: string;
  readonly by?: EmployeeId;
  readonly detail?: string;
}

export interface Refill {
  readonly id: RefillId;
  readonly officeId: OfficeId;
  readonly status: RefillStatus;
  /** Incremented on every write; used for optimistic concurrency control. */
  readonly version: number;
  readonly reportedBy: EmployeeId;
  readonly reportedAt: Date;
  readonly offer?: Offer;
  /** Number of one-to-one offers sent so far. */
  readonly directOffers: number;
  /** People who declined or let an offer/commitment lapse for this refill. They are not asked again. */
  readonly passedOver: readonly EmployeeId[];
  readonly commitment?: Commitment;
  /** Set when a commitment lapsed; that person may still report a purchase until someone else commits. */
  readonly lapsedBuyer?: EmployeeId;
  readonly purchase?: Purchase;
  readonly claim?: ClaimRef;
  readonly claimAttempts: number;
  readonly escalated: boolean;
  readonly history: readonly RefillEvent[];
}
