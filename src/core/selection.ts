import type { EmployeeId, Office, PresenceStatus, Refill, Volunteer } from '../domain/model.js';
import type { LocalDate } from '../domain/time.js';
import type { Policy } from './policy.js';

export interface Candidate {
  readonly employeeId: EmployeeId;
  /** 0 = confirmed in this office today, 1 = home office with unknown status. */
  readonly tier: 0 | 1;
  readonly recentRefills: number;
  readonly lastRefillAt: Date | undefined;
  readonly openClaims: number;
}

export interface SelectionInput {
  readonly office: Office;
  readonly today: LocalDate;
  readonly now: Date;
  readonly volunteers: readonly Volunteer[];
  readonly presenceOn: (employeeId: EmployeeId, date: LocalDate) => PresenceStatus | undefined;
  readonly refills: readonly Refill[];
  readonly exclude: ReadonlySet<EmployeeId>;
  readonly policy: Policy;
}

const OPEN_CLAIM_STATUSES = new Set(['NEEDS_APPROVAL', 'PURCHASED', 'CLAIM_SUBMITTED']);

/**
 * Ranks who should be asked to buy, best first.
 *
 * Eligibility: an active volunteer who is physically able to refill *this* counter today. That means
 * either they said they are in this office today (which includes visitors from the other office), or
 * this is their home office and they haven't said otherwise. Anyone on holiday, remote, or in the other
 * office is skipped, as is anyone already carrying too much unreimbursed money.
 *
 * Order: confirmed-present first, then fewest refills in the fairness window, then longest since their
 * last refill, then employee id so the result is deterministic.
 */
export function rankCandidates(input: SelectionInput): Candidate[] {
  const { office, today, now, policy } = input;
  const windowStart = now.getTime() - policy.fairnessWindowMs;
  const busy = new Set(
    input.refills.filter((r) => r.status === 'COMMITTED' && r.commitment).map((r) => r.commitment!.buyer),
  );

  const candidates: Candidate[] = [];
  for (const v of input.volunteers) {
    if (!v.active || input.exclude.has(v.employeeId) || busy.has(v.employeeId)) continue;

    const tier = presenceTier(input.presenceOn(v.employeeId, today), v, office);
    if (tier === undefined) continue;

    const bought = input.refills.filter((r) => r.purchase?.buyer === v.employeeId);
    const openClaims = bought.filter((r) => OPEN_CLAIM_STATUSES.has(r.status)).length;
    if (openClaims >= policy.maxOpenClaimsPerVolunteer) continue;

    const recent = bought.filter((r) => r.purchase!.purchasedAt.getTime() >= windowStart);
    const lastRefillAt = bought.reduce<Date | undefined>(
      (latest, r) => (!latest || r.purchase!.purchasedAt > latest ? r.purchase!.purchasedAt : latest),
      undefined,
    );
    candidates.push({ employeeId: v.employeeId, tier, recentRefills: recent.length, lastRefillAt, openClaims });
  }

  return candidates.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.recentRefills - b.recentRefills ||
      (a.lastRefillAt?.getTime() ?? 0) - (b.lastRefillAt?.getTime() ?? 0) ||
      a.employeeId.localeCompare(b.employeeId),
  );
}

function presenceTier(status: PresenceStatus | undefined, v: Volunteer, office: Office): 0 | 1 | undefined {
  if (status === undefined) return v.homeOfficeId === office.id ? 1 : undefined;
  if (status.kind === 'office') return status.officeId === office.id ? 0 : undefined;
  return undefined;
}
