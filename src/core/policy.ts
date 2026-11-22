import { DAY, HOUR } from '../domain/time.js';

/** Tunable rules. Defaults are meant to be tuned from the "hours empty" figure in the monthly report. */
export interface Policy {
  /** How long one person has to answer a direct offer. */
  readonly offerTimeoutMs: number;
  /** Direct offers to try before opening the refill to the whole office channel. */
  readonly maxDirectOffers: number;
  /** How long an open channel call stays up before it is re-posted and admins are told. */
  readonly broadcastTimeoutMs: number;
  /** Time a committed buyer has to report the purchase before the refill is handed on. */
  readonly commitWindowMs: number;
  /** How long before the deadline the buyer gets a reminder. */
  readonly reminderLeadMs: number;
  /** Volunteers with this many unreimbursed purchases are not asked to buy again. */
  readonly maxOpenClaimsPerVolunteer: number;
  /** Look-back period for "how many refills has this person done recently". */
  readonly fairnessWindowMs: number;
  /** HR promises 1-10 days; after this we chase. */
  readonly claimOverdueMs: number;
  /** Failed HR submissions before an admin is told (retries continue regardless). */
  readonly claimAttemptsBeforeEscalation: number;
}

export const DEFAULT_POLICY: Policy = {
  offerTimeoutMs: 2 * HOUR,
  maxDirectOffers: 3,
  broadcastTimeoutMs: 4 * HOUR,
  commitWindowMs: 24 * HOUR,
  reminderLeadMs: 6 * HOUR,
  maxOpenClaimsPerVolunteer: 2,
  fairnessWindowMs: 30 * DAY,
  claimOverdueMs: 10 * DAY,
  claimAttemptsBeforeEscalation: 3,
};
