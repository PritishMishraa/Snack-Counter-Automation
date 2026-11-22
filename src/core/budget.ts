import { SPENT_STATUSES, type Office, type Refill } from '../domain/model.js';
import { compare, min, subtract, sum, zero, type Money } from '../domain/money.js';
import type { Month } from '../domain/time.js';

export interface BudgetPosition {
  readonly month: Month;
  readonly budget: Money;
  /** Money spent or owed: receipts in review, being claimed, or reimbursed. */
  readonly spent: Money;
  /** Spend limits held by people who have committed but not bought yet. */
  readonly reserved: Money;
  /** budget - spent - reserved. May be negative if an admin approved an over-limit receipt. */
  readonly remaining: Money;
}

/**
 * Budgets are tracked per office in the office's own currency, so no exchange rate is needed to
 * decide whether a purchase fits. Currency conversion happens only in the management report.
 */
export function budgetPosition(office: Office, month: Month, refills: readonly Refill[]): BudgetPosition {
  const own = refills.filter((r) => r.officeId === office.id);
  const spent = sum(
    own.filter((r) => SPENT_STATUSES.has(r.status) && r.purchase?.budgetMonth === month).map((r) => r.purchase!.amount),
    office.currency,
  );
  const reserved = sum(
    own.filter((r) => r.status === 'COMMITTED' && r.commitment?.budgetMonth === month).map((r) => r.commitment!.spendLimit),
    office.currency,
  );
  const remaining = subtract(subtract(office.monthlyBudget, spent), reserved);
  return { month, budget: office.monthlyBudget, spent, reserved, remaining };
}

export type SpendDecision =
  | { readonly ok: true; readonly spendLimit: Money }
  | { readonly ok: false; readonly remaining: Money };

/**
 * How much the next buyer may spend: the office's single-purchase cap, or whatever is left this month
 * if that is smaller. If what's left is below a sensible minimum purchase, the refill waits instead.
 */
export function decideSpendLimit(office: Office, position: BudgetPosition): SpendDecision {
  const remaining = position.remaining.minor > 0 ? position.remaining : zero(office.currency);
  if (compare(remaining, office.minPurchase) < 0) return { ok: false, remaining };
  return { ok: true, spendLimit: min(office.maxPurchase, remaining) };
}
